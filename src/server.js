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
    mode, // ✅ canonical
    family: {
      activeMemberId,
      members,
    },
  };
}

app.get("/v1/me", (req, res) => {
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
//  SCAN (vision) – /v1/scans
// ============================================================================
app.post("/v1/scans", upload.single("image"), async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "MISSING_OPENAI_API_KEY" });
    }
    if (!req.file?.buffer) {
      return res.status(400).json({ error: "Missing image file (field: image)" });
    }

    const profileRaw = req.body?.profile;
    let profile = {};
    try {
      profile = profileRaw ? JSON.parse(profileRaw) : {};
    } catch {
      profile = {};
    }

    const imgB64 = req.file.buffer.toString("base64");
    const mime = String(req.file.mimetype || "image/jpeg");

    const cacheKey = `scan:${sha256(req.file.buffer)}:${sha256(Buffer.from(stableJsonKey(profile)))}`;
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
      `Personalization (may be empty): ${JSON.stringify(profile)}\n`;

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
      profileUsed: profile,
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
