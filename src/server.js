// server.js – Voravia backend (Food analyze + Places nearby + Menu OCR + Ratings)
import express from "express";
import cors from "cors";
import multer from "multer";
import OpenAI from "openai";
import "dotenv/config";

const app = express();
const port = process.env.PORT || 8787;

// ---------- CORS (Expo Web) ----------
app.use(
  cors({
    origin: ["http://localhost:8081", "http://127.0.0.1:8081"],
  })
);

app.use(express.json({ limit: "2mb" }));

// ---------- OpenAI Client ----------
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---------- Upload handling (in-memory) ----------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8 MB
});

// ---------- HEALTH CHECK ----------
app.get("/health", (_, res) => res.json({ ok: true }));

/**
 * Utility: basic menu line scoring (MVP heuristic).
 * Later: tie to user profile rules (diabetes/htn/etc).
 */
function scoreMenuLine(line) {
  const l = (line || "").toLowerCase();
  let score = 70;
  const reasons = [];

  // Positive signals
  if (l.includes("grilled") || l.includes("baked") || l.includes("steamed")) {
    score += 10;
    reasons.push("Grilled/baked");
  }
  if (l.includes("salad") || l.includes("veggie") || l.includes("greens")) {
    score += 8;
    reasons.push("Veggies/greens");
  }
  if (
    l.includes("chicken") ||
    l.includes("fish") ||
    l.includes("tofu") ||
    l.includes("lentil") ||
    l.includes("beans")
  ) {
    score += 6;
    reasons.push("Lean protein");
  }

  // Risk signals
  if (l.includes("fried") || l.includes("crispy") || l.includes("tempura")) {
    score -= 18;
    reasons.push("Fried");
  }
  if (l.includes("creamy") || l.includes("alfredo") || l.includes("cheese")) {
    score -= 10;
    reasons.push("Heavier sauce");
  }
  if (l.includes("sweet") || l.includes("dessert") || l.includes("syrup") || l.includes("honey")) {
    score -= 12;
    reasons.push("High sugar");
  }
  if (l.includes("bacon") || l.includes("pepperoni") || l.includes("sausage")) {
    score -= 10;
    reasons.push("Processed meat");
  }

  score = Math.max(0, Math.min(100, score));
  const verdict = score >= 80 ? "FIT" : score >= 60 ? "MODERATE" : "AVOID";
  return { score, verdict, reasons: reasons.slice(0, 3) };
}

// ---------- 1) GOOGLE PLACES (Nearby restaurants) ----------
// GET /api/places/nearby?lat=..&lng=..&radiusMeters=2500&limit=20
app.get("/api/places/nearby", async (req, res) => {
  try {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ error: "Invalid lat/lng" });
    }

    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "Missing GOOGLE_MAPS_API_KEY" });

    // radius
    const radiusMetersRaw = Number(req.query.radiusMeters ?? 2500);
    const radiusMeters = Number.isFinite(radiusMetersRaw) ? radiusMetersRaw : 2500;

    // ✅ clamp max results to Places API allowed range: 1..20
    const requestedLimit = Number(req.query.limit ?? 20);
    const maxResultCount = Math.min(20, Math.max(1, Number.isFinite(requestedLimit) ? requestedLimit : 20));

    const url = "https://places.googleapis.com/v1/places:searchNearby";

    const body = {
      includedTypes: ["restaurant"],
      maxResultCount,
      locationRestriction: {
        circle: {
          center: { latitude: lat, longitude: lng },
          radius: radiusMeters,
        },
      },
    };

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        // Required FieldMask (otherwise Places API returns error)
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

    const places = (json.places ?? []).map((p) => ({
      id: p.id,
      displayName: p.displayName?.text ?? "Unknown",
      formattedAddress: p.formattedAddress ?? "",
      location: { lat: p.location?.latitude, lng: p.location?.longitude },
      rating: p.rating,
      userRatingCount: p.userRatingCount,
      types: p.types ?? [],
    }));

    res.json({ places });
  } catch (err) {
    console.error("Places error:", err);
    res.status(500).json({ error: "places_error", message: err?.message });
  }
});

// ---------- 2) MENU OCR (Image -> extracted lines + rating) ----------
// POST /api/menu/ocr  (multipart/form-data: image)
app.post("/api/menu/ocr", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "image field is required" });
    if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: "Missing OPENAI_API_KEY" });

    const base64 = req.file.buffer.toString("base64");
    const dataUrl = `data:${req.file.mimetype};base64,${base64}`;

    // OCR-style extraction prompt
    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text:
                "You extract readable menu text from images.\n" +
                "Return plain text only.\n" +
                "- One menu item per line\n" +
                "- Keep section headings as their own lines\n" +
                "- Do NOT add commentary",
            },
          ],
        },
        {
          role: "user",
          content: [
            { type: "input_text", text: "Extract the menu items from this image." },
            { type: "input_image", image_url: dataUrl },
          ],
        },
      ],
    });

    const text = response?.output?.[0]?.content?.[0]?.text ?? "";
    const lines = text
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 250);

    const rated = lines.map((line) => ({
      line,
      ...scoreMenuLine(line),
    }));

    res.json({ text, lines, rated });
  } catch (err) {
    console.error("Menu OCR error:", err);
    res.status(500).json({ error: "menu_ocr_error", message: err?.message });
  }
});

// ---------- 3) EXISTING FOOD ANALYZE (your current endpoint, but memory upload) ----------
// POST /analyze-food (multipart/form-data: image, optional profile JSON string, hint)
app.post("/analyze-food", upload.single("image"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "image field is required" });
  if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: "Missing OPENAI_API_KEY" });

  try {
    const profileRaw = req.body.profile || "{}";
    const hint = req.body.hint || "";
    let profile;
    try {
      profile = JSON.parse(profileRaw);
    } catch {
      profile = {};
    }

    const base64 = req.file.buffer.toString("base64");
    const dataUrl = `data:${req.file.mimetype};base64,${base64}`;

    const profileText = `
User health profile (for tailoring advice):
- Weight (kg): ${profile.weightKg ?? "unknown"}
- Goal: ${profile.goalLoss ? "weight loss" : "maintenance/gain"}
- Diabetes: ${profile.diabetes ? "yes" : "no"}
- Hypertension: ${profile.htn ? "yes" : "no"}
- NAFLD (fatty liver): ${profile.nafld ? "yes" : "no"}
`.trim();

    const systemPrompt = `
You are an expert dietitian and nutrition scientist.

You will receive a photo of a single meal or food plus a short text profile.
Your job:

1. Identify the main dish or combination of foods.
2. Estimate portion size in grams.
3. Estimate calories and macros for that portion (carbs, protein, fat).
4. List 3–5 key health benefits.
5. Considering the user's health profile (diabetes, hypertension, NAFLD, weight loss), compute:
   - suitabilityLabel: "Better", "OK", or "Avoid"
   - suitabilityReasons: short bullet-style reasons.

IMPORTANT: Respond with ONLY a single JSON object and nothing else, in this exact shape:

{
  "name": string,
  "confidence": number,
  "portionGrams": number,
  "calories": number,
  "carbs": number,
  "protein": number,
  "fat": number,
  "benefits": string[],
  "suitabilityLabel": "Better" | "OK" | "Avoid",
  "suitabilityReasons": string[]
}
`.trim();

    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: [
        {
          role: "system",
          content: [{ type: "input_text", text: systemPrompt }],
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text:
                "Here is the user health profile:\n" +
                profileText +
                (hint ? `\n\nUser text hint about the dish: ${hint}` : ""),
            },
            { type: "input_image", image_url: dataUrl },
          ],
        },
      ],
    });

    // Parse JSON from model output
    const textPart = response?.output?.[0]?.content?.[0]?.text ?? "{}";
    const data = JSON.parse(textPart);

    res.json(data);
  } catch (err) {
    console.error("AI error", err);
    res.status(500).json({ error: "ai_error", message: err?.message });
  }
});

app.listen(port, () => {
  console.log(`✅ Voravia backend running on port ${port}`);
});
