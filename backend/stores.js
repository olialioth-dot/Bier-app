const STORES = require('./stores-data.json');

// In-memory cache for PLZ geocoding (avoids repeated Nominatim calls)
const PLZ_CACHE = new Map();

// ─── Haversine distance in km ────────────────────────────────────────────────
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── Geocode a Swiss PLZ via Nominatim ──────────────────────────────────────
async function geocodePLZ(plz) {
  if (PLZ_CACHE.has(plz)) return PLZ_CACHE.get(plz);
  try {
    const url = `https://nominatim.openstreetmap.org/search?postalcode=${plz}&country=ch&format=json&limit=1`;
    const res  = await fetch(url, {
      headers: { 'User-Agent': 'BierDeal/1.0 (kontakt@bierdeal.ch)' },
    });
    const data = await res.json();
    if (!data.length) return null;
    const coord = { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
    PLZ_CACHE.set(plz, coord);
    return coord;
  } catch {
    return null;
  }
}

// ─── Find stores within radius ───────────────────────────────────────────────
async function findStores({ plz, shop, radius = 20 }) {
  const center = await geocodePLZ(plz);
  if (!center) return null;

  return STORES
    .filter(s => !shop || s.shop.toLowerCase() === shop.toLowerCase())
    .map(s => ({
      ...s,
      distance: Math.round(haversine(center.lat, center.lng, s.lat, s.lng) * 10) / 10,
    }))
    .filter(s => s.distance <= radius)
    .sort((a, b) => a.distance - b.distance);
}

module.exports = { findStores };
