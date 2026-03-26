/**
 * Interpolation Service Module
 * Heavy geometric interpolation logic for address placement
 */

import { GeoMath } from "../geoMath.js";
import { extractHouseNumber, mapToLatLng } from "./addressUtils.js";

const INTERPOLATION_TIMEOUT_MS = 15000;

/**
 * Extract single line segment from feature geometry
 */
export function extractLineSegment(item) {
  const geometry = item?.raw?.geometry;
  if (!geometry) return null;

  let coordinates = null;
  if (geometry.type === "LineString") {
    coordinates = geometry.coordinates;
  } else if (geometry.type === "MultiLineString") {
    coordinates = geometry.coordinates?.[0];
  }

  if (!Array.isArray(coordinates) || coordinates.length < 2) return null;

  const start = coordinates[0] || [];
  const next = coordinates[1] || [];
  const startLng = Number(start[0]);
  const startLat = Number(start[1]);
  const nextLng = Number(next[0]);
  const nextLat = Number(next[1]);

  if (![startLat, startLng, nextLat, nextLng].every(Number.isFinite)) return null;

  return {
    start: { lat: startLat, lng: startLng },
    next: { lat: nextLat, lng: nextLng },
  };
}

/**
 * Extract full geometry path (multiple segments)
 */
export function extractGeometryPath(item) {
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
 * Find path slice between two anchors
 */
export function findPathSliceBetweenAnchors(pathPoints, anchorA, anchorB) {
  const points = GeoMath.flattenLatLngs(pathPoints);
  if (points.length < 2 || !anchorA || !anchorB) return null;

  const distanceMeters = (p1, p2) => {
    const toRad = (deg) => (deg * Math.PI) / 180;
    const earthRadiusMeters = 6371000;
    const dLat = toRad(p2.lat - p1.lat);
    const dLng = toRad(p2.lng - p1.lng);
    const lat1 = toRad(p1.lat);
    const lat2 = toRad(p2.lat);
    const sinLat = Math.sin(dLat / 2);
    const sinLng = Math.sin(dLng / 2);
    const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;
    return 2 * earthRadiusMeters * Math.asin(Math.min(1, Math.sqrt(h)));
  };

  const nearestIndex = (target) => {
    let bestIdx = -1;
    let minDist = Number.POSITIVE_INFINITY;
    for (let i = 0; i < points.length; i += 1) {
      const d = distanceMeters(points[i], target);
      if (d < minDist) {
        minDist = d;
        bestIdx = i;
      }
    }
    return bestIdx;
  };

  const aIdx = nearestIndex(a);
  const bIdx = nearestIndex(b);
  if (aIdx === -1 || bIdx === -1) return null;

  if (aIdx <= bIdx) return points.slice(aIdx, bIdx + 1);
  return points.slice(bIdx, aIdx + 1).reverse();
}

/**
 * Calculate Haversine distance in meters
 */
export function haversineMeters(a, b) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const earthRadiusMeters = 6371000;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;
  return 2 * earthRadiusMeters * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Filter results to strict house type + number matches (no alleys)
 */
export function filterStrictHouseResults(items, expectedNum, expectedDistrict) {
  if (!Array.isArray(items)) return [];

  const strictMatches = items.filter(
    (item) =>
      GeoMath.isStrictHouseMatch(item, expectedNum) &&
      GeoMath.validateAnchorContext(item, "", expectedDistrict)
  );
  if (strictMatches.length > 0) return strictMatches;

  return items.filter(
    (item) =>
      !GeoMath.isAlleyResult(item) &&
      extractHouseNumber(item) === expectedNum &&
      GeoMath.validateAnchorContext(item, "", expectedDistrict)
  );
}

/**
 * Find two closest bounding house nodes (lower < target < upper)
 */
export function findBoundingAnchors(items, targetNum, expectedDistrict) {
  if (!Array.isArray(items) || items.length === 0) return { lower: null, upper: null };

  const validCandidates = items
    .filter((item) => !GeoMath.isAlleyResult(item))
    .map((item) => ({
      ...item,
      houseNum: extractHouseNumber(item),
      latLng: mapToLatLng(item),
    }))
    .filter(
      (item) =>
        Number.isFinite(item.houseNum) &&
        item.latLng &&
        Number.isFinite(item.latLng.lat) &&
        Number.isFinite(item.latLng.lng) &&
        GeoMath.validateAnchorContext(item, "", expectedDistrict)
    );

  let lower = null;
  let upper = null;

  for (const candidate of validCandidates) {
    if (candidate.houseNum < targetNum) {
      if (!lower || candidate.houseNum > lower.houseNum) {
        lower = candidate;
      }
    } else if (candidate.houseNum > targetNum) {
      if (!upper || candidate.houseNum < upper.houseNum) {
        upper = candidate;
      }
    }
  }

  return { lower, upper };
}

/**
 * Pick valid anchor from results
 */
export function pickValidAnchor(items, expectedNum, streetFragment, expectedDistrict) {
  const filtered = filterStrictHouseResults(items, expectedNum, expectedDistrict);
  if (filtered.length === 0) return null;

  const candidate = filtered[0];
  const latLng = mapToLatLng(candidate);
  if (!latLng) return null;

  return {
    ...candidate,
    houseNumber: extractHouseNumber(candidate),
    lat: latLng.lat,
    lng: latLng.lng,
  };
}

/**
 * Build interpolation candidate (virtual house node) between two anchors
 * This is the heavy lifting: finds neighbors and interpolates position
 */
export async function buildInterpolationCandidate(
  query,
  targetHouse,
  expectedDistrict,
  mapContext,
  seedResults,
  deps = {}
) {
  const {
    extractStreetFragment,
    inferStreetFromResults,
    fetchPhotonQueryWithCache,
    searchAnchorQueryWithBroadRetry,
    searchPhoton,
    searchNominatim,
  } = deps;
  
  if (!extractStreetFragment || !inferStreetFromResults || !fetchPhotonQueryWithCache || !searchAnchorQueryWithBroadRetry || !searchPhoton || !searchNominatim) {
    throw new Error("buildInterpolationCandidate requires dependency injection");
  }

  let streetFragment = extractStreetFragment(query);
  if (!streetFragment) {
    streetFragment = inferStreetFromResults(seedResults, targetHouse);
  }
  if (!streetFragment) {
    return null;
  }

  const districtLabel = expectedDistrict || "";
  const startedAt = Date.now();

  // PHASE 1: Exact target lookup
  const exactQuery = districtLabel
    ? `${targetHouse} ${streetFragment}, ${districtLabel}`
    : `${targetHouse} ${streetFragment}`;
  const exactResults = await fetchPhotonQueryWithCache(exactQuery, expectedDistrict, mapContext);
  const exactAnchor = pickValidAnchor(exactResults, targetHouse, streetFragment, expectedDistrict);
  
  if (exactAnchor) {
    return {
      lat: exactAnchor.lat,
      lng: exactAnchor.lng,
      label: [exactAnchor.houseNumber, exactAnchor.street, exactAnchor.district || exactAnchor.city]
        .filter(Boolean)
        .join(" ")
        .trim() || query,
      provider: "PHOTON_EXACT",
      matchType: "exact",
      isInterpolated: false,
      isFuzzy: false,
      confidence: "high",
      needsVerification: false,
      isImprecise: false,
      markerTone: "default",
      method: "PHOTON (EXACT)",
    };
  }

  // PHASE 2: Find lower and upper anchor neighbors
  let anchorLower = null;
  let anchorUpper = null;

  for (let i = 2; i <= 30; i += 2) {
    if (Date.now() - startedAt > INTERPOLATION_TIMEOUT_MS) break;

    if (!anchorLower) {
      const lowerNum = targetHouse - i;
      if (lowerNum > 0) {
        const lowerResults = await searchAnchorQueryWithBroadRetry(
          lowerNum,
          streetFragment,
          districtLabel,
          expectedDistrict,
          mapContext
        );
        anchorLower = pickValidAnchor(lowerResults, lowerNum, streetFragment, expectedDistrict) || null;
      }
    }

    if (!anchorUpper) {
      const upperNum = targetHouse + i;
      const upperResults = await searchAnchorQueryWithBroadRetry(
        upperNum,
        streetFragment,
        districtLabel,
        expectedDistrict,
        mapContext
      );
      anchorUpper = pickValidAnchor(upperResults, upperNum, streetFragment, expectedDistrict) || null;
    }

    if (anchorLower && anchorUpper) break;
  }

  // PHASE 3: Single anchor fallback
  if (!anchorLower || !anchorUpper) {
    const singleAnchor = anchorLower || anchorUpper;
    if (!singleAnchor) return null;

    return {
      lat: singleAnchor.lat,
      lng: singleAnchor.lng,
      label: [`${targetHouse}`, streetFragment, singleAnchor.district || expectedDistrict || ""]
        .filter(Boolean)
        .join(" ")
        .trim() || query,
      provider: "GEOMATH_APPROXIMATE_ANCHOR",
      matchType: "approximate",
      isApproximate: true,
      isInterpolated: false,
      isFuzzy: false,
      confidence: 0.7,
      confidenceLabel: "SINGLE_ANCHOR",
      needsVerification: true,
      isImprecise: true,
      markerTone: "orange",
      method: "GEOMATH (APPROXIMATE)",
    };
  }

  // PHASE 4: Geometric interpolation between anchors
  const lowerNum = extractHouseNumber(anchorLower);
  const upperNum = extractHouseNumber(anchorUpper);

  if (!GeoMath.isLogicalSequence(lowerNum, targetHouse, upperNum)) {
    return null;
  }

  let interpolatedResult = GeoMath.interpolateWithConfidence(
    { lat: anchorLower.lat, lng: anchorLower.lng },
    { lat: anchorUpper.lat, lng: anchorUpper.lng },
    lowerNum,
    targetHouse,
    upperNum,
    false
  );

  // PHASE 5: Path-follow interpolation (use curved geometry if available)
  const ratio = GeoMath.interpolationRatio(lowerNum, targetHouse, upperNum);
  const lowerPath = extractGeometryPath(anchorLower);
  const upperPath = extractGeometryPath(anchorUpper);
  const mergedPath = [...lowerPath, ...upperPath];
  const pathSlice = findPathSliceBetweenAnchors(
    mergedPath,
    { lat: anchorLower.lat, lng: anchorLower.lng },
    { lat: anchorUpper.lat, lng: anchorUpper.lng }
  );

  if (Number.isFinite(ratio) && pathSlice && pathSlice.length >= 2) {
    const totalDistance = pathSlice.reduce((sum, point, index) => {
      if (index === 0) return sum;
      return sum + pathSlice[index - 1].distanceTo(point);
    }, 0);

    if (totalDistance > 0) {
      const curvedPoint = GeoMath.followPathDistance(pathSlice, totalDistance * ratio);
      if (curvedPoint) {
        interpolatedResult = {
          ...(interpolatedResult || {}),
          lat: curvedPoint.lat,
          lng: curvedPoint.lng,
          confidence: interpolatedResult?.confidence ?? 0.8,
          ratio,
        };
      }
    }
  }

  if (!interpolatedResult) {
    return null;
  }

  const label = [`${targetHouse}`, streetFragment, anchorLower.district || anchorUpper.district || expectedDistrict || ""]
    .filter(Boolean)
    .join(" ")
    .trim() || query;

  return {
    lat: interpolatedResult.lat,
    lng: interpolatedResult.lng,
    label,
    provider: "GEOMATH_INTERPOLATED",
    matchType: "interpolated",
    isInterpolated: true,
    isFuzzy: false,
    confidence: interpolatedResult.confidence,
    confidenceLabel: "INTERPOLATED",
    needsVerification: true,
    isImprecise: true,
    markerTone: "orange",
    method: "PHOTON (HIERARCHICAL)",
  };
}
