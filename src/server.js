// src/server.js – Voravia backend (MVP)
// Adds: /v1/me (profile-aware family list), /v1/family (alias),
//       /v1/logs (in-memory), /v1/day-summary, /v1/scans (vision)
// Keeps: your existing /api/* routes (Places + Menu upload/rate)

import express from "express";
import cors from "cors";
import multer from "multer";
import OpenAI from "openai";
import "dotenv/config";

import crypto from "crypto";
import NodeCache from "node-cache";

const app = express();
const port = process.env.PORT || 8787;

console.log("OPENAI KEY LOADED:", !!process.env.OPENAI_API_KEY);

app.use(cors({ origin: true }));
app.use(express.json({ limit: "2mb" }));

// ---------- OpenAI Client ----------
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---------- Upload handling (in-memory) ----------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 }, // 12MB
});

// ---------- Cache ----------
const cache = new NodeCache({
  stdTTL: 60 * 60 * 24,
  checkperiod: 60 * 10,
  useClones: false,
});

// ---------- Helpers ----------
function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function stableJsonKey(obj) {
  const keys = Object.keys(obj || {}).sort();
  const out = {};
  for (const k of keys) out[k] = obj[k];
  return JSON.stringify(out);
}

function extractFirstJson(text) {
  if (!text) throw new Error("Empty model response");

  let t = String(text).trim();
  t = t.replace(/^```json\s*/i, "").replace(/^```\s*/i, "");
  t = t.replace(/\s*```$/i, "").trim();

  const firstBrace = t.indexOf("{");
  const lastBrace = t.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    throw new Error("No JSON object found in model response");
  }

  let sliced = t.slice(firstBrace, lastBrace + 1).trim();

  // remove unsafe control chars (keep common whitespace)
  sliced = sliced.replace(/[\u0000-\u001F\u007F]/g, (c) => {
    if (c === "\n" || c === "\r" || c === "\t") return c;
    return "";
  });

  try {
    return JSON.parse(sliced);
  } catch {
    const unescaped = sliced
      .replace(/\\+"/g, '"')
      .replace(/\\\\/g, "\\")
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t");
    return JSON.parse(unescaped);
  }
}

function isoDay(d = new Date()) {
  const dt = new Date(d);
  const yyyy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function clampScore(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(100, Math.round(x)));
}

// ============================================================================
//  PERSONALITY (MVP): per-member health preferences used for scoring
// ============================================================================
// Keep simple + safe: seeded in-memory defaults; can be edited later via PATCH /v1/me if desired.
const MEMBER_PREFERENCES = {
  u_head: {
    goals: ["balanced", "high_protein"],
    avoid: ["excess_sugar"],
    cuisines: ["indian", "mediterranean"],
    notes: "Prefers higher protein and balanced meals; limit sugary items.",
  },
  u_spouse: {
    goals: ["low_sodium", "balanced"],
    avoid: ["excess_sodium"],
    notes: "Watches sodium; prefers lighter meals.",
  },
  u_child1: {
    goals: ["balanced"],
    avoid: ["high_sugar"],
    notes: "Kid-friendly but avoid very sugary foods/drinks.",
  },
  u_child2: {
    goals: ["balanced"],
    avoid: ["high_sugar"],
    notes: "Kid-friendly but avoid very sugary foods/drinks.",
  },
  u_self: {
    goals: ["balanced"],
    avoid: [],
    notes: "Default preferences.",
  },
};

function getMemberIdForScan(req) {
  // 1) explicit query param
  const q = String(req.query.memberId || "").trim();
  if (q) return q;

  // 2) explicit form body field (optional)
  const b = String(req.body?.memberId || "").trim();
  if (b) return b;

  // 3) fallback to canonical /v1/me active member
  try {
    const me = buildMe(req);
    return String(me?.family?.activeMemberId || "u_self");
  } catch {
    return "u_self";
  }
}

function mergeProfile(userProfile, memberPrefs) {
  const a = userProfile && typeof userProfile === "object" ? userProfile : {};
  const b = memberPrefs && typeof memberPrefs === "object" ? memberPrefs : {};

  // Merge arrays by union
  const unionArr = (x, y) => {
    const ax = Array.isArray(x) ? x : [];
    const ay = Array.isArray(y) ? y : [];
    const seen = new Set();
    const out = [];
    for (const v of [...ay, ...ax]) {
      const s = String(v);
      if (!seen.has(s)) {
        seen.add(s);
        out.push(s);
      }
    }
    return out;
  };

  return {
    ...b, // member prefs first (baseline)
    ...a, // user supplied overrides
    goals: unionArr(a.goals, b.goals),
    avoid: unionArr(a.avoid, b.avoid),
  };
}



// ---------- HEALTH CHECK ----------
app.get("/health", (_, res) => res.json({ ok: true }));

// ============================================================================
//  MVP "ME" + FAMILY (profile-aware)
// ============================================================================
//
// Rules:
// - If activeProfile === "individual": family = [ {id:"u_self", name:"Me"} ]
// - If activeProfile === "family": family = [Head, Spouse, Child1, Child2] (no "Me")
//
// How we decide activeProfile (MVP):
// - query param ?profile=family|individual
// - OR header x-voravia-profile: family|individual
// - default: family (matches your current focus)
//
const FAMILY_MEMBERS = [
  { id: "u_head", name: "Head" },
  { id: "u_spouse", name: "Spouse" },
  { id: "u_child1", name: "Child 1" },
  { id: "u_child2", name: "Child 2" },
];

const ME_STATE = new Map(); // userId -> { mode, activeMemberId }

function getUserId(req) {
  return String(req.query.userId || req.header("x-user-id") || "u_head").trim();
}

function resolveMode(req) {
  // Optional explicit override (dev/testing)
  const q = String(req.query.profile || "").toLowerCase().trim();
  const h = String(req.header("x-voravia-profile") || "").toLowerCase().trim();
  const v = q || h;

  if (v === "individual" || v === "family" || v === "workplace") return v;
  return null; // no override
}


function ensureMeState(userId) {
  if (ME_STATE.has(userId)) return ME_STATE.get(userId);

  // Default MVP seed: family mode for u_head, individual for u_self
  const seeded =
    userId === "u_self"
      ? { mode: "individual", activeMemberId: "u_self" }
      : { mode: "family", activeMemberId: "u_head" };

  ME_STATE.set(userId, seeded);
  return seeded;
}


function buildMe(req) {
  const userId = getUserId(req);

  const state = ensureMeState(userId);
  const overrideMode = resolveMode(req);
  const mode = overrideMode || state.mode;

  // Build family members list (your existing constant)
  // Expecting FAMILY_MEMBERS like:
  // [{id:"u_head", name:"Head"}, {id:"u_spouse", name:"Spouse"}, ...]
  const members =
    mode === "family"
      ? (FAMILY_MEMBERS || []).map((m) => ({
          id: String(m.id),
          displayName: String(m.name || m.displayName || m.id),
        }))
      : [{ id: "u_self", displayName: "Me" }];

  // active member id
  const activeMemberId =
    mode === "family"
      ? String(state.activeMemberId || "u_head")
      : "u_self";

  // Persist effective mode back to state unless this was an override
  if (!overrideMode) {
    ME_STATE.set(userId, { ...state, mode });
  }

  return {
    userId,
    mode,
    family: {
      activeMemberId,
      members,
    },
    preferences: {
      byMemberId: MEMBER_PREFERENCES,
    },
  };
  
}

app.get("/v1/me", (req, res) => {
  res.json(buildMe(req));
});


// PATCH /v1/me
// Body examples:
// { "mode": "family" }
// { "family": { "activeMemberId": "u_spouse" } }
// { "mode": "individual", "family": { "activeMemberId": "u_self" } }

app.patch("/v1/me", (req, res) => {
  const userId = getUserId(req);

  // ensure state exists
  const state = ensureMeState(userId);

  const body = req.body || {};

  // update mode if provided
  if (body.mode === "individual" || body.mode === "family" || body.mode === "workplace") {
    state.mode = body.mode;
  }

  // update active member if provided
  if (body.family && body.family.activeMemberId !== undefined) {
    state.activeMemberId = String(body.family.activeMemberId || "").trim() || null;
  }

  ME_STATE.set(userId, state);

  // respond with canonical /v1/me shape
  res.json(buildMe(req));
});



app.get("/v1/family", (req, res) => {
  const me = buildMe(req);
  res.json({ items: me.family.members, activeMemberId: me.family.activeMemberId, userId: me.userId });
});


// ============================================================================
//  SIMPLE LOGS (in-memory, structured) + day-summary
// ============================================================================
const logs = []; // MVP keep in memory

app.get("/v1/logs", (req, res) => {
  const userId = String(req.query.userId || "").trim();

  const filtered = userId ? logs.filter((x) => x.userId === userId) : logs;
  // newest first
  res.json({ items: filtered.slice().reverse().slice(0, 200) });
});

app.post("/v1/logs", (req, res) => {
  const item = req.body || {};

  const entry = {
    id: `log_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    createdAt: new Date().toISOString(),
    day: item.day ? String(item.day) : isoDay(),
    userId: String(item.userId || "u_self"),
    mealType: String(item.mealType || "lunch"),
    source: String(item.source || "scan"),
    dishName: String(item.dishName || "Unknown dish"),
    score: clampScore(item.score),
    label: String(item.label || ""),
    confidence: Number(item.confidence ?? 0),
    why: Array.isArray(item.why) ? item.why.map(String) : [],
    tips: Array.isArray(item.tips) ? item.tips.map(String) : [],
    nutrition: item.nutrition || item.estimatedNutrition || null,
    photoUri: item.photoUri ? String(item.photoUri) : "",
    scanId: item.scanId ? String(item.scanId) : undefined,
  };

  logs.push(entry);
  res.json({ ok: true, item: entry });
});

// Meal weights for DAILY score (Phase 1)
const MEAL_WEIGHTS = {
  breakfast: 0.25,
  lunch: 0.30,
  dinner: 0.35,
  snack: 0.10,
};

function caloriesOf(log) {
  const n = log?.nutrition || {};
  const c = Number(n.caloriesKcal ?? n.calories ?? 0);
  return Number.isFinite(c) && c > 0 ? c : 0;
}

function weightedAvgScore(items) {
  // calories-weighted if we have calories; else simple average
  const withCals = items.filter((x) => caloriesOf(x) > 0);
  if (withCals.length) {
    let wSum = 0;
    let sSum = 0;
    for (const it of withCals) {
      const w = caloriesOf(it);
      wSum += w;
      sSum += w * clampScore(it.score);
    }
    return wSum > 0 ? sSum / wSum : 0;
  }

  if (!items.length) return 0;
  const sum = items.reduce((a, x) => a + clampScore(x.score), 0);
  return sum / items.length;
}

app.get("/v1/day-summary", (req, res) => {
  const userId = String(req.query.userId || "").trim() || "u_self";
  const day = String(req.query.day || "").trim() || isoDay();

  const dayLogs = logs.filter((x) => x.userId === userId && String(x.day) === day);

  const byMeal = {
    breakfast: dayLogs.filter((x) => x.mealType === "breakfast"),
    lunch: dayLogs.filter((x) => x.mealType === "lunch"),
    dinner: dayLogs.filter((x) => x.mealType === "dinner"),
    snack: dayLogs.filter((x) => x.mealType === "snack"),
  };

  // meal scores (multiple items per meal -> calories-weighted avg)
  const mealScore = {
    breakfast: weightedAvgScore(byMeal.breakfast),
    lunch: weightedAvgScore(byMeal.lunch),
    dinner: weightedAvgScore(byMeal.dinner),
    snack: weightedAvgScore(byMeal.snack),
  };

  // day score = weighted average across meals actually logged
  let totalW = 0;
  let totalS = 0;
  for (const mt of ["breakfast", "lunch", "dinner", "snack"]) {
    const list = byMeal[mt];
    if (!list.length) continue;
    const w = MEAL_WEIGHTS[mt] ?? 0;
    totalW += w;
    totalS += w * (mealScore[mt] ?? 0);
  }
  const dailyScore = totalW > 0 ? totalS / totalW : 0;

  // simple “next win” suggestion (Phase 1)
  const nextWin = [];
  if (!dayLogs.length) nextWin.push("Log one meal to start your day score");
  else if (dailyScore < 50) nextWin.push("Next meal: aim for protein + fiber (avoid sugary / fried)");
  else if (dailyScore < 70) nextWin.push("Next meal: add fiber (veggies/whole grains) and keep sodium moderate");
  else nextWin.push("Next meal: keep balance—protein + veggies, watch extra sodium");

  res.json({
    userId,
    day,
    dailyScore: Math.round(dailyScore),
    mealScore: {
      breakfast: Math.round(mealScore.breakfast || 0),
      lunch: Math.round(mealScore.lunch || 0),
      dinner: Math.round(mealScore.dinner || 0),
      snack: Math.round(mealScore.snack || 0),
    },
    nextWin,
  });
});


// ============================================================================
//  HOME RECOMMENDATIONS – /v1/home-recommendations
//  - Uses /v1/me + in-memory logs + MEMBER_PREFERENCES (personality)
//  - Returns next meal focus + 3 food suggestions
// ============================================================================
function normalizeGoalTokens(prefs) {
  const goals = Array.isArray(prefs?.goals) ? prefs.goals.map((x) => String(x).toLowerCase()) : [];
  const avoid = Array.isArray(prefs?.avoid) ? prefs.avoid.map((x) => String(x).toLowerCase()) : [];
  const cuisines = Array.isArray(prefs?.cuisines)
    ? prefs.cuisines.map((x) => String(x).toLowerCase())
    : [];
  return { goals, avoid, cuisines };
}

function sumNutrition(items) {
  const out = {
    caloriesKcal: 0,
    proteinG: 0,
    carbsG: 0,
    fatG: 0,
    fiberG: 0,
    sugarG: 0,
    sodiumMg: 0,
    hasAny: false,
  };

  for (const it of items || []) {
    const n = it?.nutrition || it?.estimatedNutrition || null;
    if (!n || typeof n !== "object") continue;

    const cals = Number(n.caloriesKcal ?? n.calories ?? 0);
    const protein = Number(n.proteinG ?? n.protein_g ?? n.protein ?? 0);
    const carbs = Number(n.carbsG ?? n.carbs_g ?? n.carbs ?? 0);
    const fat = Number(n.fatG ?? n.fat_g ?? n.fat ?? 0);
    const fiber = Number(n.fiberG ?? n.fiber_g ?? n.fiber ?? 0);
    const sugar = Number(n.sugarG ?? n.sugar_g ?? n.sugar ?? 0);
    const sodium = Number(n.sodiumMg ?? n.sodium_mg ?? n.sodium ?? 0);

    if (
      Number.isFinite(cals) ||
      Number.isFinite(protein) ||
      Number.isFinite(carbs) ||
      Number.isFinite(fat) ||
      Number.isFinite(fiber) ||
      Number.isFinite(sugar) ||
      Number.isFinite(sodium)
    ) {
      out.hasAny = true;
    }

    out.caloriesKcal += Number.isFinite(cals) ? cals : 0;
    out.proteinG += Number.isFinite(protein) ? protein : 0;
    out.carbsG += Number.isFinite(carbs) ? carbs : 0;
    out.fatG += Number.isFinite(fat) ? fat : 0;
    out.fiberG += Number.isFinite(fiber) ? fiber : 0;
    out.sugarG += Number.isFinite(sugar) ? sugar : 0;
    out.sodiumMg += Number.isFinite(sodium) ? sodium : 0;
  }

  // Round for readability
  out.caloriesKcal = Math.round(out.caloriesKcal);
  out.proteinG = Math.round(out.proteinG);
  out.carbsG = Math.round(out.carbsG);
  out.fatG = Math.round(out.fatG);
  out.fiberG = Math.round(out.fiberG);
  out.sugarG = Math.round(out.sugarG);
  out.sodiumMg = Math.round(out.sodiumMg);

  return out;
}

function pickRecentDishKeywords(dayLogs) {
  // Very light heuristic: use last 8 dish names as "signal"
  const recent = (dayLogs || []).slice(-8).map((x) => String(x?.dishName || "").toLowerCase());
  const joined = recent.join(" ");
  const hints = [];
  if (joined.includes("salad")) hints.push("salad");
  if (joined.includes("chicken")) hints.push("chicken");
  if (joined.includes("yogurt")) hints.push("yogurt");
  if (joined.includes("rice")) hints.push("rice");
  if (joined.includes("lentil")) hints.push("lentils");
  if (joined.includes("oat") || joined.includes("oatmeal")) hints.push("oats");
  return Array.from(new Set(hints)).slice(0, 4);
}

function buildFocus({ goals, avoid }, totals, dayScore, mealsLogged) {
  // Default
  let focus = "Keep balance—protein + veggies, watch extra sodium";
  let reason = mealsLogged
    ? "Based on today’s logged meals."
    : "Log a meal to start getting personalized suggestions.";

  if (!mealsLogged) {
    return { focus: "Log your next meal to personalize suggestions", reason };
  }

  // If we have nutrition, use it
  if (totals?.hasAny) {
    // Simple thresholds (MVP)
    const lowFiber = totals.fiberG < 15;
    const highSodium = totals.sodiumMg > 1800;
    const highSugar = totals.sugarG > 45;
    const lowProtein = totals.proteinG < 60;

    // Preference-aware prioritization
    if (goals.includes("low_sodium") || avoid.includes("excess_sodium")) {
      if (highSodium) {
        return {
          focus: "Keep sodium low · add potassium + fiber",
          reason: `Today’s sodium is ~${totals.sodiumMg}mg. Next meal: choose fresh foods, avoid salty sauces.`,
        };
      }
    }

    if (avoid.includes("excess_sugar") || avoid.includes("high_sugar")) {
      if (highSugar) {
        return {
          focus: "Reduce added sugar · increase protein/fiber",
          reason: `Today’s sugar is ~${totals.sugarG}g. Next meal: go protein + fiber to stabilize energy.`,
        };
      }
    }

    if (goals.includes("high_protein")) {
      if (lowProtein) {
        return {
          focus: "Add protein · keep carbs/fats balanced",
          reason: `Today’s protein is ~${totals.proteinG}g. Next meal: include lean protein + veggies.`,
        };
      }
    }

    if (goals.includes("high_fiber") || lowFiber) {
      if (lowFiber) {
        return {
          focus: "Add fiber · keep sodium moderate",
          reason: `Today’s fiber is ~${totals.fiberG}g. Next meal: vegetables/beans/whole grains.`,
        };
      }
    }
  }

  // Score-based fallback
  if (dayScore < 50) {
    focus = "Next meal: aim for protein + fiber (avoid sugary / fried)";
    reason = "Today’s average score is low—focus on a high-quality next meal.";
  } else if (dayScore < 70) {
    focus = "Next meal: add fiber (veggies/whole grains) and keep sodium moderate";
    reason = "A small quality upgrade on your next meal will boost your daily score.";
  } else {
    focus = "Next meal: keep the balance—protein + veggies, watch extra sodium";
    reason = "You’re doing well today—keep consistency.";
  }

  return { focus, reason };
}

function buildSuggestionPool({ goals, avoid, cuisines }, recentHints) {
  // Generic goal pools (safe MVP)
  const pools = {
    default: [
      { name: "Grilled chicken salad with olive oil + lemon", why: "High protein + fiber; minimal added sugar." },
      { name: "Greek yogurt with berries + chia", why: "Protein + fiber; supports steady energy." },
      { name: "Veggie omelette with whole grain toast", why: "Protein + micronutrients; balanced meal." },
      { name: "Lentil soup + side salad", why: "Fiber + plant protein; satisfying and heart-friendly." },
      { name: "Quinoa bowl with roasted veggies", why: "Fiber + complex carbs; easy to keep low sodium." },
    ],
    low_sodium: [
      { name: "Salmon + quinoa + steamed broccoli", why: "Naturally low sodium; high protein and omega-3s." },
      { name: "Chicken/Tofu stir-fry (no-salt sauce) + veggies", why: "High volume, low sodium if sauce is controlled." },
      { name: "Turkey/bean lettuce wraps", why: "Lower sodium than wraps/bread; high protein." },
      { name: "Greek salad + grilled protein", why: "Fresh ingredients; easy to control sodium." },
    ],
    high_protein: [
      { name: "Chicken shawarma bowl (light sauce)", why: "High protein; add veggies for fiber." },
      { name: "Cottage cheese + fruit + nuts", why: "Very high protein; nutrient-dense." },
      { name: "Tuna salad on whole grain", why: "High protein; add fiber via whole grain/veg." },
      { name: "Egg + veggie scramble", why: "Fast, high protein; flexible." },
    ],
    high_fiber: [
      { name: "Lentil/bean chili + side salad", why: "High fiber; helps fullness and gut health." },
      { name: "Overnight oats + berries + chia", why: "High fiber breakfast; low effort." },
      { name: "Quinoa + black beans + veggies bowl", why: "Fiber + protein; balanced." },
      { name: "Hummus + veggie plate + whole grain pita", why: "Fiber and healthy fats." },
    ],
    reduce_sugar: [
      { name: "Greek yogurt (unsweetened) + berries", why: "Lower sugar; high protein." },
      { name: "Eggs + avocado + veggies", why: "No added sugar; balanced fats/protein." },
      { name: "Chicken salad (no sweet dressing)", why: "Lower sugar; good protein/fiber." },
      { name: "Chia pudding (no added sugar)", why: "Fiber + healthy fats; sweeten naturally." },
    ],
  };

  // Cuisine “skins” (lightweight; no OpenAI needed)
  const cuisineAdds = {
    indian: [
      { name: "Dal (lentils) + brown rice + cucumber salad", why: "High fiber + protein; easy to keep sodium moderate." },
      { name: "Tandoori chicken + veggies", why: "High protein; avoid heavy creamy sauces." },
    ],
    mexican: [
      { name: "Chicken fajita bowl (no queso, light salsa)", why: "High protein; control sodium via salsa/seasoning." },
      { name: "Bean + veggie burrito bowl", why: "Fiber + protein; balanced carbs." },
    ],
    mediterranean: [
      { name: "Greek salad + grilled chicken", why: "Fiber + protein; heart-friendly fats." },
      { name: "Hummus bowl + veggies + quinoa", why: "Fiber + healthy fats; balanced." },
    ],
    chinese: [
      { name: "Steamed chicken + broccoli + rice (light sauce)", why: "Protein + veggies; keep sodium low by controlling sauce." },
      { name: "Tofu + mixed vegetables stir-fry", why: "Plant protein + fiber; flexible." },
    ],
    american: [
      { name: "Turkey burger lettuce wrap + side salad", why: "High protein; lower refined carbs." },
      { name: "Grilled chicken + roasted veggies", why: "Simple, high quality meal." },
    ],
  };

  // Determine primary pool from goals/avoid
  let base = pools.default;

  if (goals.includes("low_sodium") || avoid.includes("excess_sodium")) base = base.concat(pools.low_sodium);
  if (goals.includes("high_protein")) base = base.concat(pools.high_protein);
  if (goals.includes("high_fiber")) base = base.concat(pools.high_fiber);
  if (avoid.includes("excess_sugar") || avoid.includes("high_sugar")) base = base.concat(pools.reduce_sugar);

  // Add cuisine-specific suggestions
  for (const c of cuisines) {
    if (cuisineAdds[c]) base = cuisineAdds[c].concat(base);
  }

  // Small personalization from recent hints (very light)
  if (recentHints.includes("salad")) base = [{ name: "Big salad + lean protein + beans", why: "Leans into what you already eat; increases fiber/protein." }].concat(base);
  if (recentHints.includes("oats")) base = [{ name: "Overnight oats + chia + berries", why: "Matches your recent pattern; boosts fiber." }].concat(base);

  // Deduplicate by name, keep order
  const seen = new Set();
  const out = [];
  for (const it of base) {
    const key = String(it.name).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
    if (out.length >= 12) break;
  }
  return out;
}

app.get("/v1/home-recommendations", (req, res) => {
  const day = String(req.query.day || "").trim() || isoDay();

  // Use explicit memberId if provided; else use /v1/me active member; else u_self
  let memberId = String(req.query.memberId || "").trim();
  if (!memberId) {
    try {
      const me = buildMe(req);
      memberId = String(me?.family?.activeMemberId || me?.userId || "u_self");
    } catch {
      memberId = "u_self";
    }
  }

  const prefs = (typeof MEMBER_PREFERENCES === "object" && MEMBER_PREFERENCES[memberId]) || {};
  const { goals, avoid, cuisines } = normalizeGoalTokens(prefs);

  function buildThresholds(goals, avoid) {
    // defaults (per-day)
    let proteinMin = 60;
    let fiberMin = 20;
    let sugarMax = 45;
    let sodiumMax = 1800;
  
    // profile-aware tweaks
    if (goals.includes("high_protein")) proteinMin = 90;
    if (goals.includes("high_fiber")) fiberMin = 28;
  
    if (avoid.includes("excess_sugar") || avoid.includes("high_sugar")) sugarMax = 30;
    if (goals.includes("low_sodium") || avoid.includes("excess_sodium")) sodiumMax = 1500;
  
    return { proteinMin, fiberMin, sugarMax, sodiumMax };
  }
  
  const thresholds = buildThresholds(goals, avoid);
  


  const dayLogs = logs.filter((x) => x.userId === memberId && String(x.day) === day);
  const mealsLogged = dayLogs.length;

  // Avg score (simple average; you can swap to weightedAvgScore if desired)
  const avgScore =
    mealsLogged > 0
      ? Math.round(dayLogs.reduce((a, x) => a + clampScore(x.score), 0) / mealsLogged)
      : 0;

  const totals = sumNutrition(dayLogs);

  const nextMeal = buildFocus({ goals, avoid }, totals, avgScore, mealsLogged);

  const recentHints = pickRecentDishKeywords(dayLogs);
  const pool = buildSuggestionPool({ goals, avoid, cuisines }, recentHints);

  // pick top 3
  const suggestions = pool.slice(0, 3);

  res.json({
    memberId,
    day,
    todaySummary: {
      mealsLogged,
      avgScore,
      nutritionTotals: totals.hasAny ? totals : null,
    },
    nextMeal,
    suggestions,
    thresholds,
    debug: process.env.NODE_ENV !== "production"
      ? {
          goals,
          avoid,
          cuisines,
          recentHints,
        }
      : undefined,
  });
});




// ============================================================================
//  SCAN (vision) – /v1/scans
// ============================================================================
app.post("/v1/scans", upload.single("image"), async (req, res) => {

  const memberId = String(req.query.memberId || "").trim() || "u_self";
  const memberPrefs = (MEMBER_PREFERENCES && MEMBER_PREFERENCES[memberId]) || {};
  let profile = {};
  let effectiveProfile = {};

  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "MISSING_OPENAI_API_KEY" });
    }
    if (!req.file?.buffer) {
      return res.status(400).json({ error: "Missing image file (field: image)" });
    }

    const profileRaw = req.body?.profile;
    try {
      profile = profileRaw ? JSON.parse(profileRaw) : {};
    } catch {
      profile = {};
    }


    effectiveProfile =
    typeof mergeProfile === "function"
      ? mergeProfile(profile, memberPrefs)
      : { ...memberPrefs, ...profile };

    const imgB64 = req.file.buffer.toString("base64");
    const mime = String(req.file.mimetype || "image/jpeg");

    const cacheKey = `scan:${sha256(req.file.buffer)}:${memberId}:${sha256(
      Buffer.from(stableJsonKey(effectiveProfile))
    )}`;

    const cached = cache.get(cacheKey);
    if (cached) return res.json({ ...cached, cached: true });

    const instruction =
      `Return ONLY valid JSON (no markdown). Schema:\n` +
      `{\n` +
      `  "dishName": string,\n` +
      `  "confidence": number,     // 0-100\n` +
      `  "score": number,          // 0-100 overall health fit\n` +
      `  "why": string[],          // 2-6 bullets\n` +
      `  "tips": string[],         // 2-6 bullets\n` +
      `  "estimatedNutrition": {\n` +
      `    "caloriesKcal": number,\n` +
      `    "proteinG": number,\n` +
      `    "carbsG": number,\n` +
      `    "fatG": number,\n` +
      `    "fiberG": number,\n` +
      `    "sugarG": number,\n` +
      `    "sodiumMg": number\n` +
      `  }\n` +
      `}\n\n` +
      `Personalization (member-specific): ${JSON.stringify({
        memberId,
        ...effectiveProfile,
      })}\n`;


    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: instruction },
            {
              type: "input_image",
              image_url: `data:${mime};base64,${imgB64}`,
            },
          ],
        },
      ],
    });

    const modelText = response?.output?.[0]?.content?.[0]?.text ?? "{}";
    const parsed = extractFirstJson(modelText);

    const payload = {
      scanId: `scan_${Date.now()}_${Math.random().toString(16).slice(2)}`,
      dishName: String(parsed?.dishName || "Unknown dish"),
      confidence: clampScore(parsed?.confidence ?? 0),
      score: clampScore(parsed?.score ?? 0),
      why: Array.isArray(parsed?.why) ? parsed.why.map(String).slice(0, 6) : [],
      tips: Array.isArray(parsed?.tips) ? parsed.tips.map(String).slice(0, 6) : [],
      estimatedNutrition: {
        caloriesKcal: Number(parsed?.estimatedNutrition?.caloriesKcal ?? 0) || 0,
        proteinG: Number(parsed?.estimatedNutrition?.proteinG ?? 0) || 0,
        carbsG: Number(parsed?.estimatedNutrition?.carbsG ?? 0) || 0,
        fatG: Number(parsed?.estimatedNutrition?.fatG ?? 0) || 0,
        fiberG: Number(parsed?.estimatedNutrition?.fiberG ?? 0) || 0,
        sugarG: Number(parsed?.estimatedNutrition?.sugarG ?? 0) || 0,
        sodiumMg: Number(parsed?.estimatedNutrition?.sodiumMg ?? 0) || 0,
      },
      memberIdUsed: memberId,
      profileUsed: effectiveProfile,

      cached: false,
      source: "openai",
    };

    cache.set(cacheKey, payload);
    return res.json(payload);
  } catch (err) {
    console.error("scan error:", err);
    return res.status(500).json({ error: "scan_error", message: err?.message || String(err) });
  }
});

// ============================================================================
//  Your existing /api/* routes (Places + Menu) – unchanged from your file
// ============================================================================

function clampInt(val, min, max, fallback) {
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function normalizePlaces(json) {
  return (json.places ?? []).map((p) => ({
    id: p.id,
    displayName: p.displayName?.text ?? "Unknown",
    formattedAddress: p.formattedAddress ?? "",
    location: { lat: p.location?.latitude, lng: p.location?.longitude },
    rating: p.rating,
    userRatingCount: p.userRatingCount,
    types: p.types ?? [],
  }));
}

// ---------- GOOGLE PLACES ----------
app.get("/api/places/nearby", async (req, res) => {
  try {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ error: "Invalid lat/lng" });
    }

    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "Missing GOOGLE_MAPS_API_KEY" });

    const radiusMeters = clampInt(req.query.radiusMeters ?? 2500, 100, 50000, 2500);
    const maxResultCount = clampInt(req.query.limit ?? 20, 1, 20, 20);

    const url = "https://places.googleapis.com/v1/places:searchNearby";
    const body = {
      includedTypes: ["restaurant"],
      maxResultCount,
      locationRestriction: {
        circle: { center: { latitude: lat, longitude: lng }, radius: radiusMeters },
      },
    };

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask":
          "places.id,places.displayName,places.formattedAddress,places.location,places.rating,places.userRatingCount,places.types",
      },
      body: JSON.stringify(body),
    });

    const json = await resp.json();
    if (!resp.ok) {
      return res.status(resp.status).json({
        error: json?.error?.message || `Places API error: ${resp.status}`,
        details: json,
      });
    }

    res.json({ places: normalizePlaces(json) });
  } catch (err) {
    console.error("Places nearby error:", err);
    res.status(500).json({ error: "places_error", message: err?.message });
  }
});

app.get("/api/places/search", async (req, res) => {
  try {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    const q = String(req.query.q ?? "").trim();

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ error: "Invalid lat/lng" });
    }
    if (!q) return res.status(400).json({ error: "Missing q (e.g., Indian, Mexican)" });

    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "Missing GOOGLE_MAPS_API_KEY" });

    const radiusMeters = clampInt(req.query.radiusMeters ?? 5000, 100, 50000, 5000);
    const maxResultCount = clampInt(req.query.limit ?? 20, 1, 20, 20);

    const url = "https://places.googleapis.com/v1/places:searchText";
    const body = {
      textQuery: `${q} restaurant`,
      maxResultCount,
      locationBias: {
        circle: { center: { latitude: lat, longitude: lng }, radius: radiusMeters },
      },
    };

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask":
          "places.id,places.displayName,places.formattedAddress,places.location,places.rating,places.userRatingCount,places.types",
      },
      body: JSON.stringify(body),
    });

    const json = await resp.json();
    if (!resp.ok) {
      return res.status(resp.status).json({
        error: json?.error?.message || `Places API error: ${resp.status}`,
        details: json,
      });
    }

    res.json({ places: normalizePlaces(json) });
  } catch (err) {
    console.error("Places search error:", err);
    res.status(500).json({ error: "search_error", message: err?.message });
  }
});

// ---------- PDF text extraction (pdfjs-dist) ----------
async function extractTextFromPdfBuffer(buffer) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(buffer) });
  const pdf = await loadingTask.promise;

  let out = "";
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();
    const strings = content.items
      .map((it) => (it && it.str ? String(it.str) : ""))
      .filter(Boolean);
    out += `\n\n--- PAGE ${pageNum} ---\n${strings.join(" ")}`;
  }
  return out.trim();
}

function makeUploadKey(files) {
  const parts = [];
  for (const f of files) {
    const b = Buffer.isBuffer(f.buffer) ? f.buffer : Buffer.from([]);
    const head = b.subarray(0, Math.min(b.length, 1024 * 1024));
    parts.push(`${f.mimetype || ""}:${b.length}:${sha256(head)}`);
  }
  return sha256(Buffer.from(parts.join("|")));
}

function makeRateKey({ uploadKey, items, profile }) {
  const itemsKey = sha256(Buffer.from((items || []).join("\n")));
  const profileKey = sha256(Buffer.from(stableJsonKey(profile || {})));
  return `rate:${uploadKey || "noUpload"}:${itemsKey}:${profileKey}`;
}

// ---------- MENU EXTRACT UPLOAD ----------
app.post("/api/menu/extract-upload", upload.array("files", 6), async (req, res) => {
  res.set("X-Voravia-Menu", "upload-v2");

  try {
    if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: "MISSING_OPENAI_API_KEY" });

    const files = req.files || [];
    if (!Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ error: "No files uploaded. Use field name: files" });
    }

    const uploadKey = makeUploadKey(files);

    const cached = cache.get(`extract:${uploadKey}`);
    if (cached) return res.json({ ...cached, cached: true, uploadKey });

    let pdfText = "";
    const imageInputs = [];

    for (const f of files) {
      const mimetype = String(f.mimetype || "");
      if (mimetype === "application/pdf") {
        const text = await extractTextFromPdfBuffer(f.buffer);
        pdfText += `\n\n--- PDF TEXT START ---\n${text}\n--- PDF TEXT END ---\n`;
      } else if (mimetype.startsWith("image/")) {
        const b64 = f.buffer.toString("base64");
        imageInputs.push({
          type: "input_image",
          image_url: `data:${mimetype};base64,${b64}`,
        });
      }
    }

    if (!pdfText && imageInputs.length === 0) {
      return res.status(400).json({ error: "Unsupported file types. Upload images or a PDF." });
    }

    const instruction =
      `Return ONLY valid JSON (no markdown). Schema:\n` +
      `{"sections":[{"name":string,"items":[{"name":string,"description":string|null,"price":string|null}]}]}\n` +
      `Rules:\n` +
      `- keep section names\n` +
      `- dedupe items by name\n` +
      `- price/desc null if missing\n` +
      `- LIMIT output to max 12 sections and max 25 items per section\n` +
      `- DO NOT include rawText or any extra fields\n`;

    const userContent = [
      { type: "input_text", text: instruction + (pdfText ? `\n\nPDF:\n${pdfText}\n` : "") },
      ...imageInputs,
    ];

    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: [{ role: "user", content: userContent }],
    });

    const modelText = response?.output?.[0]?.content?.[0]?.text ?? "{}";

    let parsedJson;
    try {
      parsedJson = extractFirstJson(modelText);
    } catch (e) {
      return res.status(500).json({
        error: "menu_upload_parse_error",
        message: "Model did not return valid JSON.",
        raw: String(modelText).slice(0, 1200),
      });
    }

    const sections = Array.isArray(parsedJson.sections) ? parsedJson.sections : [];

    const seen = new Set();
    const cleanSections = sections
      .map((sec) => {
        const name = String(sec?.name ?? "Menu").trim() || "Menu";
        const items = Array.isArray(sec?.items) ? sec.items : [];
        const cleanItems = items
          .map((it) => ({
            name: String(it?.name ?? "").trim(),
            description:
              it?.description === null || it?.description === undefined ? null : String(it.description).trim() || null,
            price: it?.price === null || it?.price === undefined ? null : String(it.price).trim() || null,
          }))
          .filter((it) => it.name.length >= 2)
          .filter((it) => {
            const k = it.name.toLowerCase();
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
          });

        return { name, items: cleanItems };
      })
      .filter((s) => s.items.length > 0);

    const payload = { source: "upload", sections: cleanSections };

    cache.set(`extract:${uploadKey}`, payload);

    return res.json({ ...payload, cached: false, uploadKey });
  } catch (err) {
    console.error("extract-upload error:", err);
    return res.status(500).json({ error: "extract_upload_error", message: err?.message || String(err) });
  }
});

// ---------- MENU RATE ----------
app.post("/api/menu/rate", async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: "Missing OPENAI_API_KEY" });

    const itemsRaw = req.body?.items;
    const profile = req.body?.profile ?? {};
    const uploadKey = String(req.body?.uploadKey ?? "").trim() || "noUpload";

    if (!Array.isArray(itemsRaw) || itemsRaw.length === 0) {
      return res.status(400).json({ error: "items must be a non-empty array of strings" });
    }

    const items = itemsRaw
      .map((s) => String(s ?? "").trim())
      .filter(Boolean)
      .slice(0, 120);

    const flags = {
      diabetes: !!profile.diabetes,
      htn: !!profile.htn,
      nafld: !!profile.nafld,
      goal: profile.goal === "Lose" || profile.goal === "Maintain" || profile.goal === "Gain" ? profile.goal : "Maintain",
    };

    const rateKey = makeRateKey({ uploadKey, items, profile: flags });
    const cached = cache.get(rateKey);
    if (cached) return res.json({ ...cached, cached: true });

    const chunk = (arr, size) => {
      const out = [];
      for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
      return out;
    };

    const batches = chunk(items, 35);
    const allEstimated = [];

    for (const batch of batches) {
      const prompt = {
        role: "user",
        content: [
          {
            type: "input_text",
            text:
              `Return ONLY JSON (no markdown). Shape:\n` +
              `{"items":[{"input":string,"name":string,"calories":number,"carbsG":number,"proteinG":number,"fatG":number,"fiberG":number,"sugarG":number,"sodiumMg":number,"satFatG":number,"confidence":number,"assumptions":string}]}\n\n` +
              `Menu items:\n` +
              batch.map((x, i) => `${i + 1}. ${x}`).join("\n"),
          },
        ],
      };

      const response = await openai.responses.create({
        model: "gpt-4.1-mini",
        input: [prompt],
      });

      const text = response?.output?.[0]?.content?.[0]?.text ?? "{}";

      let parsed;
      try {
        parsed = extractFirstJson(text);
      } catch (e) {
        return res.status(500).json({
          error: "ai_parse_error",
          message: "Model did not return valid JSON. Try again or reduce items.",
          raw: String(text).slice(0, 1200),
        });
      }

      const est = Array.isArray(parsed?.items) ? parsed.items : [];
      allEstimated.push(...est);
    }

    const rated = items.map((input, idx) => {
      const e = allEstimated.find((x) => String(x?.input ?? "").trim() === input) || allEstimated[idx] || {};
      const calories = Number(e.calories ?? 0);
      const sodium = Number(e.sodiumMg ?? 0);
      const sugar = Number(e.sugarG ?? 0);
      const fiber = Number(e.fiberG ?? 0);
      const carbs = Number(e.carbsG ?? 0);

      let score = 80;
      const reasons = [];

      if (flags.goal === "Lose" && calories > 950) {
        score -= 15;
        reasons.push("High calories for weight loss");
      }
      if (flags.htn && sodium > 1200) {
        score -= 20;
        reasons.push("Very high sodium (HTN)");
      }
      if (flags.diabetes && carbs - fiber > 55) {
        score -= 18;
        reasons.push("High net carbs (diabetes)");
      }
      if (flags.nafld && sugar > 20) {
        score -= 15;
        reasons.push("High sugar (NAFLD)");
      }
      if (fiber >= 6) {
        score += 4;
        reasons.push("Good fiber");
      }

      score = clampScore(score);
      const verdict = score >= 80 ? "FIT" : score >= 60 ? "MODERATE" : "AVOID";

      return {
        input,
        name: String(e.name ?? input),
        nutrition: e,
        score,
        verdict,
        reasons,
      };
    });

    rated.sort((a, b) => b.score - a.score);

    const payload = {
      profileUsed: flags,
      uploadKey,
      count: rated.length,
      ratedItems: rated,
      cached: false,
    };

    cache.set(rateKey, payload);

    return res.json(payload);
  } catch (err) {
    console.error("menu rate error:", err);
    res.status(500).json({ error: "menu_rate_error", message: err?.message });
  }
});

app.listen(port, () => {
  console.log(`✅ Voravia backend running on port ${port}`);
});
