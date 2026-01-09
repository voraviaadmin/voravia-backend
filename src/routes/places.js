import express from "express";
import { searchNearbyRestaurants } from "../services/googlePlaces.js";

const router = express.Router();

// GET /api/places/nearby?lat=..&lng=..
router.get("/nearby", async (req, res, next) => {
  try {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ error: "Invalid lat/lng" });
    }

    const places = await searchNearbyRestaurants({ lat, lng });
    res.json({ places });
  } catch (e) {
    next(e);
  }
});

export default router;
