export async function searchNearbyRestaurants({
  lat,
  lng,
  radiusMeters = 2500,
  maxResultCount = 20,
}) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    const e = new Error("Missing GOOGLE_MAPS_API_KEY in .env");
    e.statusCode = 500;
    throw e;
  }

  // 🔒 Google Places API constraint: 1–20 only
  const safeMax = Math.min(20, Math.max(1, Number(maxResultCount) || 20));

  const url = "https://places.googleapis.com/v1/places:searchNearby";

  const body = {
    includedTypes: ["restaurant"],
    maxResultCount: safeMax,
    locationRestriction: {
      circle: {
        center: {
          latitude: Number(lat),
          longitude: Number(lng),
        },
        radius: Number(radiusMeters) || 2500,
      },
    },
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      // REQUIRED FieldMask (Places API New)
      "X-Goog-FieldMask":
        "places.id,places.displayName,places.formattedAddress,places.location,places.rating,places.userRatingCount,places.types",
    },
    body: JSON.stringify(body),
  });

  const json = await resp.json();

  if (!resp.ok) {
    const e = new Error(
      json?.error?.message || `Places API error: ${resp.status}`
    );
    e.statusCode = resp.status;
    e.details = json;
    throw e;
  }

  // Normalize response for frontend
  return (json.places ?? []).map((p) => ({
    id: p.id,
    displayName: p.displayName?.text ?? "Unknown",
    formattedAddress: p.formattedAddress ?? "",
    location: {
      lat: p.location?.latitude,
      lng: p.location?.longitude,
    },
    rating: p.rating,
    userRatingCount: p.userRatingCount,
    types: p.types ?? [],
  }));
}
