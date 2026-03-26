/**
 * Scoring Engine Module
 * Heuristic and ranking logic for geocoding results
 */

import {
  normalize,
  toTokens,
  parseHouseNumber,
  mapToLatLng,
} from "./addressUtils.js";
import { GeoMath } from "../geoMath.js";

function extractGeometryPath(item) {
  const geometry = item?.raw?.geometry;
  if (!geometry) return [];

  let coords = [];
  if (geometry.type === "LineString") {
    coords = geometry.coordinates || [];
  } else if (geometry.type === "MultiLineString") {
    coords = (geometry.coordinates || []).flat();
  }

  return (coords || [])
    .map((coord) => {
      const lng = Number(coord?.[0]);
      const lat = Number(coord?.[1]);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
      return { lat, lng };
    })
    .filter(Boolean);
}

/**
 * UI formatter for manual coordinates input.
 */
export function formatManualResult(coords, raw) {
  return {
    lat: coords.lat,
    lng: coords.lng,
    label: raw,
    provider: "manual",
    matchType: "exact",
    isInterpolated: false,
    isFuzzy: false,
    confidence: 1.0,
    confidenceLabel: "MANUAL_COORDS",
    needsVerification: false,
    isImprecise: false,
    markerTone: "default",
  };
}

/**
 * Build UI-ready exact result; applies depth offset along geometry path when needed.
 */
export function processExactResult(item, peelDepth, raw) {
  const base = mapToLatLng(item) || { lat: item?.lat, lng: item?.lng };
  let point = base;

  if (Number.isFinite(peelDepth) && peelDepth > 0) {
    const path = extractGeometryPath(item);
    if (path.length >= 2) {
      const offset = GeoMath.followPathDistance(path, peelDepth);
      if (offset) point = offset;
    }
  }

  return {
    lat: point.lat,
    lng: point.lng,
    label: [item?.houseNumber, item?.street, item?.district || item?.city].filter(Boolean).join(" ").trim() || raw,
    provider: `${(item?.source || "source").toString().replace(/^./, (c) => c.toUpperCase())} (Exact)`,
    matchType: "exact",
    isInterpolated: false,
    isFuzzy: false,
    confidence: "high",
    needsVerification: false,
    isImprecise: false,
    markerTone: "default",
  };
}

/**
 * UI formatter for fuzzy fallback result.
 */
export function formatFuzzyResult(bestGuess) {
  return {
    lat: bestGuess.lat,
    lng: bestGuess.lng,
    label: bestGuess.label,
    provider: "Best Guess (Fuzzy)",
    matchType: "best-guess",
    isInterpolated: false,
    isFuzzy: true,
    confidence: 0.5,
    confidenceLabel: "FUZZY_GUESS",
    needsVerification: true,
    isImprecise: true,
    markerTone: "grey",
    snappedToPoi: bestGuess.snappedToPoi,
    method: "GEOMATH (APPROXIMATE)",
  };
}

/**
 * Score house number match (exact, close, or token-based)
 */
export function scoreHouseNumberMatch(result, queryTokens, targetHouseNumber) {
  const number = parseHouseNumber(result.houseNumber);
  if (!Number.isFinite(number)) return 0;

  if (Number.isFinite(targetHouseNumber)) {
    const diff = Math.abs(number - targetHouseNumber);
    if (diff === 0) return 120;
    if (diff <= 2) return 70;
    if (diff <= 6) return 40;
    if (diff <= 20) return 16;
  }

  const numberToken = String(number).toLowerCase();
  return queryTokens.includes(numberToken) ? 22 : 0;
}

/**
 * Score district/city match using token overlap
 */
export function scoreDistrictMatch(result, queryTokens) {
  const districtText = normalize(`${result.district || ""} ${result.city || ""}`);
  if (!districtText) return 0;

  const districtTokens = toTokens(districtText);
  const hits = districtTokens.filter((t) => queryTokens.includes(t)).length;
  return hits >= 2 ? 24 : hits === 1 ? 10 : 0;
}

/**
 * Score street/road name match using token overlap ratio
 */
export function scoreStreetMatch(result, queryTokens) {
  const streetTokens = toTokens(result.street || result.name || "");
  if (streetTokens.length === 0) return 0;

  const hits = streetTokens.filter((t) => queryTokens.includes(t)).length;
  if (hits === 0) return 0;

  const ratio = hits / streetTokens.length;
  if (ratio >= 0.7) return 28;
  if (ratio >= 0.4) return 16;
  return 8;
}

/**
 * Score result based on POI type (house, building, amenity, etc.)
 */
export function scoreType(result) {
  const type = normalize(result.type);
  if (["house", "building", "amenity"].includes(type)) return 16;
  if (["bus_stop", "station", "public_transport"].includes(type)) return 14;
  if (["residential", "road"].includes(type)) return 4;
  return 0;
}

/**
 * Check if query has both street name and house number semantics
 */
export function hasStreetAndNumberInQuery(queryTokens) {
  const hasNumber = queryTokens.some((t) => /^\d+[a-z]?$/.test(t));
  const hasStreet = queryTokens.includes("quang") || queryTokens.includes("trung") || queryTokens.length >= 3;
  return hasNumber && hasStreet;
}

/**
 * Determine if result should snap to POI
 */
export function shouldSnapToPoi(result, queryTokens) {
  if (!hasStreetAndNumberInQuery(queryTokens)) return false;

  const type = normalize(result.type);
  const poiLike = ["bus_stop", "building", "amenity"].includes(type);
  if (!poiLike) return false;

  return scoreStreetMatch(result, queryTokens) > 0;
}

/**
 * Find best matching result from collection
 * Applies multi-dimensional scoring with area anchor safety valve
 * 
 * @param {Array} results - Search results from API
 * @param {string} inputQuery - Original user query
 * @param {Object} options - { expectedDistrict }
 * @returns {Object|null} Best ranked result or null if none qualify
 */
export function findBestMatch(results, inputQuery, options = {}) {
  if (!Array.isArray(results) || results.length === 0) return null;

  // OPTIMIZATION: Pre-normalize everything once at function entry
  const { areaMatchesAnchor, extractAreaAnchor, extractQueryHouseNumber } = options;
  if (!areaMatchesAnchor || !extractAreaAnchor || !extractQueryHouseNumber) {
    throw new Error("findBestMatch requires dependency injection: areaMatchesAnchor, extractAreaAnchor, extractQueryHouseNumber");
  }

  const queryTokens = toTokens(inputQuery);
  const targetHouseNumber = extractQueryHouseNumber(inputQuery);
  const anchor = options.expectedDistrict || extractAreaAnchor(inputQuery);

  let best = null;
  let bestScore = -Infinity;

  // Single-pass vectorized scoring
  for (const item of results) {
    const isAreaMatch = areaMatchesAnchor(item, anchor);

    let score = 0;
    score += scoreType(item);
    score += scoreStreetMatch(item, queryTokens);
    score += scoreDistrictMatch(item, queryTokens);
    score += scoreHouseNumberMatch(item, queryTokens, targetHouseNumber);

    // THE SAFETY VALVE: Prevents marker from leaving territory
    if (anchor && !isAreaMatch) {
      score -= 250;
      continue;
    }

    if (anchor && isAreaMatch) score += 40;
    if (normalize(item.source) === "photon") score += 8;
    if (normalize(item.source) === "nominatim") score += 4;
    if (shouldSnapToPoi(item, queryTokens)) score += 25;

    if (score > bestScore) {
      bestScore = score;
      best = { ...item, districtMatch: isAreaMatch };
    }
  }

  if (!best) return null;

  return {
    lat: best.lat,
    lng: best.lng,
    label: [best.houseNumber, best.street, best.district || best.city]
      .filter(Boolean)
      .join(" ")
      .trim() || best.address || inputQuery,
    score: bestScore,
    source: best.source,
    sourceType: best.type,
    snappedToPoi: shouldSnapToPoi(best, queryTokens),
    districtMatch: best.districtMatch,
  };
}
