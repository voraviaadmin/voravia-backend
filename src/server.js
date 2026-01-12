// src/server.js – Voravia backend (JSON-tolerant)
// Fixes: model returning ```json fences / extra text causing JSON.parse to fail.

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

// ---------- CORS (Expo Web) ----------
// ---app.use(
// ---  cors({
// ---    origin: [
// ---      "http://localhost:8081",
// ---      "http://127.0.0.1:8081",
// ---      "http://localhost:8082",
// ---      "http://127.0.0.1:8082",
// ---      "http://localhost:8083",
// ---      "http://127.0.0.1:8083",
// ---      "http://localhost:19006",
// ---      "http://127.0.0.1:19006",
// ---    ],
// ---    methods: ["GET", "POST", "OPTIONS"],
// ---    allowedHeaders: ["Content-Type"],
// ---  })
// ---);

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

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function stableJsonKey(obj) {
  const keys = Object.keys(obj || {}).sort();
  const out = {};
  for (const k of keys) out[k] = obj[k];
  return JSON.stringify(out);
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

function extractFirstJson(text) {
  if (!text) throw new Error("Empty model response");

  let t = String(text).trim();

  // strip ```json fences
  t = t.replace(/^```json\s*/i, "").replace(/^```\s*/i, "");
  t = t.replace(/\s*```$/i, "").trim();

  // find JSON object
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

  // 1st attempt: normal parse
  try {
    return JSON.parse(sliced);
  } catch (_) {
    // 2nd attempt: handle "escaped JSON" like {\"sections\":...}
    // Convert \" -> " and \\n -> \n etc.
    const unescaped = sliced
      .replace(/\\+"/g, '"')     // \" or \\" -> "
      .replace(/\\\\/g, "\\")    // \\ -> \
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t");

    return JSON.parse(unescaped);
  }
}


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

// ---------- HEALTH CHECK ----------
app.get("/health", (_, res) => res.json({ ok: true }));

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

// ---------- MENU EXTRACT UPLOAD (PDF/images) + caching ----------
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
        hint: "Server now strips ```json fences and parses first {...}. If still failing, your model output is malformed.",
      });
    }

    const sections = Array.isArray(parsedJson.sections) ? parsedJson.sections : [];
    //const rawText = typeof parsedJson.rawText === "string" ? parsedJson.rawText : "";

    // Clean + dedupe
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

// ---------- MENU RATE (AI estimate + rules) + caching ----------
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

    // Minimal scoring (keep it simple for now)
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

      score = Math.max(0, Math.min(100, Math.round(score)));
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
