// server.js – real image AI with OpenAI Vision, JSON output
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import fs from 'fs/promises';
import path from 'path';
import OpenAI from 'openai';
import 'dotenv/config';

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '1mb' }));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// store uploaded photos temporarily
const upload = multer({
  dest: 'uploads/',
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
});

// ---------- HEALTH CHECK ----------
app.get('/health', (_, res) => res.json({ ok: true }));

// ---------- MAIN AI ENDPOINT ----------
app.post(
  '/analyze-food',
  upload.single('image'),
  async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'image field is required' });
    }

    try {
      const profileRaw = req.body.profile || '{}';
      const hint = req.body.hint || '';
      let profile;
      try {
        profile = JSON.parse(profileRaw);
      } catch {
        profile = {};
      }

      const filePath = path.resolve(req.file.path);
      const imageBuffer = await fs.readFile(filePath);
      const base64 = imageBuffer.toString('base64');

      const profileText = `
User health profile (for tailoring advice):
- Weight (kg): ${profile.weightKg ?? 'unknown'}
- Goal: ${profile.goalLoss ? 'weight loss' : 'maintenance/gain'}
- Diabetes: ${profile.diabetes ? 'yes' : 'no'}
- Hypertension: ${profile.htn ? 'yes' : 'no'}
- NAFLD (fatty liver): ${profile.nafld ? 'yes' : 'no'}
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

IMPORTANT: Respond with **ONLY** a single JSON object and nothing else, in this exact shape:

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
        model: 'gpt-4.1-mini',
        input: [
          {
            role: 'system',
            content: [
              {
                type: 'input_text',
                text: systemPrompt,
              },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'input_text',
                text:
                  'Here is the user health profile:\n' +
                  profileText +
                  (hint ? `\n\nUser text hint about the dish: ${hint}` : ''),
              },
              {
                type: 'input_image',
                image_url: `data:image/jpeg;base64,${base64}`,
              },
            ],
          },
        ],
      });

      // Extract JSON from model output and parse
      const textPart = response.output[0].content[0].text;
      const data = JSON.parse(textPart);

      // Clean up uploaded file
      fs.unlink(filePath).catch(() => {});

      res.json(data);
    } catch (err) {
      console.error('AI error', err);
      res.status(500).json({ error: 'ai_error' });
    }
  }
);

app.listen(port, () => {
  console.log(`Food AI backend running on port ${port}`);
});
