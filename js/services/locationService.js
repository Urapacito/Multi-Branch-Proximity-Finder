import { fetchOsrmRoute, searchNominatim, searchPhoton } from "../repositories/geoRepository.js";
import { GeoMath } from "./geoMath.js";

const API_CALL_DELAY_MS = 400;
const ANCHOR_REQUEST_DELAY_MS = API_CALL_DELAY_MS;
const INTERPOLATION_TIMEOUT_MS = 15000;
const ALLEY_OFFSET_METERS = 20;
const anchorQueryCache = new Map();

/**
 * LRU Cache for production-grade caching of location results.
 * Prevents redundant API calls for recently searched addresses.
 * Limit: 50 entries to balance memory and hit rate.
 */
class LRULocationCache {
  constructor(maxSize = 50) {
    this.maxSize = maxSize;
    this.cache = new Map();
    this.accessOrder = [];
  }

  get(key) {
    if (!this.cache.has(key)) return null;
    // Move accessed key to end (most recently used)
    this.accessOrder = this.accessOrder.filter(k => k !== key);
    this.accessOrder.push(key);
    return this.cache.get(key);
  }

  set(key, value) {
    if (this.cache.has(key)) {
      this.accessOrder = this.accessOrder.filter(k => k !== key);
    } else if (this.accessOrder.length >= this.maxSize) {
      // Evict least recently used (LRU)
      const lruKey = this.accessOrder.shift();
      this.cache.delete(lruKey);
    }
    this.cache.set(key, value);
    this.accessOrder.push(key);
  }

  clear() {
    this.cache.clear();
    this.accessOrder = [];
  }
}

const locationResultCache = new LRULocationCache(50);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function removeDiacritics(input) {
  return (input || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D");
}

function normalize(text) {
  return removeDiacritics(text).toLowerCase().trim();
}

function toTokens(text) {
  return normalize(text)
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function normalizeDistrictName(name) {
  return normalize(name).replace(/\s+/g, " ").trim();
}

function districtMatchesExpected(result, expectedDistrict) {
  if (!expectedDistrict) return true;

  const expected = normalizeDistrictName(expectedDistrict);
  const district = normalizeDistrictName(result.district || "");
  const city = normalizeDistrictName(result.city || "");
  const haystack = `${district} ${city}`.trim();

  if (!haystack) return false;
  return haystack.includes(expected);
}

function extractCoordinates(value) {
  const text = (value || "").trim();
  // REQUIREMENT: Must have a dot (.) to be coordinates. 
  // This ignores "56/1" but accepts "21.001, 105.802"
  const pair = text.match(/(-?\d+\.\d+)\s*[,;|/]\s*(-?\d+\.\d+)/);
  if (!pair) return null;

  const lat = Number(pair[1]);
  const lng = Number(pair[2]);
  
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

function parseHouseNumber(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  const match = text.match(/\d+/);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function extractHouseNumber(feature, streetHint = "") {
  const direct = parseHouseNumber(feature?.houseNumber);
  if (Number.isFinite(direct)) return direct;

  const name = String(feature?.name || feature?.raw?.properties?.name || "").trim();
  if (!name) return null;

  const leading = name.match(/^(\d+)\b/);
  if (leading) {
    const parsed = Number(leading[1]);
    if (Number.isFinite(parsed)) return parsed;
  }

  const ngoPattern = name.match(/\bngo\s*(\d+)\b/i);
  if (ngoPattern) {
    const parsed = Number(ngoPattern[1]);
    if (Number.isFinite(parsed)) return parsed;
  }

  if (streetHint) {
    const escapedStreet = streetHint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const dynamicPattern = new RegExp(`\\b(\\d+)\\s+${escapedStreet}\\b`, "i");
    const match = name.match(dynamicPattern);
    if (match) {
      const parsed = Number(match[1]);
      if (Number.isFinite(parsed)) return parsed;
    }
  }

  const fallback = name.match(/\b(\d+)\b/);
  if (fallback) {
    const parsed = Number(fallback[1]);
    if (Number.isFinite(parsed)) return parsed;
  }

  return null;
}

function mapToLatLng(item) {
  if (Number.isFinite(item?.lat) && Number.isFinite(item?.lng)) {
    return { lat: item.lat, lng: item.lng };
  }

  const coords = item?.raw?.geometry?.coordinates;
  if (Array.isArray(coords) && coords.length >= 2) {
    const lon = Number(coords[0]);
    const lat = Number(coords[1]);
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      // Photon geometry uses [lon, lat], convert to {lat, lng}.
      return { lat, lng: lon };
    }
  }

  return null;
}

function extractQueryHouseNumber(query) {
  return parseHouseNumber(query);
}

function extractStreetFragment(query) {
  const text = String(query || "").trim();
  if (!text) return "";

  const firstPart = text.split(",")[0] || text;
  return firstPart
    .replace(/\b\d+[a-z]?\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function inferStreetFromResults(results, targetHouse) {
  const withStreet = (results || [])
    .map((item) => ({
      street: (item.street || item.name || "").trim(),
      house: parseHouseNumber(item.houseNumber),
    }))
    .filter((item) => item.street);

  if (withStreet.length === 0) return "";

  if (Number.isFinite(targetHouse)) {
    const nearest = withStreet
      .filter((item) => Number.isFinite(item.house))
      .sort((a, b) => Math.abs(a.house - targetHouse) - Math.abs(b.house - targetHouse))[0];
    if (nearest?.street) return nearest.street;
  }

  return withStreet[0].street;
}

function extractAreaHint(query) {
  const parts = String(query || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 2) return null;
  return parts[1];
}

function extractAreaAnchor(query) {
  const parts = String(query || "").split(",");
  if (parts.length < 2) return null;
  // Joins Ward, District, City into one normalized anchor string
  return normalize(parts.slice(1).join(" "));
}

function dedupeStrings(values) {
  const seen = new Set();
  const output = [];

  for (const value of values || []) {
    const normalizedValue = String(value || "").replace(/\s+/g, " ").trim();
    if (!normalizedValue || seen.has(normalizedValue)) continue;
    seen.add(normalizedValue);
    output.push(normalizedValue);
  }

  return output;
}

export function decomposeAddress(input) {
  const text = String(input || "").replace(/\s+/g, " ").trim();
  if (!text) return [];

  const parts = text.split(",");
  const head = parts[0].trim();
  const tail = parts.slice(1).join(", ").trim();

  // 1. Handle "House ngõ Alley" (e.g., 38 ngõ 231)
  const ngoMatch = head.match(/^(\d+)\s+(?:ngo|ngõ)\s+(\d+)\b/i);
  if (ngoMatch) {
    const houseNum = ngoMatch[1];
    const alleyNum = ngoMatch[2];
    const fullToken = ngoMatch[0];

    return dedupeStrings([
      text, // Full: 38 ngõ 231 Tân Mai...
      `${head.replace(fullToken, "ngõ " + alleyNum)}, ${tail}`, // Parent Alley: ngõ 231 Tân Mai...
      `${head.replace(fullToken, houseNum)}, ${tail}` // Main Road: 38 Tân Mai...
    ]);
  }

  // 2. Handle Slashes (e.g., 56/1)
  const slashMatch = head.match(/^(\d+(?:\/\d+)+)\b/);
  if (slashMatch) {
    const fullToken = slashMatch[1];
    const segments = fullToken.split("/");
    const stack = [];
    for (let i = segments.length; i >= 1; i--) {
      const currentNumber = segments.slice(0, i).join("/");
      const newHead = head.replace(fullToken, currentNumber);
      stack.push(tail ? `${newHead}, ${tail}` : newHead);
    }
    return dedupeStrings(stack);
  }

  return [text];
}

function buildHierarchicalQueries(input) {
  return decomposeAddress(input);
}

function extractSlashCount(value) {
  const token = String(value || "").match(/\b\d+(?:\/\d+)*\b/)?.[0] || "";
  if (!token.includes("/")) return 0;
  return token.split("/").length - 1;
}

function extractAlleyMeta(input) {
  const head = String(input || "").split(",")[0] || "";
  const match = head.match(/\b(\d+)\s*(?:ngo|ngõ)\s*(\d+)\b/i);
  if (!match) return null;

  const houseNumber = Number(match[1]);
  const alleyNumber = Number(match[2]);
  if (!Number.isFinite(houseNumber) || !Number.isFinite(alleyNumber)) return null;

  return {
    houseNumber,
    alleyNumber,
  };
}

function featureContainsNumberToken(item, expectedNum) {
  if (!Number.isFinite(expectedNum)) return false;

  const rawText = [
    item?.houseNumber,
    item?.name,
    item?.street,
    item?.address,
    item?.raw?.properties?.name,
    item?.raw?.properties?.street,
  ]
    .filter(Boolean)
    .join(" ");

  if (!rawText) return false;

  const token = String(expectedNum);
  return new RegExp(`(^|\\D)${token}(\\D|$)`).test(normalize(rawText));
}

function extractLineSegment(item) {
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

function findPathSliceBetweenAnchors(pathPoints, anchorA, anchorB) {
  const points = GeoMath.flattenLatLngs(pathPoints);
  if (points.length < 2 || !anchorA || !anchorB) return null;

  const asLatLng = (p) => L.latLng(p.lat, p.lng);
  const a = asLatLng(anchorA);
  const b = asLatLng(anchorB);

  const nearestIndex = (target) => {
    let bestIdx = -1;
    let minDist = Number.POSITIVE_INFINITY;
    for (let i = 0; i < points.length; i += 1) {
      const d = points[i].distanceTo(target);
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

function haversineMeters(a, b) {
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

function pointIntoAlley(item, fallbackPoint, distanceMeters = ALLEY_OFFSET_METERS) {
  const pathPoints = extractGeometryPath(item);
  if (pathPoints.length >= 2) {
    const followed = GeoMath.followPathDistance(pathPoints, distanceMeters);
    if (followed) return followed;
  }

  const segment = extractLineSegment(item);
  if (!segment) return fallbackPoint;

  const segmentLength = haversineMeters(segment.start, segment.next);
  if (!Number.isFinite(segmentLength) || segmentLength <= 0) return fallbackPoint;

  const safeDistance = Number.isFinite(distanceMeters) ? Math.max(0, distanceMeters) : ALLEY_OFFSET_METERS;
  const ratio = Math.min(1, safeDistance / segmentLength);
  return {
    lat: segment.start.lat + (segment.next.lat - segment.start.lat) * ratio,
    lng: segment.start.lng + (segment.next.lng - segment.start.lng) * ratio,
  };
}

function buildAlleyOffsetCandidate(results, alleyMeta, expectedDistrict, rawQuery, distanceMeters = ALLEY_OFFSET_METERS) {
  if (!alleyMeta) return null;

  const alleyToken = `ngo ${alleyMeta.alleyNumber}`;
  const alleyResult = (results || []).find((item) => {
    if (!districtMatchesExpected(item, expectedDistrict)) return false;

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

  const offsetPoint = pointIntoAlley(alleyResult, alleyBasePoint, distanceMeters);
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

function areaMatchesAnchor(result, anchor) {
  if (!anchor) return true;

  const resultText = normalize([
    result.ward,
    result.district,
    result.city,
    result.suburb,
    result.city_district,
    result.town,
    result.village,
    result.address
  ].filter(Boolean).join(" "));

  // Return true if the result overlaps with your Ward/City anchor
  return resultText.includes(anchor) || anchor.includes(resultText);
}

function findExactHouseMatch(results, query) {
  // Extract either a slash token (56/1) OR a "ngõ" token (38 ngõ 231)
  const slashToken = query.match(/\b\d+(?:\/\d+)+\b/)?.[0];
  const ngoToken = query.match(/\b\d+\s+(?:ngo|ngõ)\s+\d+\b/i)?.[0];
  const needle = normalize(slashToken || ngoToken || "");
  
  if (!needle) return null;

  const anchor = extractAreaAnchor(query);

  for (const item of results) {
    const haystack = normalize([
      item?.houseNumber,
      item?.name,
      item?.street,
      item?.address,
      item?.raw?.properties?.name
    ].filter(Boolean).join(" "));

    // Check if the result contains the house/alley combo
    if (!haystack.includes(needle)) continue;
    if (anchor && !areaMatchesAnchor(item, anchor)) continue;

    return item;
  }
  return null;
}

function buildAnchorCacheKey(query, expectedDistrict, mapContext) {
  const center = mapContext?.center;
  const lat = Number.isFinite(center?.lat) ? center.lat.toFixed(4) : "na";
  const lng = Number.isFinite(center?.lng) ? center.lng.toFixed(4) : "na";
  return `${normalize(query)}|${normalize(expectedDistrict || "")}|${lat},${lng}`;
}

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
    // Continue if provider is unavailable.
  }

  await sleep(ANCHOR_REQUEST_DELAY_MS);

  anchorQueryCache.set(cacheKey, aggregated);
  return aggregated;
}

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

// Strict result filtering: exclude alleys, prioritize primary house type matches.
function filterStrictHouseResults(items, expectedNum, expectedDistrict) {
  if (!Array.isArray(items)) return [];

  // First pass: strict house type + number match (exclude alleys).
  const strictMatches = items.filter(
    (item) =>
      GeoMath.isStrictHouseMatch(item, expectedNum) &&
      GeoMath.validateAnchorContext(item, "", expectedDistrict)
  );
  if (strictMatches.length > 0) return strictMatches;

  // Fallback: any non-alley result with matching number and valid context.
  return items.filter(
    (item) =>
      !GeoMath.isAlleyResult(item) &&
      extractHouseNumber(item) === expectedNum &&
      GeoMath.validateAnchorContext(item, "", expectedDistrict)
  );
}

// Neighbor discovery: find two closest bounding house nodes (lower < target < upper).
// Returns both anchors only if they share the same district and are on the same road segment.
function findBoundingAnchors(items, targetNum, expectedDistrict) {
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

function pickValidAnchor(items, expectedNum, streetFragment, expectedDistrict) {
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

async function buildInterpolationCandidate(query, targetHouse, expectedDistrict, mapContext, seedResults = []) {
  let streetFragment = extractStreetFragment(query);
  if (!streetFragment) {
    streetFragment = inferStreetFromResults(seedResults, targetHouse);
  }
  if (!streetFragment) {
    return null;
  }

  const districtLabel = expectedDistrict || "";
  const startedAt = Date.now();

  // Initial exact target lookup in Photon-first flow.
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

  let anchorLower = null;
  let anchorUpper = null;

  for (let i = 2; i <= 30; i += 2) {
    if (Date.now() - startedAt > INTERPOLATION_TIMEOUT_MS) {
      break;
    }

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

    // Smart short-circuit: stop immediately once both anchors are found.
    if (anchorLower && anchorUpper) {
      break;
    }
  }

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

  // INTERPOLATE phase: Use strict neighbor discovery to create virtual node.
  const lowerNum = extractHouseNumber(anchorLower);
  const upperNum = extractHouseNumber(anchorUpper);

  if (!GeoMath.isLogicalSequence(lowerNum, targetHouse, upperNum)) {
    return null;
  }

  // Calculate interpolation with confidence score (0.8 for virtual nodes).
  let interpolatedResult = GeoMath.interpolateWithConfidence(
    { lat: anchorLower.lat, lng: anchorLower.lng },
    { lat: anchorUpper.lat, lng: anchorUpper.lng },
    lowerNum,
    targetHouse,
    upperNum,
    false // isExactMatch = false (virtual node)
  );

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

function scoreHouseNumberMatch(result, queryTokens, targetHouseNumber) {
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

function scoreDistrictMatch(result, queryTokens) {
  const districtText = normalize(`${result.district || ""} ${result.city || ""}`);
  if (!districtText) return 0;

  const districtTokens = toTokens(districtText);
  const hits = districtTokens.filter((t) => queryTokens.includes(t)).length;
  return hits >= 2 ? 24 : hits === 1 ? 10 : 0;
}

function scoreStreetMatch(result, queryTokens) {
  const streetTokens = toTokens(result.street || result.name || "");
  if (streetTokens.length === 0) return 0;

  const hits = streetTokens.filter((t) => queryTokens.includes(t)).length;
  if (hits === 0) return 0;

  const ratio = hits / streetTokens.length;
  if (ratio >= 0.7) return 28;
  if (ratio >= 0.4) return 16;
  return 8;
}

function scoreType(result) {
  const type = normalize(result.type);
  if (["house", "building", "amenity"].includes(type)) return 16;
  if (["bus_stop", "station", "public_transport"].includes(type)) return 14;
  if (["residential", "road"].includes(type)) return 4;
  return 0;
}

function hasStreetAndNumberInQuery(queryTokens) {
  const hasNumber = queryTokens.some((t) => /^\d+[a-z]?$/.test(t));
  const hasStreet = queryTokens.includes("quang") || queryTokens.includes("trung") || queryTokens.length >= 3;
  return hasNumber && hasStreet;
}

function shouldSnapToPoi(result, queryTokens) {
  if (!hasStreetAndNumberInQuery(queryTokens)) return false;

  const type = normalize(result.type);
  const poiLike = ["bus_stop", "building", "amenity"].includes(type);
  if (!poiLike) return false;

  return scoreStreetMatch(result, queryTokens) > 0;
}

export function findBestMatch(results, inputQuery, options = {}) {
  if (!Array.isArray(results) || results.length === 0) return null;

  // OPTIMIZATION: Pre-normalize query context to avoid repetitive normalize/toTokens in inner loops
  const queryNormalized = normalize(inputQuery);
  const queryTokens = toTokens(inputQuery);
  const targetHouseNumber = extractQueryHouseNumber(inputQuery);
  const anchor = options.expectedDistrict || extractAreaAnchor(inputQuery);
  const anchorNormalized = anchor ? normalize(anchor) : null;

  let best = null;
  let bestScore = -Infinity;

  // Single pass scoring: vectorized scoring context
  for (const item of results) {
    const isAreaMatch = areaMatchesAnchor(item, anchor);

    let score = 0;
    score += scoreType(item);
    score += scoreStreetMatch(item, queryTokens);
    score += scoreDistrictMatch(item, queryTokens);
    score += scoreHouseNumberMatch(item, queryTokens, targetHouseNumber);

    // THE SAFETY VALVE: Prevents the marker from leaving the territory
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

/**
 * Compute alley offset result with depth-aware geometry path following.
 * Modular helper to reduce cognitive load in main resolution flow.
 */
function computeAlleyOffsetResult(answerItem, fallbackPoint, depthMeters = ALLEY_OFFSET_METERS) {
  const pathPoints = extractGeometryPath(answerItem);
  if (pathPoints.length >= 2) {
    const followed = GeoMath.followPathDistance(pathPoints, depthMeters);
    if (followed) return followed;
  }

  const segment = extractLineSegment(answerItem);
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
 * Batch search phase: Execute all hierarchical layer queries in parallel.
 * OPTIMIZATION: Promise.all to minimize RTT (Round Trip Time).
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
  // Collect all results for fuzzy fallback while checking for exact matches
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
        mergedResults
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
  // Suggested safety filter for the fallback
  const localizedResults = allCollectedResults.filter(item => 
    !district || areaMatchesAnchor(item, district)
  );
  // FALLBACK: Fuzzy best-guess from all collected results
 const bestGuess = findBestMatch(
    localizedResults.length > 0 ? localizedResults : allCollectedResults, 
    raw, 
    { expectedDistrict: district });
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

export async function routeBetween(origin, destination) {
  try {
    return await fetchOsrmRoute(origin, destination);
  } catch {
    return null;
  }
}
