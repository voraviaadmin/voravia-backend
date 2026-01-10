import express from "express";
import multer from "multer";
import rateLimit from "express-rate-limit";

import { extractMenuTextFromImageBuffer } from "../services/openaiVision.js";
import { scoreMenuLine } from "../services/scoring.js";

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

const ocrLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 12,
  standardHeaders: true,
  legacyHeaders: false,
});

// ---------- helpers ----------
function isHttpUrl(v) {
  try {
    const u = new URL(String(v));
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

async function fetchPageHtml(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
  };

  try {
    let res = await fetch(url, {
      headers,
      redirect: "follow",
      signal: controller.signal,
    });

    if (res.status === 403) {
      const origin = new URL(url).origin;
      res = await fetch(url, {
        headers: { ...headers, Referer: `${origin}/` },
        redirect: "follow",
        signal: controller.signal,
      });
    }

    const body = await res.text();

    if (!res.ok) {
      const err = new Error(`Failed to fetch url (${res.status})`);
      err.status = res.status;
      err.preview = body?.slice(0, 300);
      throw err;
    }

    return { html: body, finalUrl: res.url };
  } finally {
    clearTimeout(t);
  }
}

function normalizeLines(text) {
  return String(text || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => s.length >= 2 && s.length <= 120);
}

function htmlToLines(html) {
  // remove script/style
  let cleaned = String(html || "")
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, " ")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|li|h1|h2|h3|h4|tr|br)\s*>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ");

  cleaned = cleaned
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

  return normalizeLines(cleaned);
}

function rateItems(items, profile) {
  return items.slice(0, 200).map((name) => {
    const scored = scoreMenuLine(name, profile);
    const score = typeof scored?.score === "number" ? scored.score : 70;
    const verdict =
      scored?.verdict || (score >= 80 ? "FIT" : score >= 60 ? "MODERATE" : "AVOID");
    const reasons = scored?.reasons || scored?.tags || ["Heuristic rating (MVP)."];

    return {
      name,
      verdict,
      score,
      reasons: Array.isArray(reasons) ? reasons : [String(reasons)],
    };
  });
}

// ---------- routes ----------

/**
 * POST /api/menu/extract
 * body: { url }
 *
 * IMPORTANT:
 * - If blocked (403) we return HTTP 200 + { fallback:"upload" } so UI can switch to OCR.
 */
router.post("/extract", async (req, res) => {
  res.set("X-Voravia-Menu", "v2"); // helps confirm you’re running this file

  try {
    const { url } = req.body || {};
    if (!url || !isHttpUrl(url)) {
      return res.status(400).json({ error: "missing_or_invalid_url" });
    }

    const { html, finalUrl } = await fetchPageHtml(url);

    const lines = htmlToLines(html);
    const items = lines.slice(0, 120).map((x) => ({ name: x }));

    // If menu is JS-rendered, you may get very few usable lines:
    if (items.length < 8) {
      return res.json({
        url,
        finalUrl,
        sections: [],
        fallback: "upload",
        message:
          "Menu appears JS-rendered or blocked. Upload screenshot/PDF to extract items reliably.",
      });
    }

    return res.json({
      url,
      finalUrl,
      sections: [{ name: "Menu", items }],
      fallback: null,
    });
  } catch (e) {
    // ✅ DO NOT return HTTP 403 to the client
    if (e?.status === 403 || String(e?.message || "").includes("(403)")) {
      return res.json({
        fallback: "upload",
        message:
          "This menu site blocks server-side fetching (403). Upload a menu screenshot/PDF instead.",
      });
    }

    return res.status(500).json({
      error: "menu_extract_error",
      message: e?.message || "extract_failed",
    });
  }
});

/**
 * POST /api/menu/ocr
 * multipart/form-data:
 *   - image: file
 * returns: { text, lines }
 */
router.post("/ocr", ocrLimiter, upload.single("image"), async (req, res) => {
  res.set("X-Voravia-Menu", "v2");
  try {
    if (!req.file) return res.status(400).json({ error: "missing_image" });

    const text = await extractMenuTextFromImageBuffer({
      buffer: req.file.buffer,
      mimeType: req.file.mimetype,
    });

    const lines = normalizeLines(text);
    return res.json({ text, lines });
  } catch (e) {
    return res.status(500).json({ error: "menu_ocr_error", message: e?.message || "ocr_failed" });
  }
});

/**
 * POST /api/menu/rate
 * body: { items: string[], profile?: {...} }
 */
router.post("/rate", async (req, res) => {
  res.set("X-Voravia-Menu", "v2");
  try {
    const { items, profile } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "missing_items" });
    }

    const ratedItems = rateItems(items, profile || {});
    return res.json({ profileUsed: profile || {}, ratedItems });
  } catch (e) {
    return res.status(500).json({ error: "menu_rate_error", message: e?.message || "rate_failed" });
  }
});

export default router;
