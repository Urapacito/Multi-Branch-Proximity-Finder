/**
 * Location Service - Main Coordinator Module
 * Orchestrates the geocoding resolution flow with modular dependencies
 * Flow: Cache Check -> Parallel Search -> Scoring -> Return
 */

import { fetchOsrmRoute, searchNominatim, searchPhoton } from "../../repositories/geoRepository.js";
import { GeoMath } from "../geoMath.js";
import { locationResultCache, anchorQueryCache } from "./cacheManager.js";
import {
  normalize,
  toTokens,
  dedupeStrings,
  extractCoordinates,
  extractQueryHouseNumber,
  extractStreetFragment,
  inferStreetFromResults,
  extractAreaHint,
  extractAreaAnchor,
  buildHierarchicalQueries,
  extractSlashCount,
  extractAlleyMeta,
  mapToLatLng,
  areaMatchesAnchor,
  findExactHouseMatch,
} from "./addressUtils.js";
import {
  findBestMatch,
} from "./scoringEngine.js";
import {
  extractGeometryPath,
  haversineMeters,
  extractLineSegment,
  buildInterpolationCandidate,
} from "./interpolationService.js";

const API_CALL_DELAY_MS = 400;
const ANCHOR_REQUEST_DELAY_MS = API_CALL_DELAY_MS;
const ALLEY_OFFSET_METERS = 20;

/**
 * Utility: Sleep for specified milliseconds
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Compute alley offset result with depth-aware geometry path following
 * Standalone helper to reduce cognitive load in main resolution flow
 */
function computeAlleyOffsetResult(item, fallbackPoint, depthMeters = ALLEY_OFFSET_METERS) {
  const pathPoints = extractGeometryPath(item);
  if (pathPoints.length >= 2) {
    const followed = GeoMath.followPathDistance(pathPoints, depthMeters);
    if (followed) return followed;
  }

  const segment = extractLineSegment(item);
  if (!segment) return fallbackPoint;

  const segmentLength = haversineMeters(segment.start, segment.next);
  if (!Number.isFinite(segmentLength) || segmentLength <= 0) return fallbackPoint;

  const safeDistance = Number.isFinite(depthMeters) ? Math.max(0, depthMeters) : ALLEY_OFFSET_METERS;
  const ratio = Math.min(1, safeDistance / segmentLength);
  return {
    lat: segment.start.lat + (segment.next.lat - segment.start.lat) * ratio,
    lng: segment.start.lng + (segment.next.lng - segment.start.lng) * ratio,
  };
}

/**
 * Build alley offset candidate with depth and area matching
 */
function buildAlleyOffsetCandidate(results, alleyMeta, expectedDistrict, rawQuery, distanceMeters = ALLEY_OFFSET_METERS) {
  if (!alleyMeta) return null;

  const alleyToken = `ngo ${alleyMeta.alleyNumber}`;
  const alleyResult = (results || []).find((item) => {
    if (!(expectedDistrict && areaMatchesAnchor(item, expectedDistrict))) return false;

    const text = normalize([
      item?.name,
      item?.street,
      item?.address,
      item?.raw?.properties?.name,
      item?.raw?.properties?.street,
    ]
      .filter(Boolean)
      .join(" "));

    return text.includes(alleyToken);
  });

  if (!alleyResult) return null;

  const alleyBasePoint = mapToLatLng(alleyResult);
  if (!alleyBasePoint) return null;

  const offsetPoint = computeAlleyOffsetResult(alleyResult, alleyBasePoint, distanceMeters);
  return {
    lat: offsetPoint.lat,
    lng: offsetPoint.lng,
    label: [`${alleyMeta.houseNumber}`, `ngõ ${alleyMeta.alleyNumber}`, alleyResult.street || alleyResult.district || expectedDistrict || ""]
      .filter(Boolean)
      .join(" ")
      .trim() || rawQuery,
    provider: "GEOMATH_ALLEY_OFFSET",
    matchType: "approximate",
    isApproximate: true,
    isInterpolated: false,
    isFuzzy: false,
    confidence: 0.6,
    confidenceLabel: "ALLEY_OFFSET",
    needsVerification: true,
    isImprecise: true,
    markerTone: "orange",
    method: "GEOMATH (APPROXIMATE)",
  };
}

/**
 * Build anchor cache key from query and context
 */
function buildAnchorCacheKey(query, expectedDistrict, mapContext) {
  const center = mapContext?.center;
  const lat = Number.isFinite(center?.lat) ? center.lat.toFixed(4) : "na";
  const lng = Number.isFinite(center?.lng) ? center.lng.toFixed(4) : "na";
  return `${normalize(query)}|${normalize(expectedDistrict || "")}|${lat},${lng}`;
}

/**
 * Fetch Photon results with caching
 */
async function fetchPhotonQueryWithCache(query, expectedDistrict, mapContext) {
  const cacheKey = buildAnchorCacheKey(query, expectedDistrict, mapContext);
  if (anchorQueryCache.has(cacheKey)) {
    return anchorQueryCache.get(cacheKey);
  }

  const center = mapContext?.center || null;
  const aggregated = [];

  try {
    const photon = await searchPhoton(query, center, 8);
    aggregated.push(...photon);
  } catch {
    // Continue if provider is unavailable
  }

  await sleep(ANCHOR_REQUEST_DELAY_MS);

  anchorQueryCache.set(cacheKey, aggregated);
  return aggregated;
}

/**
 * Search with broad retry: specific query -> broad query fallback
 */
async function searchAnchorQueryWithBroadRetry(targetNum, streetFragment, districtLabel, expectedDistrict, mapContext) {
  const specificQuery = districtLabel
    ? `${targetNum} ${streetFragment}, ${districtLabel}`
    : `${targetNum} ${streetFragment}`;
  const specific = await fetchPhotonQueryWithCache(specificQuery, expectedDistrict, mapContext);
  if (specific.length > 0) return specific;

  if (districtLabel) {
    const broadQuery = `${targetNum} ${streetFragment}`;
    return fetchPhotonQueryWithCache(broadQuery, expectedDistrict, mapContext);
  }
  return specific;
}

/**
 * Batch search phase: Execute all hierarchical layer queries in parallel
 * OPTIMIZATION: Promise.all to minimize RTT (Round Trip Time)
 */
async function parallelSearchPhase(hierarchicalQueries, center, mapContext) {
  const searchBatches = hierarchicalQueries.map(async (queryLayer) => {
    const foundNodeSlashCount = extractSlashCount(queryLayer);
    const peelDepthMeters = Math.max(0, (extractSlashCount(hierarchicalQueries[0]) - foundNodeSlashCount) * ALLEY_OFFSET_METERS);

    // Parallel Photon and Nominatim calls for THIS LAYER
    const [photonResults, nominatimResults] = await Promise.all([
      searchPhoton(queryLayer, center, 8).catch(() => []),
      searchNominatim(queryLayer, {
        limit: 8,
        countryCode: "vn",
        bounds: mapContext?.bounds,
      }).catch(() => []),
    ]);

    return {
      queryLayer,
      peelDepthMeters,
      photonResults,
      nominatimResults,
      mergedResults: [...photonResults, ...nominatimResults],
    };
  });

  const results = await Promise.all(searchBatches);
  
  // Apply global API delay after batch completion
  if (results.length > 0) await sleep(API_CALL_DELAY_MS);
  
  return results;
}

/**
 * Main Resolution Endpoint
 * Orchestrates: Cache Check -> Parallel Search -> Scoring -> Return
 */
export async function resolveLocation(inputValue, mapContext) {
  const raw = (inputValue || "").trim();
  if (!raw) return null;

  // CACHE CHECK: Return cached result if exact match exists
  const cacheKey = `${normalize(raw)}|${mapContext?.center?.lat.toFixed(4)}|${mapContext?.center?.lng.toFixed(4)}`;
  const cachedResult = locationResultCache.get(cacheKey);
  if (cachedResult) {
    return cachedResult;
  }

  // Coordinate validation (strict: requires decimal point)
  const parsed = extractCoordinates(raw);
  if (parsed) {
    const result = {
      ...parsed,
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
    locationResultCache.set(cacheKey, result);
    return result;
  }

  // Pre-normalize context to avoid repetitive calls in loops
  const center = mapContext?.center || null;
  const district = extractAreaAnchor(raw) || extractAreaHint(raw);
  const targetHouseNumber = extractQueryHouseNumber(raw);
  const originalSlashCount = extractSlashCount(raw);

  const hierarchicalQueries = buildHierarchicalQueries(raw);
  const usesHierarchicalFlow = hierarchicalQueries.length > 1;
  const alleyMeta = extractAlleyMeta(raw);

  // SEARCH PHASE (I/O): Parallel batch API calls for all hierarchical layers
  const layerSearchResults = await parallelSearchPhase(hierarchicalQueries, center, mapContext);

  // SCORING PHASE (CPU): Iterate through results and apply heuristics
  const allCollectedResults = [];

  for (const layerResult of layerSearchResults) {
    const { queryLayer, peelDepthMeters, mergedResults } = layerResult;
    
    allCollectedResults.push(...mergedResults);

    if (mergedResults.length === 0) {
      // Peel-and-search constraint: No results at this layer, continue to parent
      continue;
    }

    // Attempt 1: Exact match (slash or alley token)
    const exactMatch = findExactHouseMatch(mergedResults, queryLayer);
    if (exactMatch) {
      const exactBasePoint = mapToLatLng(exactMatch) || { lat: exactMatch.lat, lng: exactMatch.lng };
      const exactPoint = peelDepthMeters > 0
        ? computeAlleyOffsetResult(exactMatch, exactBasePoint, peelDepthMeters)
        : exactBasePoint;

      const result = {
        lat: exactPoint.lat,
        lng: exactPoint.lng,
        label: [exactMatch.houseNumber, exactMatch.street, exactMatch.district || exactMatch.city]
          .filter(Boolean)
          .join(" ")
          .trim() || raw,
        provider: `${(exactMatch.source || "source").toString().replace(/^./, (c) => c.toUpperCase())} (Exact)`,
        matchType: "exact",
        isInterpolated: false,
        isFuzzy: false,
        confidence: "high",
        needsVerification: false,
        isImprecise: false,
        markerTone: "default",
        method: usesHierarchicalFlow ? "PHOTON (HIERARCHICAL)" : "PHOTON (EXACT)",
      };
      locationResultCache.set(cacheKey, result);
      return result;
    }

    // Attempt 2: Interpolation (for numeric addresses without exact match)
    if (Number.isFinite(targetHouseNumber)) {
      const interpolationAttempt = await buildInterpolationCandidate(
        queryLayer,
        targetHouseNumber,
        district,
        mapContext,
        mergedResults,
        {
          extractStreetFragment,
          inferStreetFromResults,
          fetchPhotonQueryWithCache,
          searchAnchorQueryWithBroadRetry,
        }
      );
      if (interpolationAttempt) {
        locationResultCache.set(cacheKey, interpolationAttempt);
        return interpolationAttempt;
      }
    }

    // Attempt 3: Alley-aware resolution (Vietnamese "ngõ" addresses)
    const normalizedLayer = normalize(queryLayer);
    if (alleyMeta && (normalizedLayer.includes(`ngo ${alleyMeta.alleyNumber}`) || normalizedLayer.includes(`ngo${alleyMeta.alleyNumber}`))) {
      const depthDistance = peelDepthMeters > 0 ? peelDepthMeters : ALLEY_OFFSET_METERS;
      const alleyOffset = buildAlleyOffsetCandidate(mergedResults, alleyMeta, district, raw, depthDistance);
      if (alleyOffset) {
        locationResultCache.set(cacheKey, alleyOffset);
        return alleyOffset;
      }
    }
  }

  // FALLBACK: Fuzzy best-guess from all collected results
  const bestGuess = findBestMatch(allCollectedResults, raw, {
    expectedDistrict: district,
    areaMatchesAnchor,
    extractAreaAnchor,
    extractQueryHouseNumber,
  });

  if (bestGuess) {
    const result = {
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
    locationResultCache.set(cacheKey, result);
    return result;
  }

  return null;
}

/**
 * Get autocomplete suggestions
 */
export async function getAutocompleteSuggestions(query, mapContext) {
  const q = (query || "").trim();
  if (q.length < 2) return [];

  const center = mapContext?.center || null;
  const results = await searchPhoton(q, center, 8);
  return results.map((item) => ({
    ...item,
    label: [item.name, item.district || item.city].filter(Boolean).join(", ") || item.address,
  }));
}

/**
 * Route between two points
 */
export async function routeBetween(origin, destination) {
  try {
    return await fetchOsrmRoute(origin, destination);
  } catch {
    return null;
  }
}
