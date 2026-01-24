// src/server.js – Voravia backend (MVP)
// Adds: /v1/me (profile-aware family list), /v1/family (alias),
//       /v1/logs (SQLite), /v1/day-summary, /v1/scans (vision)
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
import { requireAdminSession, handleAdminLogin } from "./adminAuth.mjs";
import fs from "fs";
import path from "path";



const app = express();
const port = process.env.PORT || 8787;

console.log("OPENAI KEY LOADED:", !!process.env.OPENAI_API_KEY);

//app.use(cors({ origin: true }));
//app.use(express.json({ limit: "2mb" }));


// ----------------------------------------------------------------------------
//  SECURITY + COMPLIANCE BASELINE MIDDLEWARE (MVP-SAFE)
// ----------------------------------------------------------------------------

// Uploads Directory - Create the uploads directory if it doesn't exist. Serve uploaded files. Upload endpoint (base64 JSON).//

const uploadsDir = path.join(process.cwd(), "uploads");
fs.mkdirSync(uploadsDir, { recursive: true });

// Serve uploaded files
app.use("/uploads", express.static(uploadsDir));

// Upload endpoint (base64 JSON)
app.post("/v1/uploads", express.json({ limit: "20mb" }), (req, res) => {
  try {
    const { base64, ext = "jpg" } = req.body || {};
    if (!base64) return res.status(400).json({ error: "missing base64" });

    const safeExt = String(ext).toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";
    const id = crypto.randomUUID();
    const filename = `${id}.${safeExt}`;
    const filePath = path.join(uploadsDir, filename);

    fs.writeFileSync(filePath, Buffer.from(base64, "base64"));
    return res.json({ url: `/uploads/${filename}` });
  } catch (e) {
    return res.status(500).json({ error: "upload failed", details: String(e?.message || e) });
  }
});





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

  // Admin auth
app.post("/admin/auth/login", handleAdminLogin);


// Protect /admin/metrics/*
app.use(
  "/admin/metrics",
  requireAdminSession({ allowDevHeaderToken: true }) // set false in prod
);

  
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


function getSubjectUserId(req, ctx) {
  const h = req.headers || {};
  const headerSub = String(h["x-subject-user-id"] || "").trim();
  if (headerSub) return headerSub;

  const qSub = String(req.query?.subjectUserId || "").trim();
  if (qSub) return qSub;

  const bSub = String(req.body?.subjectUserId || "").trim();
  if (bSub) return bSub;

  // fallback = caller user
  return String(ctx?.me?.userId || ctx?.userId || h["x-user-id"] || "").trim();
}


function canDeleteLog(me, logRow) {
  if (!logRow) return false;

  // Family mode: allow deleting any log belonging to a family member id
  if (me?.mode === "family") {
    const allowed = new Set((me.family?.members || []).map((m) => String(m.id)));
    return allowed.has(String(logRow.userId));
  }

  // Individual/workplace: only allow deleting active member’s logs
  const activeId = String(me?.family?.activeMemberId || me?.userId || "u_self");
  return String(logRow.userId) === activeId;
}





// ============================================================================
//  ADMIN METRICS (app owner)
//  - Protected by x-admin-token === process.env.ADMIN_TOKEN
// ============================================================================


// 1) login route
app.post("/admin/auth/login", handleAdminLogin);

// 2) protect admin metrics
// If your admin routes are mounted under /admin already, wrap them:
// Example:
app.use(
  "/admin/metrics",
  requireAdminSession({ allowDevHeaderToken: true }) // set false later in prod
);

app.get("/admin/metrics/summary", (req, res) => {
  try {
    const days = Math.max(1, Math.min(Number(req.query.days) || 30, 365));
    const provider = String(req.query.provider || "all").trim().toLowerCase();

    const start = new Date();
    start.setUTCDate(start.getUTCDate() - (days - 1));
    const startDay = isoDayUtc(start);

    const providerSql = provider === "all" ? "" : " AND provider = @provider ";

    // Rollup totals (historical days)
    const totalRollupUsd =
      usageDb
        .prepare(
          `
          SELECT COALESCE(SUM(costUsd), 0) AS c
          FROM daily_usage_rollups
          WHERE day >= @startDay
          ${providerSql}
        `
        )
        .get({ startDay, provider })?.c ?? 0;

    // By-service breakdown from rollups
    const byService = usageDb
      .prepare(
        `
        SELECT provider, service,
               COALESCE(SUM(costUsd), 0) AS costUsd,
               COALESCE(SUM(events), 0) AS events
        FROM daily_usage_rollups
        WHERE day >= @startDay
        ${providerSql}
        GROUP BY provider, service
        ORDER BY costUsd DESC
      `
      )
      .all({ startDay, provider })
      .map((r) => ({
        provider: String(r.provider || ""),
        service: String(r.service || ""),
        costUsd: Number(r.costUsd || 0),
        events: Number(r.events || 0),
      }));

    // Today so far (live events)
    const now = new Date();
    const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const todayStartTs = todayStart.toISOString();
    const nowTs = now.toISOString();

    // cost (today events)
    const todaySoFarUsd = usageDb
      .prepare(
        `
        SELECT COALESCE(SUM(costUsd), 0) AS c
        FROM usage_events
        WHERE ts >= @startTs AND ts < @endTs
        ${provider === "all" ? "" : " AND provider = @provider "}
      `
      )
      .get({ startTs: todayStartTs, endTs: nowTs, provider })?.c ?? 0;

    // total events (rollups + today)
    const totalEventsRollup =
      usageDb
        .prepare(
          `
          SELECT COALESCE(SUM(events), 0) AS n
          FROM daily_usage_rollups
          WHERE day >= @startDay
          ${providerSql}
        `
        )
        .get({ startDay, provider })?.n ?? 0;

    const todaySoFarEvents =
      usageDb
        .prepare(
          `
          SELECT COUNT(*) AS n
          FROM usage_events
          WHERE ts >= @startTs AND ts < @endTs
          ${provider === "all" ? "" : " AND provider = @provider "}
        `
        )
        .get({ startTs: todayStartTs, endTs: nowTs, provider })?.n ?? 0;

    const totalUsd = Number(totalRollupUsd || 0) + Number(todaySoFarUsd || 0);

    res.json({
      windowDays: days,
      provider,
      startDay,
      today: isoDayUtc(now),
      todayStartTs: Date.parse(todayStartTs),
      totalRollupUsd: Number(totalRollupUsd || 0),
      todaySoFarUsd: Number(todaySoFarUsd || 0),
      totalUsd: Number(totalUsd || 0),
      totalEvents: Number(totalEventsRollup || 0) + Number(todaySoFarEvents || 0),
      byService,
    });
  } catch (e) {
    console.error("summary error:", e);
    res.status(500).json({ error: "Failed to compute summary" });
  }
});



app.get("/admin/metrics/cost-per-user", (req, res) => {
  const days = Math.max(1, Math.min(Number(req.query.days) || 30, 365));
  const provider = String(req.query.provider || "all").trim().toLowerCase();

  const start = new Date();
  start.setUTCDate(start.getUTCDate() - (days - 1));
  const startDay = isoDayUtc(start);

  const providerSql = provider === "all" ? "" : " AND provider = @provider ";

  try {
    // Rollup totals
    const row = usageDb
      .prepare(
        `
        SELECT COALESCE(SUM(costUsd), 0) AS totalUsd
        FROM daily_usage_rollups
        WHERE day >= @startDay
        ${providerSql}
        `
      )
      .get({ startDay, provider });

    const totalRollupUsd = Number(row?.totalUsd || 0);

    // Rollup active users (distinct subjectUserId)
    const au = usageDb
      .prepare(
        `
        SELECT COUNT(DISTINCT subjectUserId) AS activeUsers
        FROM daily_usage_rollups
        WHERE day >= @startDay
          AND subjectUserId IS NOT NULL
          AND subjectUserId <> ''
        ${providerSql}
        `
      )
      .get({ startDay, provider });

    const activeUsersRollup = Number(au?.activeUsers || 0);

    // Today so far (live events)
    const now = new Date();
    const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const todayStartIso = todayStart.toISOString();
    const nowIso = now.toISOString();

    const todaySoFarUsd = usageStore.sumRange({
      billingOwnerId: "", // ignored by the DB query below; keep interface stable
      provider,
      startTs: todayStartIso,
      endTs: nowIso,
    });

    // Today active users (distinct subjectUserId)
    const todayAU = usageDb
      .prepare(
        `
        SELECT COUNT(DISTINCT subjectUserId) AS activeUsers
        FROM usage_events
        WHERE ts >= @startTs AND ts < @endTs
          AND subjectUserId IS NOT NULL
          AND subjectUserId <> ''
        ${provider === "all" ? "" : " AND provider = @provider "}
        `
      )
      .get({
        startTs: todayStartIso,
        endTs: nowIso,
        provider,
      });

    const activeUsersToday = Number(todayAU?.activeUsers || 0);

    const totalUsd = totalRollupUsd + Number(todaySoFarUsd || 0);

    // If the same user appears in rollups AND today, count distinct overall:
    // simplest correct approach: compute distinct across (rollups in range) UNION (today events)
    const distinctOverall = usageDb
      .prepare(
        `
        SELECT COUNT(DISTINCT subjectUserId) AS activeUsers
        FROM (
          SELECT subjectUserId
          FROM daily_usage_rollups
          WHERE day >= @startDay
            AND subjectUserId IS NOT NULL AND subjectUserId <> ''
            ${providerSql}
          UNION
          SELECT subjectUserId
          FROM usage_events
          WHERE ts >= @todayStart AND ts < @nowTs
            AND subjectUserId IS NOT NULL AND subjectUserId <> ''
            ${provider === "all" ? "" : " AND provider = @provider "}
        )
        `
      )
      .get({
        startDay,
        provider,
        todayStart: todayStartIso,
        nowTs: nowIso,
      });

    const activeUsers = Number(distinctOverall?.activeUsers || (activeUsersRollup + activeUsersToday) || 0);

    const costPerActiveUserUsd = activeUsers > 0 ? totalUsd / activeUsers : 0;

    res.json({
      windowDays: days,
      provider,
      totalUsd: Number(totalUsd || 0),
      activeUsers,
      costPerActiveUserUsd: Number(costPerActiveUserUsd || 0),
      note: "activeUsers computed from distinct subjectUserId in rollups + today events.",
    });
  } catch (e) {
    console.error("❌ cost-per-user error:", e);
    res.status(500).json({ error: "Failed to compute cost-per-user" });
  }
});



app.get("/admin/metrics/by-day", (req, res) => {
  const days = Math.max(1, Math.min(Number(req.query.days) || 30, 365));
  const provider = String(req.query.provider || "all");

  const start = new Date();
  start.setUTCDate(start.getUTCDate() - (days - 1));
  const startDay = start.toISOString().slice(0, 10);

  try {
    const rows = usageDb
      .prepare(
        `
        SELECT
          day,
          COALESCE(SUM(costUsd), 0) AS costUsd,
          COALESCE(SUM(events), 0) AS events
        FROM daily_usage_rollups
        WHERE day >= ?
          AND (? = 'all' OR provider = ?)
        GROUP BY day
        ORDER BY day ASC
        `
      )
      .all(startDay, provider, provider);

    res.json({
      windowDays: days,
      provider,
      series: (rows || []).map((r) => ({
        day: r.day,
        costUsd: Number(r.costUsd || 0),
        events: Number(r.events || 0),
        activeUsers: 0,
      })),
    });
  } catch (e) {
    console.error("❌ by-day error:", e);
    res.status(500).json({ error: "Failed to compute by-day series" });
  }
});



app.get("/admin/metrics/events", (req, res) => {
  if (!requireAdmin(req, res)) return;

  const limit = Math.max(1, Math.min(Number(req.query.limit) || 200, 2000));
  const provider = String(req.query.provider || "").trim().toLowerCase();
  const billingOwnerId = String(req.query.billingOwnerId || "").trim();

  const where = [];
  const params = { lim: limit };

  if (billingOwnerId) {
    where.push("billingOwnerId = @billingOwnerId");
    params.billingOwnerId = billingOwnerId;
  }
  if (provider) {
    where.push("provider = @provider");
    params.provider = provider;
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const rows = usageDb.prepare(`
    SELECT *
    FROM usage_events
    ${whereSql}
    ORDER BY ts DESC
    LIMIT @lim
  `).all(params);

  res.json({
    count: rows.length,
    items: rows.map(r => ({ ...r, metadata: r.metadataJson ? JSON.parse(r.metadataJson) : {} })),
  });
});

app.get("/admin/metrics/top-billing-owners", (req, res) => {
  const days = Math.max(1, Math.min(Number(req.query.days) || 30, 365));
  const provider = String(req.query.provider || "all").trim().toLowerCase();
  const limit = Math.max(1, Math.min(Number(req.query.limit) || 20, 200));

  const start = new Date();
  start.setUTCDate(start.getUTCDate() - (days - 1));
  const startDay = isoDayUtc(start);

  const providerSql = provider === "all" ? "" : " AND provider = @provider ";

  // Optional: friendly labels for known demo IDs
  const BILLING_LABELS = {
    u_head: "Head",
    u_self: "Me",
    u_spouse: "Spouse",
    u_child1: "Child 1",
    u_child2: "Child 2",
  };

  try {
    const rows = usageDb
      .prepare(
        `
        SELECT
          billingOwnerId,
          COALESCE(SUM(costUsd), 0) AS totalUsd,
          COALESCE(SUM(events), 0) AS events,
          COUNT(DISTINCT subjectUserId) AS activeUsers
        FROM daily_usage_rollups
        WHERE day >= @startDay
          AND billingOwnerId IS NOT NULL
          AND billingOwnerId <> ''
          ${providerSql}
        GROUP BY billingOwnerId
        ORDER BY totalUsd DESC
        LIMIT @limit
        `
      )
      .all({ startDay, provider, limit });

    res.json({
      windowDays: days,
      provider,
      items: (rows || []).map((r) => {
        const billingOwnerId = String(r.billingOwnerId || "");
        return {
          billingOwnerId,
          label: BILLING_LABELS[billingOwnerId] || billingOwnerId,
          totalUsd: Number(r.totalUsd || 0),
          events: Number(r.events || 0),
          activeUsers: Number(r.activeUsers || 0),
        };
      }),
    });
  } catch (e) {
    console.error("❌ top-billing-owners error:", e);
    res.status(500).json({ error: "Failed to compute top-billing-owners" });
  }
});


app.get("/admin/metrics/users", (req, res) => {
  const days = Math.max(1, Math.min(Number(req.query.days) || 30, 365));

  try {
    const now = new Date();
    const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const todayIso = todayStart.toISOString();

    const start = new Date();
    start.setUTCDate(start.getUTCDate() - (days - 1));
    const startIso = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate())).toISOString();

    // Total distinct “users” we’ve ever seen (subjectUserId)
    const totalUsersRow = usageDb.prepare(`
      SELECT COUNT(DISTINCT subjectUserId) AS c
      FROM usage_events
      WHERE subjectUserId IS NOT NULL AND subjectUserId <> ''
    `).get();

    // Total distinct billing owners we’ve ever seen (families/accounts)
    const totalFamiliesRow = usageDb.prepare(`
      SELECT COUNT(DISTINCT billingOwnerId) AS c
      FROM usage_events
      WHERE billingOwnerId IS NOT NULL AND billingOwnerId <> ''
    `).get();

    // DAU (today)
    const dauRow = usageDb.prepare(`
      SELECT COUNT(DISTINCT subjectUserId) AS c
      FROM usage_events
      WHERE ts >= @start
        AND subjectUserId IS NOT NULL AND subjectUserId <> ''
    `).get({ start: todayIso });

    // WAU (last 7d)
    const wauStart = new Date(todayStart);
    wauStart.setUTCDate(wauStart.getUTCDate() - 6);
    const wauIso = wauStart.toISOString();

    const wauRow = usageDb.prepare(`
      SELECT COUNT(DISTINCT subjectUserId) AS c
      FROM usage_events
      WHERE ts >= @start
        AND subjectUserId IS NOT NULL AND subjectUserId <> ''
    `).get({ start: wauIso });

    // MAU (last 30d)
    const mauStart = new Date(todayStart);
    mauStart.setUTCDate(mauStart.getUTCDate() - 29);
    const mauIso = mauStart.toISOString();

    const mauRow = usageDb.prepare(`
      SELECT COUNT(DISTINCT subjectUserId) AS c
      FROM usage_events
      WHERE ts >= @start
        AND subjectUserId IS NOT NULL AND subjectUserId <> ''
    `).get({ start: mauIso });

    // Active-by-day series (from rollups, last N days)
    const startDay = isoDayUtc(new Date(startIso));
    const rows = usageDb.prepare(`
      SELECT day, COUNT(DISTINCT subjectUserId) AS activeUsers
      FROM daily_usage_rollups
      WHERE day >= @startDay
        AND subjectUserId IS NOT NULL AND subjectUserId <> ''
      GROUP BY day
      ORDER BY day ASC
    `).all({ startDay });

    res.json({
      totalUsers: Number(totalUsersRow?.c || 0),
      totalFamilies: Number(totalFamiliesRow?.c || 0),
      dau: Number(dauRow?.c || 0),
      wau: Number(wauRow?.c || 0),
      mau: Number(mauRow?.c || 0),
      activeByDay: (rows || []).map((r) => ({
        day: r.day,
        activeUsers: Number(r.activeUsers || 0),
      })),
      note: "Derived from usage_events.subjectUserId and daily_usage_rollups.subjectUserId.",
      windowDays: days,
      windowStartIso: startIso,
    });
  } catch (e) {
    console.error("❌ users metrics error:", e);
    res.status(500).json({ error: "Failed to compute users metrics" });
  }
});



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



// ---- one-time safe migrations (sqlite) ----
function ensureUsageSchema() {
  try {
    usageDb.prepare(`ALTER TABLE usage_events ADD COLUMN subjectUserId TEXT`).run();
  } catch (e) {
    // ignore "duplicate column name" etc
  }

  // Helpful indexes for DAU/WAU/MAU queries
  try {
    usageDb.prepare(`CREATE INDEX IF NOT EXISTS idx_usage_events_ts ON usage_events(ts)`).run();
    usageDb.prepare(
      `CREATE INDEX IF NOT EXISTS idx_usage_events_subject_ts ON usage_events(subjectUserId, ts)`
    ).run();
    usageDb.prepare(
      `CREATE INDEX IF NOT EXISTS idx_usage_events_owner_ts ON usage_events(billingOwnerId, ts)`
    ).run();
  } catch (e) {}
}

ensureUsageSchema();

function ensureRollupSchema() {
  try {
    usageDb.prepare(`ALTER TABLE daily_usage_rollups ADD COLUMN subjectUserId TEXT`).run();
  } catch (e) {}
  try {
    usageDb.prepare(
      `CREATE INDEX IF NOT EXISTS idx_rollups_day_subject ON daily_usage_rollups(day, subjectUserId)`
    ).run();
  } catch (e) {}
}
ensureRollupSchema();


// ============================================================================
//  FAMILY MEMBERS (SQLite) - source of truth for names + roles
// ============================================================================

usageDb.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    familyId TEXT
  );

  CREATE TABLE IF NOT EXISTS families (
    id TEXT PRIMARY KEY,
    name TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS family_members (
    id TEXT PRIMARY KEY,
    familyId TEXT NOT NULL,
    name TEXT NOT NULL,
    memberType TEXT NOT NULL, -- 'individual' | 'parent' | 'child'
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL,
    insuranceId TEXT,
    corporateId TEXT
  );




  CREATE INDEX IF NOT EXISTS idx_family_members_familyId
    ON family_members(familyId);
`);

const userUpsertStmt = usageDb.prepare(`
  INSERT INTO users(id, familyId)
  VALUES (@id, @familyId)
  ON CONFLICT(id) DO UPDATE SET familyId = excluded.familyId
`);

const userGetStmt = usageDb.prepare(`SELECT id, familyId FROM users WHERE id = ?`);

const familyInsertStmt = usageDb.prepare(`
  INSERT INTO families(id, name, createdAt, updatedAt)
  VALUES (@id, @name, @createdAt, @updatedAt)
`);

const familyGetStmt = usageDb.prepare(`SELECT id, name FROM families WHERE id = ?`);
const familyDeleteStmt = usageDb.prepare(`DELETE FROM families WHERE id = ?`);

const membersListStmt = usageDb.prepare(`
  SELECT id, familyId, name, memberType, insuranceId, corporateId, createdAt, updatedAt
  FROM family_members
  WHERE familyId = ?
  ORDER BY createdAt ASC
`);


const memberGetStmt = usageDb.prepare(`
  SELECT id, familyId, name, memberType, insuranceId, corporateId, createdAt, updatedAt
  FROM family_members
  WHERE id = ?
`);


const memberInsertStmt = usageDb.prepare(`
  INSERT INTO family_members(id, familyId, name, memberType, createdAt, updatedAt)
  VALUES (@id, @familyId, @name, @memberType, @createdAt, @updatedAt)
`);

const memberUpdateStmt = usageDb.prepare(`
  UPDATE family_members
  SET name = COALESCE(@name, name),
      memberType = COALESCE(@memberType, memberType),
      insuranceId = COALESCE(@insuranceId, insuranceId),
      corporateId = COALESCE(@corporateId, corporateId),
      updatedAt = @updatedAt
  WHERE id = @id
`);


const memberDeleteStmt = usageDb.prepare(`DELETE FROM family_members WHERE id = ?`);

const memberCountStmt = usageDb.prepare(`
  SELECT COUNT(*) AS cnt
  FROM family_members
  WHERE familyId = ?
`);

function nowIso() {
  return new Date().toISOString();
}

function makeFamilyId() {
  return `fam_${Date.now().toString(36)}_${Math.random().toString(16).slice(2)}`;
}

function makeMemberId() {
  return `mem_${Date.now().toString(36)}_${Math.random().toString(16).slice(2)}`;
}

function normalizeMemberType(x) {
  const v = String(x || "").toLowerCase().trim();
  if (v === "parent" || v === "child" || v === "individual") return v;
  return "parent";
}

function ensureUserRow(userId) {
  const existing = userGetStmt.get(userId);
  if (existing) return existing;
  userUpsertStmt.run({ id: userId, familyId: null });
  return userGetStmt.get(userId);
}



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
// ============================================================================
//  MVP "ME" + FAMILY (DB-backed source of truth)
// ============================================================================

const ME_STATE = new Map(); // userId -> { mode, activeMemberId }

function getUserId(req) {
  return String(req.query.userId || req.header("x-user-id") || "u_head").trim();
}

function resolveMode(req) {
  const q = String(req.query.profile || "").toLowerCase().trim();
  const h = String(req.header("x-voravia-profile") || "").toLowerCase().trim();
  const v = q || h;
  if (v === "individual" || v === "family" || v === "workplace") return v;
  return null;
}

function ensureMeState(userId) {
  if (ME_STATE.has(userId)) return ME_STATE.get(userId);
  const seeded = { mode: "individual", activeMemberId: userId };
  ME_STATE.set(userId, seeded);
  return seeded;
}

function listFamilyMembersForUser(userId) {
  const userRow = ensureUserRow(userId);
  const familyId = String(userRow?.familyId || "");
  if (!familyId) return { familyId: "", members: [] };

  const fam = familyGetStmt.get(familyId);
  const members = membersListStmt.all(familyId).map((m) => ({
    id: String(m.id),
    displayName: String(m.name || m.id),
    memberType: String(m.memberType || "parent"),
  }));

  return { familyId, familyName: fam?.name || "Your Family", members };
}

function buildMe(req) {
  const userId = req?.ctx?.userId ? String(req.ctx.userId) : getUserId(req);

  const state = ensureMeState(userId);
  const overrideMode = resolveMode(req);

  const { familyId, familyName, members } = listFamilyMembersForUser(userId);

  // mode is derived from whether a family exists (unless overridden for dev)
  let mode = overrideMode || (familyId ? "family" : "individual");

  // Members list:
  // - family: DB members
  // - individual: single derived member (the user)
  const effectiveMembers =
    mode === "family"
      ? members
      : [{ id: userId, displayName: "Me", memberType: "individual" }];

  // Active member:
  // - family: state.activeMemberId if in list, else first
  // - individual: always the userId
  let activeMemberId = userId;
  if (mode === "family") {
    const set = new Set(effectiveMembers.map((m) => m.id));
    const preferred = String(state.activeMemberId || "");
    activeMemberId = set.has(preferred) ? preferred : (effectiveMembers[0]?.id || userId);
  }

  // persist (unless override)
  if (!overrideMode) {
    ME_STATE.set(userId, { ...state, mode, activeMemberId });
  }

  return {
    userId,
    mode,
    family: {
      familyId: familyId || null,
      name: familyName || "Your Family",
      activeMemberId,
      members: effectiveMembers,
    },
    preferences: {
      byMemberId: MEMBER_PREFERENCES,
    },
  };
}

app.get("/v1/me", (req, res) => {
  res.json(buildMe(req));
});

// Request ctx depends on /v1/me
app.use((req, _res, next) => {
  try {
    req.ctx = req.ctx || {};
    req.ctx.me = buildMe(req);

    // Billing owner remains the same semantics: family rolls up to caller (or keep u_head if you prefer)
    req.ctx.billingOwnerId =
      req.ctx.me?.mode === "family" ? String(req.ctx.me.userId) : String(req.ctx.me?.userId || req.ctx.userId);
  } catch {
    req.ctx = req.ctx || {};
    req.ctx.me = null;
    req.ctx.billingOwnerId = req.ctx.userId;
  }
  next();
});

// PATCH /v1/me (unchanged behavior)
app.patch("/v1/me", (req, res) => {
  const userId = getUserId(req);
  const state = ensureMeState(userId);
  const body = req.body || {};

  if (body.mode === "individual" || body.mode === "family" || body.mode === "workplace") {
    state.mode = body.mode;
  }
  if (body.family && body.family.activeMemberId !== undefined) {
    state.activeMemberId = String(body.family.activeMemberId || "").trim() || null;
  }

  ME_STATE.set(userId, state);
  res.json(buildMe(req));
});

// keep /v1/family alias (returns same members as /v1/me)
app.get("/v1/family", (req, res) => {
  const me = buildMe(req);
  res.json({
    items: me.family.members,
    activeMemberId: me.family.activeMemberId,
    userId: me.userId,
    familyId: me.family.familyId,
    familyName: me.family.name,
  });
});



// ============================================================================
//  FAMILY CRUD (MVP)
// ============================================================================

// Create family for logged-in user
app.post("/v1/family", (req, res) => {
  const userId = String(req.ctx?.userId || getUserId(req));
  ensureUserRow(userId);

  const body = req.body || {};
  const familyName = String(body.name || "Your Family").trim() || "Your Family";

  const familyId = makeFamilyId();
  const ts = nowIso();

  usageDb.transaction(() => {
    familyInsertStmt.run({ id: familyId, name: familyName, createdAt: ts, updatedAt: ts });
    userUpsertStmt.run({ id: userId, familyId });

    // Add the creator as a member
    const memberId = makeMemberId();
    memberInsertStmt.run({
      id: memberId,
      familyId,
      name: String(body.ownerName || "Me").trim() || "Me",
      memberType: normalizeMemberType(body.ownerMemberType || "parent"),
      createdAt: ts,
      updatedAt: ts,
    });

    // switch to family mode + set active member
    const st = ensureMeState(userId);
    ME_STATE.set(userId, { ...st, mode: "family", activeMemberId: memberId });
  })();

  const members = membersListStmt.all(familyId).map((m) => ({
    id: String(m.id),
    displayName: String(m.name),
    memberType: String(m.memberType),
  }));

  res.json({ familyId, name: familyName, members });
});

// Join family by code (simple: familyId or "FAM-<id>")
app.post("/v1/family/join", (req, res) => {
  const userId = String(req.ctx?.userId || getUserId(req));
  ensureUserRow(userId);

  const code = String(req.body?.code || "").trim();
  const famId = code.startsWith("FAM-") ? code.slice(4) : code;
  if (!famId || famId.length < 3) return res.status(400).json({ error: "invalid_code" });

  const fam = familyGetStmt.get(famId);
  if (!fam) return res.status(404).json({ error: "family_not_found" });

  userUpsertStmt.run({ id: userId, familyId: famId });

  // If user has no member entry in that family, create one
  const existing = membersListStmt.all(famId);
  const ts = nowIso();
  let memberId = existing[0]?.id || null;

  if (!existing.find(() => false)) {
    // no-op; left intentionally
  }

  // Always add a member record for this joining user if you want one-per-user.
  // MVP simplest: add one.
  memberId = makeMemberId();
  memberInsertStmt.run({
    id: memberId,
    familyId: famId,
    name: String(req.body?.name || "Member").trim() || "Member",
    memberType: normalizeMemberType(req.body?.memberType || "parent"),
    createdAt: ts,
    updatedAt: ts,
  });

  const st = ensureMeState(userId);
  ME_STATE.set(userId, { ...st, mode: "family", activeMemberId: memberId });

  res.json({ ok: true, familyId: famId, familyName: String(fam.name || "Your Family") });
});

app.get("/v1/family/members", (req, res) => {
  const userId = String(req.ctx?.userId || getUserId(req));
  const userRow = ensureUserRow(userId);
  const familyId = String(userRow?.familyId || "");
  if (!familyId) return res.json({ items: [] });

  const items = membersListStmt.all(familyId).map((m) => ({
    id: String(m.id),
    familyId: String(m.familyId),
    name: String(m.name),
    memberType: String(m.memberType),
    insuranceId: m.insuranceId ?? null,
    corporateId: m.corporateId ?? null,
    createdAt: String(m.createdAt),
    updatedAt: String(m.updatedAt),
  }));
  

  res.json({ items });
});

app.post("/v1/family/members", (req, res) => {
  const userId = String(req.ctx?.userId || getUserId(req));
  const userRow = ensureUserRow(userId);
  const familyId = String(userRow?.familyId || "");
  if (!familyId) return res.status(400).json({ error: "NO_FAMILY" });

  const name = String(req.body?.name || "").trim();
  if (!name) return res.status(400).json({ error: "NAME_REQUIRED" });

  const memberType = normalizeMemberType(req.body?.memberType);
  const ts = nowIso();
  const id = makeMemberId();

  memberInsertStmt.run({ id, familyId, name, memberType, createdAt: ts, updatedAt: ts });

  res.json({ ok: true, item: { id, familyId, name, memberType, createdAt: ts, updatedAt: ts } });
});


app.patch("/v1/family/members/:memberId", (req, res) => {
  const userId = String(req.ctx?.userId || getUserId(req));
  const userRow = ensureUserRow(userId);
  const familyId = String(userRow?.familyId || "");
  if (!familyId) return res.status(400).json({ error: "NO_FAMILY" });

  const memberId = String(req.params.memberId || "");
  const existing = memberGetStmt.get(memberId);
  if (!existing || String(existing.familyId) !== familyId) return res.status(404).json({ error: "NOT_FOUND" });

  const name =
  req.body?.name !== undefined ? String(req.body.name || "").trim() : null;

const memberType =
  req.body?.memberType !== undefined ? normalizeMemberType(req.body.memberType) : null;

const insuranceId =
  req.body?.insuranceId !== undefined
    ? (req.body.insuranceId === null ? null : String(req.body.insuranceId))
    : null;

const corporateId =
  req.body?.corporateId !== undefined
    ? (req.body.corporateId === null ? null : String(req.body.corporateId))
    : null;

const ts = nowIso();

memberUpdateStmt.run({
  id: memberId,
  name: name || null,
  memberType: memberType || null,
  insuranceId,
  corporateId,
  updatedAt: ts,
});


  const updated = memberGetStmt.get(memberId);
  
  res.json({
    ok: true,
    item: {
      id: String(updated.id),
      familyId: String(updated.familyId),
      name: String(updated.name),
      memberType: String(updated.memberType),
      insuranceId: updated.insuranceId ?? null,
      corporateId: updated.corporateId ?? null,
      createdAt: String(updated.createdAt),
      updatedAt: String(updated.updatedAt),
    },
  });
  



});

// Delete member; if last -> delete family + fallback to individual
app.delete("/v1/family/members/:memberId", (req, res) => {
  const userId = String(req.ctx?.userId || getUserId(req));
  const userRow = ensureUserRow(userId);
  const familyId = String(userRow?.familyId || "");
  if (!familyId) return res.status(400).json({ error: "NO_FAMILY" });

  const memberId = String(req.params.memberId || "");
  const existing = memberGetStmt.get(memberId);
  if (!existing || String(existing.familyId) !== familyId) return res.status(404).json({ error: "NOT_FOUND" });

  const result = usageDb.transaction(() => {
    const cnt = Number(memberCountStmt.get(familyId)?.cnt || 0);

    if (cnt > 1) {
      memberDeleteStmt.run(memberId);
      return { familyDeleted: false };
    }

    // last member => delete family group
    memberDeleteStmt.run(memberId);
    familyDeleteStmt.run(familyId);

    // clear familyId for all users that point to this family
    usageDb.prepare(`UPDATE users SET familyId = NULL WHERE familyId = ?`).run(familyId);

    // fallback to individual
    const st = ensureMeState(userId);
    ME_STATE.set(userId, { ...st, mode: "individual", activeMemberId: userId });

    return { familyDeleted: true };
  })();

  res.json({ ok: true, ...result });
});



// ============================================================================
//  LOGS (SQLite, persistent) + day-summary
// ============================================================================
usageDb.exec(`
  CREATE TABLE IF NOT EXISTS meal_logs (
    id TEXT PRIMARY KEY,
    createdAt TEXT NOT NULL,
    day TEXT NOT NULL,
    userId TEXT NOT NULL,
    mealType TEXT NOT NULL,
    source TEXT NOT NULL,
    dishName TEXT NOT NULL,
    score REAL NOT NULL,
    label TEXT NOT NULL,
    confidence REAL NOT NULL,
    whyJson TEXT,
    tipsJson TEXT,
    nutritionJson TEXT,
    photoUri TEXT,
    scanId TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_meal_logs_user_day ON meal_logs(userId, day);
  CREATE INDEX IF NOT EXISTS idx_meal_logs_created ON meal_logs(createdAt);
`);

const logsInsertStmt = usageDb.prepare(`
  INSERT INTO meal_logs
  (id, createdAt, day, userId, mealType, source, dishName, score, label, confidence, whyJson, tipsJson, nutritionJson, photoUri, scanId)
  VALUES
  (@id, @createdAt, @day, @userId, @mealType, @source, @dishName, @score, @label, @confidence, @whyJson, @tipsJson, @nutritionJson, @photoUri, @scanId)
`);

const logsListStmt = usageDb.prepare(`
  SELECT id, createdAt, day, userId, mealType, source, dishName, score, label, confidence, whyJson, tipsJson, nutritionJson, photoUri, scanId
  FROM meal_logs
  WHERE userId IN (SELECT value FROM json_each(@userIdsJson))
  ORDER BY createdAt DESC
  LIMIT @limit
`);

const logsListByUserStmt = usageDb.prepare(`
  SELECT id, createdAt, day, userId, mealType, source, dishName, score, label, confidence, whyJson, tipsJson, nutritionJson, photoUri, scanId
  FROM meal_logs
  WHERE userId = @userId
  ORDER BY createdAt DESC
  LIMIT @limit
`);

const logsListByUserDayStmt = usageDb.prepare(`
  SELECT id, createdAt, day, userId, mealType, source, dishName, score, label, confidence, whyJson, tipsJson, nutritionJson, photoUri, scanId
  FROM meal_logs
  WHERE userId = @userId AND day = @day
  ORDER BY createdAt DESC
  LIMIT @limit
`);

const logsGetByIdStmt = usageDb.prepare(`
  SELECT id, createdAt, day, userId, mealType, source, dishName, score, label, confidence, whyJson, tipsJson, nutritionJson, photoUri, scanId
  FROM meal_logs
  WHERE id = @id
  LIMIT 1
`);

const logsDeleteByIdStmt = usageDb.prepare(`
  DELETE FROM meal_logs
  WHERE id = @id
`);

const logsCountByIdStmt = usageDb.prepare(`
  SELECT COUNT(1) as c
  FROM meal_logs
  WHERE id = @id
`);


function safeJsonParse(s, fallback) {
  try {
    return s ? JSON.parse(String(s)) : fallback;
  } catch {
    return fallback;
  }
}

function normalizeLogRow(r) {
  return {
    id: String(r.id),
    createdAt: String(r.createdAt),
    day: String(r.day),
    userId: String(r.userId),
    mealType: String(r.mealType),
    source: String(r.source),
    dishName: String(r.dishName),
    score: Number(r.score ?? 0),
    label: String(r.label ?? ""),
    confidence: Number(r.confidence ?? 0),
    why: safeJsonParse(r.whyJson, []),
    tips: safeJsonParse(r.tipsJson, []),
    nutrition: safeJsonParse(r.nutritionJson, null),
    photoUri: r.photoUri ? String(r.photoUri) : "",
    scanId: r.scanId ? String(r.scanId) : undefined,
  };
}

function inClausePlaceholders(n) {
  return Array.from({ length: n }, () => "?").join(", ");
}

app.get("/v1/logs", (req, res) => {
  try {
    const limitRaw = Number(req.query.limit ?? 200);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(500, limitRaw)) : 200;

    const uid = String(req.ctx?.userId || "").trim();
    const me = req.ctx?.me || null;
    if (!uid) return res.status(401).json({ error: "Not authenticated" });

    // meal_logs.userId stores member IDs in family mode (mem_*)
    let allowedIds = [];
    if (me?.mode === "family") {
      allowedIds = (me.family?.members || []).map((m) => String(m.id)).filter(Boolean);
    } else {
      const active = String(me?.family?.activeMemberId || me?.userId || uid || "u_self");
      allowedIds = [active].filter(Boolean);
    }

    if (!allowedIds.length) return res.json({ logs: [] });

    // Optional: filter to one memberId (must be allowed)
    const requested = req.query.userId ? String(req.query.userId).trim() : "";
    if (requested) {
      if (!allowedIds.includes(requested)) {
        return res.status(403).json({ error: "Not allowed to view logs for that userId" });
      }
      allowedIds = [requested];
    }

    const rows = logsListStmt.all({
      userIdsJson: JSON.stringify(allowedIds),
      limit,
    });

    return res.json({ logs: rows.map(normalizeLogRow) });
  } catch (e) {
    return res.status(500).json({ error: "Failed to fetch logs", details: String(e?.message || e) });
  }
});


app.get("/v1/logs/:id", (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ error: "missing id" });

    const uid = String(req.ctx?.userId || "").trim();
    const me = req.ctx?.me || null;
    if (!uid) return res.status(401).json({ error: "Not authenticated" });

    const row = logsGetByIdStmt.get({ id }); // <-- should be prepared on usageDb already
    if (!row) return res.status(404).json({ error: "Log item not found." });

    // reuse your existing policy helper if present
    if (typeof canDeleteLog === "function") {
      // same check works for "can view" in your MVP
      if (!canDeleteLog(me, row)) return res.status(403).json({ error: "forbidden" });
    }

    return res.json({ log: normalizeLogRow(row) });
  } catch (e) {
    return res.status(500).json({ error: "Failed to load log", details: String(e?.message || e) });
  }
});



// DELETE a log (SQLite-backed)
app.delete("/v1/logs/:id", (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ error: "missing id" });

    const uid = String(req.ctx?.userId || "").trim();
    const me = req.ctx?.me || null;
    if (!uid) return res.status(401).json({ error: "Not authenticated" });

    const row = logsGetByIdStmt.get({ id });
    if (!row) return res.status(404).json({ error: "log not found" });

    if (!canDeleteLog(me, row)) {
      return res.status(403).json({ error: "forbidden" });
    }

    const info = logsDeleteByIdStmt.run({ id });
    if (!info || Number(info.changes || 0) < 1) {
      return res.status(404).json({ error: "log not found" });
    }

    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: "failed to delete log", details: String(e?.message || e) });
  }
});




app.post("/v1/logs", (req, res) => {

  console.log("[/v1/logs POST] body keys:", Object.keys(req.body || {}), "userId:", (req.body || {}).userId);

  function normalizeLoggedForUserId(rawUserId, me) {
    const uid = String(rawUserId || "").trim();
  
    // If already a family member id, keep it
    if (uid.startsWith("mem_")) return uid;
  
    // If family mode and caller used legacy ids, map them to the right member
    if (me?.mode === "family") {
      const members = me.family?.members || [];
  
      // Heuristic: if your member objects include any stable mapping field, use it.
      // If not, fall back: u_self -> activeMemberId (best approximation)
      if (uid === "u_self") return String(me.family?.activeMemberId || uid);
  
      // Optional: map known ids by member name if you have conventions
      // (If your family has exact names "Spouse", "Child 1", etc.)
      if (uid === "u_head") return String(me.family?.activeMemberId || uid);
    }
  
    return uid || "u_self";
  }
  



  const item = req.body || {};

  // accept multiple payload shapes
  const rawScore =
    item.score ??
    item.rating?.score ??
    item.result?.score ??
    item.ratingScore ??
    item.resultScore;

  const rawLabel =
    item.label ??
    item.rating?.label ??
    item.result?.label ??
    item.ratingLabel ??
    item.resultLabel;

  const rawConfidence =
    item.confidence ??
    item.rating?.confidence ??
    item.result?.confidence ??
    0;


    const me = req.ctx?.me || null;
    const loggedFor = normalizeLoggedForUserId(item.userId, me);

  const entry = {
    
    id: `log_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    createdAt: new Date().toISOString(),
    day: item.day ? String(item.day) : isoDay(),

    // IMPORTANT: this is the "logged-for" member id (mem_...) or user id (u_...)
    //userId: String(item.userId || "u_self"),
    userId: loggedFor,

    mealType: String(item.mealType || "lunch"),
    source: String(item.source || "scan"),
    dishName: String(item.dishName || "Unknown dish"),
    score: clampScore(rawScore),
    label: String(rawLabel || ""),
    confidence: Number(rawConfidence ?? 0),

    why: Array.isArray(item.why) ? item.why.map(String) : [],
    tips: Array.isArray(item.tips) ? item.tips.map(String) : [],
    nutrition: item.nutrition || item.estimatedNutrition || null,
    photoUri: item.photoUri ? String(item.photoUri) : "",
    scanId: item.scanId ? String(item.scanId) : undefined,
  };

  logsInsertStmt.run({
    ...entry,
    whyJson: JSON.stringify(entry.why || []),
    tipsJson: JSON.stringify(entry.tips || []),
    nutritionJson: JSON.stringify(entry.nutrition ?? null),
  });

  res.json({ ok: true, item: entry });
});


// ---------- DAY SUMMARY (today + rolling average) ----------
// GET /v1/day-summary?userId=<memberId>&windowDays=1|14&day=YYYY-MM-DD
// Returns: { userId, day, mealsLogged, dailyScore, avgScore, windowDays, nextWin }
const dayScoresRangeStmt = usageDb.prepare(`
  SELECT day, AVG(score) AS avgScore, COUNT(*) AS meals
  FROM meal_logs
  WHERE userId = @userId
    AND day >= @startDay
    AND day <= @endDay
  GROUP BY day
  ORDER BY day ASC
`);

app.get("/v1/day-summary", (req, res) => {
  try {
    const me = req.ctx?.me || null;

    const userId =
      String(req.query.userId || "").trim() ||
      String(me?.family?.activeMemberId || me?.userId || req.ctx?.userId || "u_self");

    const windowDays = Math.max(1, Math.min(Number(req.query.windowDays) || 1, 60));

    const day = String(req.query.day || "").trim() || isoDay();

    // Use UTC day boundaries for stability
    const end = new Date(`${day}T00:00:00.000Z`);
    const start = new Date(end);
    start.setUTCDate(start.getUTCDate() - (windowDays - 1));

    const startDay = isoDayUtc(start);
    const endDay = isoDayUtc(end);

    const rows = dayScoresRangeStmt.all({ userId, startDay, endDay }) || [];

    const byDay = new Map();
    for (const r of rows) {
      const d = String(r.day || "");
      byDay.set(d, {
        day: d,
        avgScore: clampScore(Number(r.avgScore || 0)),
        meals: Number(r.meals || 0),
      });
    }

    const todayRow = byDay.get(day) || null;
    const dailyScore = todayRow ? todayRow.avgScore : 0;
    const mealsLogged = todayRow ? todayRow.meals : 0;

    // Rolling average = average of per-day averages across days with >=1 meal
    const daysWithMeals = Array.from(byDay.values()).filter((x) => Number(x.meals) > 0);
    const avgScore =
      daysWithMeals.length > 0
        ? clampScore(
            daysWithMeals.reduce((a, x) => a + Number(x.avgScore || 0), 0) / daysWithMeals.length
          )
        : 0;

    const nextWin =
      dailyScore >= 80
        ? ["Keep it consistent", "Protein + veggies", "Hydrate"]
        : dailyScore >= 60
        ? ["Add fiber", "Keep sodium moderate", "Choose lean protein"]
        : ["Avoid sugary drinks", "Add protein", "Add vegetables/beans"];

    res.json({
      userId,
      day,
      mealsLogged,
      dailyScore,
      avgScore,
      windowDays,
      nextWin,
    });
  } catch (e) {
    console.error("day-summary error:", e);
    res.status(500).json({ error: "day_summary_error" });
  }
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
  


  const dayLogs = logsListByUserDayStmt.all({ userId: memberId, day, limit: 500 }).map(normalizeLogRow);
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