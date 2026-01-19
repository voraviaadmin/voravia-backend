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
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import Database from "better-sqlite3";

const app = express();
const port = process.env.PORT || 8787;

console.log("OPENAI KEY LOADED:", !!process.env.OPENAI_API_KEY);

//app.use(cors({ origin: true }));
//app.use(express.json({ limit: "2mb" }));


// ----------------------------------------------------------------------------
//  SECURITY + COMPLIANCE BASELINE MIDDLEWARE (MVP-SAFE)
// ----------------------------------------------------------------------------
// 1) Security headers (safe defaults; relax later if needed)
app.use(
    helmet({
      // Keep default protections; explicitly disable CSP for MVP since you serve API only.
      contentSecurityPolicy: false,
    })
  );
  
  // 2) CORS (leave permissive for dev; tighten in prod via env)
  const corsOrigin =
    process.env.CORS_ORIGIN && process.env.CORS_ORIGIN !== "*"
      ? process.env.CORS_ORIGIN.split(",").map((s) => s.trim())
      : true;
  app.use(cors({ origin: corsOrigin }));
  
  // 3) Body limit
  app.use(express.json({ limit: "2mb" }));
  
  // 4) Request ID + minimal audit log
  app.use((req, res, next) => {
    const rid =
      String(req.header("x-request-id") || "").trim() || crypto.randomUUID();
    req.requestId = rid;
    res.setHeader("x-request-id", rid);
  
    const start = Date.now();
    res.on("finish", () => {
      // Avoid logging sensitive bodies; log only metadata
      const ms = Date.now() - start;
      //const uid = String(req.header("x-user-id") || req.query.userId || "");
      const uid = String(req.ctx?.userId || req.header("x-user-id") || req.query.userId || "");

      console.log(
        JSON.stringify({
          t: new Date().toISOString(),
          rid,
          m: req.method,
          p: req.path,
          s: res.statusCode,
          ms,
          uid: uid || undefined,
        })
      );
    });
  
    next();
  });
  
  // 5) Rate limiting (cost guardrails)
  // Default: 120 req / minute per IP. Tighten for expensive endpoints below.
  app.use(
    rateLimit({
      windowMs: 60 * 1000,
      limit: Number(process.env.RATE_LIMIT_PER_MIN || 120),
      standardHeaders: "draft-7",
      legacyHeaders: false,
    })
  );
  
  // Per-route stricter limits for expensive endpoints (Google + OpenAI)
  const costlyLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: Number(process.env.COSTLY_RATE_LIMIT_PER_MIN || 30),
    standardHeaders: "draft-7",
    legacyHeaders: false,
  });






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

function computeOpenAICostUsdFromUsage({ model, usage }) {
  // Pricing: Standard rates per 1M tokens
  // Source: OpenAI pricing tables (gpt-4.1-mini) :contentReference[oaicite:2]{index=2}
  const RATES_PER_1M = {
    "gpt-4.1-mini": { input: 0.80, output: 3.20 },
    // If you later switch to dated model IDs, you can add:
    // "gpt-4.1-mini-2025-04-14": { input: 0.80, output: 3.20 },
  };

  const rates =
    RATES_PER_1M[model] ||
    (String(model).startsWith("gpt-4.1-mini") ? RATES_PER_1M["gpt-4.1-mini"] : null);

  if (!rates) return { costUsd: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 };

  const inputTokens = Number(usage?.input_tokens ?? usage?.inputTokens ?? 0) || 0;
  const outputTokens = Number(usage?.output_tokens ?? usage?.outputTokens ?? 0) || 0;
  const totalTokens =
    Number(usage?.total_tokens ?? usage?.totalTokens ?? (inputTokens + outputTokens)) || 0;

  const costUsd =
    (inputTokens * rates.input) / 1_000_000 + (outputTokens * rates.output) / 1_000_000;

  // round to 6 decimals so small values show up but stay stable
  const rounded = Math.round(costUsd * 1e6) / 1e6;

  return { costUsd: rounded, inputTokens, outputTokens, totalTokens };
}



function requireAdmin(req, res) {
  const token = String(req.header("x-admin-token") || "");
  if (!process.env.ADMIN_TOKEN || token !== process.env.ADMIN_TOKEN) {
    res.status(401).json({ error: "unauthorized" });
    return false;
  }
  return true;
}


// ============================================================================
//  USAGE EVENTS STORAGE (SQLite) - designed for easy Postgres migration
// ============================================================================



// Keep DB path configurable; default to local file
const USAGE_DB_PATH = process.env.USAGE_DB_PATH || "./data/usage.db";
const usageDb = new Database(USAGE_DB_PATH);

// Recommended pragmas for single-instance service
usageDb.pragma("journal_mode = WAL");
usageDb.pragma("synchronous = NORMAL");
usageDb.pragma("foreign_keys = ON");
usageDb.pragma("busy_timeout = 5000");

// Create table (portable schema: works in Postgres with minimal changes)
usageDb.exec(`
  CREATE TABLE IF NOT EXISTS usage_events (
    id TEXT PRIMARY KEY,
    ts TEXT NOT NULL,
    requestId TEXT,
    actorUserId TEXT,
    billingOwnerId TEXT,
    subjectUserId TEXT,  -- ✅ NEW
    mode TEXT,
    provider TEXT NOT NULL,
    service TEXT NOT NULL,
    units INTEGER NOT NULL,
    unitCostUsd REAL NOT NULL,
    costUsd REAL NOT NULL,
    metadataJson TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_usage_events_ts
    ON usage_events(ts);

  CREATE INDEX IF NOT EXISTS idx_usage_events_billingOwner_ts
    ON usage_events(billingOwnerId, ts);

  CREATE INDEX IF NOT EXISTS idx_usage_events_provider_service_ts
    ON usage_events(provider, service, ts);

  -- ✅ NEW: helps per-member views
  CREATE INDEX IF NOT EXISTS idx_usage_events_subject_ts
    ON usage_events(subjectUserId, ts);
`);


// ============================================================================
//  DAILY ROLLUPS (SQLite) - fast queries for dashboards
// ============================================================================

usageDb.exec(`
  CREATE TABLE IF NOT EXISTS daily_usage_rollups (
    day TEXT NOT NULL,              -- YYYY-MM-DD (UTC)
    billingOwnerId TEXT,
    actorUserId TEXT,
    subjectUserId TEXT,
    provider TEXT NOT NULL,
    service TEXT NOT NULL,

    events INTEGER NOT NULL,
    units INTEGER NOT NULL,
    costUsd REAL NOT NULL,

    PRIMARY KEY (day, billingOwnerId, actorUserId, subjectUserId, provider, service)
  );

  CREATE INDEX IF NOT EXISTS idx_rollups_day
    ON daily_usage_rollups(day);

  CREATE INDEX IF NOT EXISTS idx_rollups_owner_day
    ON daily_usage_rollups(billingOwnerId, day);

  CREATE INDEX IF NOT EXISTS idx_rollups_actor_day
    ON daily_usage_rollups(actorUserId, day);

  CREATE INDEX IF NOT EXISTS idx_rollups_subject_day
    ON daily_usage_rollups(subjectUserId, day);
`);

function isoDayUtc(d) {
  const dt = d instanceof Date ? d : new Date(d);
  return dt.toISOString().slice(0, 10); // YYYY-MM-DD in UTC
}

function dayRangeUtc(dayStr) {
  // dayStr: YYYY-MM-DD
  const start = new Date(`${dayStr}T00:00:00.000Z`);
  const end = new Date(`${dayStr}T00:00:00.000Z`);
  end.setUTCDate(end.getUTCDate() + 1);
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

const rollupSelectStmt = usageDb.prepare(`
  SELECT
    @day AS day,
    billingOwnerId,
    actorUserId,
    subjectUserId,
    provider,
    service,
    COUNT(*) AS events,
    SUM(units) AS units,
    SUM(costUsd) AS costUsd
  FROM usage_events
  WHERE ts >= @startIso AND ts < @endIso
  GROUP BY billingOwnerId, actorUserId, subjectUserId, provider, service
`);

const rollupUpsertStmt = usageDb.prepare(`
  INSERT OR REPLACE INTO daily_usage_rollups (
    day, billingOwnerId, actorUserId, subjectUserId, provider, service,
    events, units, costUsd
  ) VALUES (
    @day, @billingOwnerId, @actorUserId, @subjectUserId, @provider, @service,
    @events, @units, @costUsd
  )
`);

function runDailyRollup(dayStr) {
  const day = dayStr || isoDayUtc(new Date(Date.now() - 24 * 3600 * 1000)); // default: yesterday
  const { startIso, endIso } = dayRangeUtc(day);

  const rows = rollupSelectStmt.all({ day, startIso, endIso });

  const tx = usageDb.transaction((items) => {
    // Clear existing rollups for that day so reruns are correct
    usageDb.prepare(`DELETE FROM daily_usage_rollups WHERE day = ?`).run(day);

    for (const r of items) {
      rollupUpsertStmt.run({
        day: r.day,
        billingOwnerId: r.billingOwnerId || null,
        actorUserId: r.actorUserId || null,
        subjectUserId: r.subjectUserId || null,
        provider: r.provider,
        service: r.service,
        events: Number(r.events) || 0,
        units: Number(r.units) || 0,
        costUsd: Number(r.costUsd) || 0,
      });
    }
  });

  tx(rows);

  return { day, rows: rows.length };
}



const usageInsertStmt = usageDb.prepare(`
  INSERT INTO usage_events (
    id, ts, requestId, actorUserId, billingOwnerId, subjectUserId, mode,
    provider, service, units, unitCostUsd, costUsd, metadataJson
  ) VALUES (
    @id, @ts, @requestId, @actorUserId, @billingOwnerId, @subjectUserId, @mode,
    @provider, @service, @units, @unitCostUsd, @costUsd, @metadataJson
  )
`);


function makeUsageId() {
  return `ue_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

/**
 * UsageStore interface:
 * - insert(event)
 * - query({ billingOwnerId?, provider?, limit? })
 *
 * Keep this interface stable and Postgres migration is trivial.
 */
const usageStore = {
  insert(evt) {
    usageInsertStmt.run(evt);
    return evt;
  },

  query({ billingOwnerId, provider, limit = 200 } = {}) {
    const lim = Math.max(1, Math.min(Number(limit) || 200, 1000));

    // Build a small dynamic WHERE clause (portable SQL)
    const where = [];
    const params = { lim };

    if (billingOwnerId) {
      where.push("billingOwnerId = @billingOwnerId");
      params.billingOwnerId = String(billingOwnerId);
    }
    if (provider) {
      where.push("provider = @provider");
      params.provider = String(provider);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const rows = usageDb
      .prepare(
        `
        SELECT *
        FROM usage_events
        ${whereSql}
        ORDER BY ts DESC
        LIMIT @lim
      `
      )
      .all(params);
      

    // Parse metadata JSON on the way out
    return rows.map((r) => ({
      ...r,
      metadata: r.metadataJson ? JSON.parse(r.metadataJson) : {},
    }));
  },

  sumRange({ billingOwnerId, provider, startTs, endTs } = {}) {
    const where = ["billingOwnerId = @billingOwnerId", "ts >= @startTs", "ts < @endTs"];
    const params = {
      billingOwnerId: String(billingOwnerId),
      startTs: String(startTs),
      endTs: String(endTs),
    };

    if (provider && provider !== "all") {
      where.push("provider = @provider");
      params.provider = String(provider);
    }

    const row = usageDb
      .prepare(
        `
        SELECT COALESCE(SUM(costUsd), 0) AS c
        FROM usage_events
        WHERE ${where.join(" AND ")}
      `
      )
      .get(params);

    return Number(row?.c) || 0;
  },

  sumRangeBySubject({ billingOwnerId, provider, startTs, endTs } = {}) {
    const where = ["billingOwnerId = @billingOwnerId", "ts >= @startTs", "ts < @endTs"];
    const params = {
      billingOwnerId: String(billingOwnerId),
      startTs: String(startTs),
      endTs: String(endTs),
    };

    if (provider && provider !== "all") {
      where.push("provider = @provider");
      params.provider = String(provider);
    }

    return usageDb
      .prepare(
        `
        SELECT subjectUserId, COALESCE(SUM(costUsd), 0) AS costUsd
        FROM usage_events
        WHERE ${where.join(" AND ")}
        GROUP BY subjectUserId
        ORDER BY costUsd DESC
      `
      )
      .all(params)
      .map((r) => ({ subjectUserId: r.subjectUserId || "unknown", costUsd: Number(r.costUsd) || 0 }));
  },

  sumRangeByService({ billingOwnerId, provider, startTs, endTs } = {}) {
    const where = ["billingOwnerId = @billingOwnerId", "ts >= @startTs", "ts < @endTs"];
    const params = {
      billingOwnerId: String(billingOwnerId),
      startTs: String(startTs),
      endTs: String(endTs),
    };

    if (provider && provider !== "all") {
      where.push("provider = @provider");
      params.provider = String(provider);
    }

    return usageDb
      .prepare(
        `
        SELECT provider, service, COALESCE(SUM(costUsd), 0) AS costUsd, COALESCE(COUNT(1), 0) AS events
        FROM usage_events
        WHERE ${where.join(" AND ")}
        GROUP BY provider, service
        ORDER BY costUsd DESC
      `
      )
      .all(params)
      .map((r) => ({
        provider: String(r.provider || ""),
        service: String(r.service || ""),
        costUsd: Number(r.costUsd) || 0,
        events: Number(r.events) || 0,
      }));
  },


};



// ============================================================================
//  USAGE + COST LEDGER (MVP: in-memory)
//  - Tracks per-service cost for Google Places + OpenAI
//  - Later you can move this to a DB table without changing call sites
// ============================================================================

// Per-request USD costs (set via env). Start with 0 until you confirm pricing.
const PRICING = {
  google_places_searchNearby: Number(process.env.COST_GOOGLE_NEARBY_USD || 0),
  google_places_searchText: Number(process.env.COST_GOOGLE_TEXT_USD || 0),

  // Optional placeholders (you can switch to token-based later)
  openai_scan_vision: Number(process.env.COST_OPENAI_SCAN_USD || 0),
};

function safeNumber(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

function emitUsageEvent(req, evt) {
  const record = {
    id: makeUsageId(),
    ts: new Date().toISOString(),

    requestId: req?.requestId || null,
    actorUserId: req?.ctx?.userId || null,
    billingOwnerId: req?.ctx?.billingOwnerId || null,
    subjectUserId: evt?.subjectUserId ? String(evt.subjectUserId) : null,
    mode: req?.ctx?.me?.mode || null,

    provider: String(evt.provider),
    service: String(evt.service),
    units: Math.trunc(safeNumber(evt.units ?? 0)),
    unitCostUsd: safeNumber(evt.unitCostUsd ?? 0),
    costUsd: safeNumber(evt.costUsd ?? 0),
    metadataJson: JSON.stringify(evt.metadata || {}),
  };

  usageStore.insert(record);
  return { ...record, metadata: evt.metadata || {} };
}



// ---------------------------------------------------------------------------
//  Request Context (Identity + Scope) - minimal compliance risk
// ---------------------------------------------------------------------------
// We keep your MVP identity method (x-user-id / query userId) but centralize it.
// Later you can replace this with real auth without touching route handlers.
app.use((req, _res, next) => {
  req.ctx = req.ctx || {};
  req.ctx.userId = String(req.header("x-user-id") || req.query.userId || "u_head").trim();
  next();
});


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


// ---------- USAGE (MVP: read-only) ----------
app.get("/v1/usage", (req, res) => {
  const billingOwnerId = String(req.query.billingOwnerId || "").trim();
  const provider = String(req.query.provider || "").trim();
  const limit = Number(req.query.limit || 200);

  const items = usageStore.query({
    billingOwnerId: billingOwnerId || undefined,
    provider: provider || undefined,
    limit,
  });

  // Totals for convenience (last N returned)
  const totals = {};
  for (const e of items) {
    const k = `${e.provider}:${e.service}`;
    totals[k] = (totals[k] || 0) + safeNumber(e.costUsd);
  }

  res.json({
    count: items.length,
    lastN: items,
    totalsLastN: totals,
  });
});


app.get("/v1/usage/by-member", (req, res) => {
  const billingOwnerId = String(
    req.query.billingOwnerId || req.ctx?.billingOwnerId || "u_head"
  ).trim();
  
  const provider = String(req.query.provider || "").trim();

  const items = usageStore.query({
    billingOwnerId: billingOwnerId || undefined,
    provider: provider || undefined,
    limit: 1000,
  });

  const totalsBySubject = {};
  for (const e of items) {
    const k = e.subjectUserId || "unknown";
    totalsBySubject[k] = (totalsBySubject[k] || 0) + safeNumber(e.costUsd);
  }

  res.json({
    billingOwnerId: billingOwnerId || null,
    provider: provider || null,
    totalsBySubject,
  });
});


// ============================================================================
//  GROUP USAGE (user-facing)
//  GET /v1/group-usage?days=30&provider=all|google|openai
// ============================================================================
app.get("/v1/group-usage", (req, res) => {
  try {
    const me = req.ctx?.me || null;

    // Prefer ctx if present
    let billingOwnerId = String(req.ctx?.billingOwnerId || "").trim();
    
    // Fallbacks:
    // - Family: bill to head user (or family owner id if you store it)
    // - Individual: bill to self
    if (!billingOwnerId) {
      const mode = me?.mode || null;
    
      if (mode === "family") {
        // If your /v1/me returns family.headUserId, prefer that.
        billingOwnerId = String(me?.family?.headUserId || me?.family?.ownerUserId || "").trim();
      }
    
      if (!billingOwnerId) {
        // Individual (or unknown): bill to current user
        billingOwnerId = String(req.ctx?.userId || me?.id || "").trim();
      }
    }
    
    if (!billingOwnerId) {
      return res.status(400).json({ error: "missing_billing_owner" });
    }
    

    const days = Math.max(1, Math.min(Number(req.query.days) || 30, 365));
    const provider = String(req.query.provider || "all").trim().toLowerCase();

    const start = new Date();
    start.setUTCDate(start.getUTCDate() - days);
    const startDay = isoDayUtc(start);

    const providerSql = provider === "all" ? "" : " AND provider = @provider ";

    const totalCostUsd =
      usageDb.prepare(`
        SELECT COALESCE(SUM(costUsd), 0) AS c
        FROM daily_usage_rollups
        WHERE billingOwnerId = @billingOwnerId
          AND day >= @startDay
          ${providerSql}
      `).get({ billingOwnerId, startDay, provider })?.c ?? 0;

    const bySubjectRows = usageDb.prepare(`
      SELECT subjectUserId, COALESCE(SUM(costUsd), 0) AS costUsd
      FROM daily_usage_rollups
      WHERE billingOwnerId = @billingOwnerId
        AND day >= @startDay
        ${providerSql}
      GROUP BY subjectUserId
      ORDER BY costUsd DESC
    `).all({ billingOwnerId, startDay, provider });

    const bySubjectUserId = {};
    for (const r of bySubjectRows) {
      bySubjectUserId[r.subjectUserId || "unknown"] = Number(r.costUsd) || 0;
    }

    const byService = usageDb.prepare(`
      SELECT provider, service, COALESCE(SUM(costUsd), 0) AS costUsd, COALESCE(SUM(events), 0) AS events
      FROM daily_usage_rollups
      WHERE billingOwnerId = @billingOwnerId
        AND day >= @startDay
        ${providerSql}
      GROUP BY provider, service
      ORDER BY costUsd DESC
    `).all({ billingOwnerId, startDay, provider });

        // -----------------------------
    // Option 1: Add "today so far" live events (not yet in rollups)
    // -----------------------------
    const now = new Date();
    const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const todayStartTs = todayStart.toISOString();
    const nowTs = now.toISOString();

    const todaySoFarUsd = usageStore.sumRange({
      billingOwnerId,
      provider,
      startTs: todayStartTs,
      endTs: nowTs,
    });

    const todayBySubject = usageStore.sumRangeBySubject({
      billingOwnerId,
      provider,
      startTs: todayStartTs,
      endTs: nowTs,
    });

    const todayByService = usageStore.sumRangeByService({
      billingOwnerId,
      provider,
      startTs: todayStartTs,
      endTs: nowTs,
    });

    // Merge totals
    const mergedTotalCostUsd = (Number(totalCostUsd) || 0) + (Number(todaySoFarUsd) || 0);

    // Merge bySubjectUserId
    for (const r of todayBySubject) {
      const k = r.subjectUserId || "unknown";
      bySubjectUserId[k] = (Number(bySubjectUserId[k]) || 0) + (Number(r.costUsd) || 0);
    }

    // Merge byService
    const svcKey = (p, s) => `${p}::${s}`;
    const svcMap = new Map();
    for (const row of byService) {
      svcMap.set(svcKey(row.provider, row.service), {
        provider: row.provider,
        service: row.service,
        costUsd: Number(row.costUsd) || 0,
        events: Number(row.events) || 0,
      });
    }
    for (const row of todayByService) {
      const k = svcKey(row.provider, row.service);
      const prev = svcMap.get(k) || { provider: row.provider, service: row.service, costUsd: 0, events: 0 };
      prev.costUsd += Number(row.costUsd) || 0;
      prev.events += Number(row.events) || 0;
      svcMap.set(k, prev);
    }
    const mergedByService = Array.from(svcMap.values()).sort((a, b) => (b.costUsd || 0) - (a.costUsd || 0));


    res.json({
      mode: me?.mode ?? null,
      billingOwnerId,
      days,
      provider,
      totalCostUsd: Number(mergedTotalCostUsd) || 0,
      todaySoFarUsd: Number(todaySoFarUsd) || 0,
      todayStartTs,
      bySubjectUserId,
      byService: mergedByService,
    });
  } catch (err) {
    console.error("group-usage error:", err);
    res.status(500).json({ error: "group_usage_error" });
  }
});




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
  //const userId = getUserId(req);
  const userId = req?.ctx?.userId ? String(req.ctx.userId) : getUserId(req);

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



// Build /v1/me context once per request for downstream routes
app.use((req, _res, next) => {
  try {
    req.ctx = req.ctx || {};
    req.ctx.me = buildMe(req);

    // Billing owner: for now family rolls up to u_head; later replace with real owner id.
    req.ctx.billingOwnerId =
      req.ctx.me?.mode === "family" ? "u_head" : String(req.ctx.me?.userId || req.ctx.userId);
  } catch {
    req.ctx = req.ctx || {};
    req.ctx.me = null;
    req.ctx.billingOwnerId = req.ctx.userId;
  }
  next();
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
//app.post("/v1/scans", upload.single("image"), async (req, res) => {
  app.post("/v1/scans", costlyLimiter, upload.single("image"), async (req, res) => {

  //const memberId = String(req.query.memberId || "").trim() || "u_self";
  const memberId = String(getMemberIdForScan(req) || "u_self");



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
      if (cached) {
        // Cached call -> cost is effectively 0
        emitUsageEvent(req, {
          provider: "openai",
          service: "openai_scan_vision",
          subjectUserId: memberId,
          units: 0,
          unitCostUsd: 0,
          costUsd: 0,
          metadata: { cached: true, memberId },
        });
        return res.json({ ...cached, cached: true });
      }


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

    const model = "gpt-4.1-mini";

    // Compute real cost from returned usage tokens
    const { costUsd, inputTokens, outputTokens, totalTokens } =
      computeOpenAICostUsdFromUsage({ model, usage: response?.usage });
    
    emitUsageEvent(req, {
      provider: "openai",
      service: "openai_scan_vision",
      subjectUserId: memberId,
    
      // Keep "units" as 1 scan call, but now the unit cost is calculated
      units: 1,
      unitCostUsd: costUsd,
      costUsd,
    
      metadata: {
        cached: false,
        model,
        memberId,
        inputTokens,
        outputTokens,
        totalTokens,
      },
    });
    
    


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
// JV Removed code on 01/18 - Google search duplicacy

async function handlePlacesNearby(req, res) {
  try {


    if (req.method === "POST" && !req.is("application/json")) {
      return res.status(415).json({ error: "Expected application/json" });
    }

    // Support both GET query params and POST JSON body
    const lat = Number(req.query.lat ?? req.body?.lat);
    const lng = Number(req.query.lng ?? req.body?.lng);

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ error: "Invalid lat/lng" });
    }

    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "Missing GOOGLE_MAPS_API_KEY" });

    const radiusMeters = clampInt(req.query.radiusMeters ?? req.body?.radiusMeters ?? 2500, 100, 50000, 2500);
    const maxResultCount = clampInt(req.query.limit ?? req.body?.limit ?? 20, 1, 20, 20);

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

    // Meter it (only after success)
    emitUsageEvent(req, {
      provider: "google",
      service: "google_places_searchNearby",
      subjectUserId: req.ctx?.userId,     
      units: 1,
      unitCostUsd: PRICING.google_places_searchNearby,
      costUsd: PRICING.google_places_searchNearby,
      metadata: { radiusMeters, maxResultCount },
    });

    return res.json({ places: normalizePlaces(json) });
  } catch (err) {
    console.error("Places nearby error:", err);
    return res.status(500).json({ error: "places_error", message: err?.message });
  }
}

async function handlePlacesSearch(req, res) {
  
  try {
    
    if (req.method === "POST" && !req.is("application/json")) {
      return res.status(415).json({ error: "Expected application/json" });
    }

    // Support both GET query params and POST JSON body
    const lat = Number(req.query.lat ?? req.body?.lat);
    const lng = Number(req.query.lng ?? req.body?.lng);
    const q = String(req.query.q ?? req.body?.q ?? "").trim();

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ error: "Invalid lat/lng" });
    }
    if (!q) return res.status(400).json({ error: "Missing q (e.g., Indian, Mexican)" });

    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "Missing GOOGLE_MAPS_API_KEY" });

    const radiusMeters = clampInt(req.query.radiusMeters ?? req.body?.radiusMeters ?? 5000, 100, 50000, 5000);
    const maxResultCount = clampInt(req.query.limit ?? req.body?.limit ?? 20, 1, 20, 20);

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

    // Meter it (only after success)
    emitUsageEvent(req, {
      provider: "google",
      service: "google_places_searchText",
      subjectUserId: req.ctx?.userId,    
      units: 1,
      unitCostUsd: PRICING.google_places_searchText,
      costUsd: PRICING.google_places_searchText,
      metadata: { q, radiusMeters, maxResultCount },
    });

    return res.json({ places: normalizePlaces(json) });
  } catch (err) {
    console.error("Places search error:", err);
    return res.status(500).json({ error: "search_error", message: err?.message });
  }
}


app.get("/api/places/nearby", costlyLimiter, handlePlacesNearby);
app.post("/api/places/nearby", costlyLimiter, handlePlacesNearby);

app.get("/api/places/search", costlyLimiter, handlePlacesSearch);
app.post("/api/places/search", costlyLimiter, handlePlacesSearch);



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


// Run rollup for yesterday on startup (fast) and every hour (cheap)
try {
  const r = runDailyRollup(); // yesterday
  console.log("[rollup] computed:", r);
} catch (e) {
  console.warn("[rollup] startup rollup failed:", e?.message || e);
}

setInterval(() => {
  try {
    const r = runDailyRollup(); // yesterday
    console.log("[rollup] computed:", r);
  } catch (e) {
    console.warn("[rollup] scheduled rollup failed:", e?.message || e);
  }
}, 60 * 60 * 1000);






app.listen(port, () => {
  console.log(`✅ Voravia backend running on port ${port}`);
});



// ---------------------------------------------------------------------------
//  Central Error Handler (keep last)
// ---------------------------------------------------------------------------
// If you throw errors later (e.g. authz), they’ll land here consistently.
app.use((err, req, res, _next) => {
  const rid = req?.requestId;
  console.error("Unhandled error", { rid, message: err?.message, stack: err?.stack });

  const status = Number(err?.statusCode || err?.status || 500);
  const safeMsg = status >= 500 ? "internal_error" : (err?.message || "request_error");
  res.status(status).json({ error: safeMsg, requestId: rid });
});