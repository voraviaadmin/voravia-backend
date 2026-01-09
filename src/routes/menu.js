import express from "express";
import multer from "multer";
import rateLimit from "express-rate-limit";

import { extractMenuTextFromImageBuffer } from "../services/openaiVision.js";
import { scoreMenuLine } from "../services/scoring.js";

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB
});

const ocrLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10, // 10 requests/min per IP
  standardHeaders: true,
  legacyHeaders: false,
});

// POST /api/menu/ocr  (multipart/form-data: image)
router.post("/ocr", ocrLimiter, upload.single("image"), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Missing image" });

    const text = await extractMenuTextFromImageBuffer({
      buffer: req.file.buffer,
      mimeType: req.file.mimetype,
    });

    const lines = text
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);

    const rated = lines.map((line) => ({
      line,
      ...scoreMenuLine(line),
    }));

    res.json({ text, rated });
  } catch (e) {
    next(e);
  }
});

export default router;
