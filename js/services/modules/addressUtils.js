/**
 * Address Utilities Module
 * String manipulation, normalization, and Vietnamese-specific address parsing
 */

/**
 * Remove Vietnamese diacritics and normalize text
 */
export function removeDiacritics(input) {
  return (input || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D");
}

/**
 * Normalize text to lowercase and trim
 */
export function normalize(text) {
  return removeDiacritics(text).toLowerCase().trim();
}

/**
 * Extract tokens from normalized text
 */
export function toTokens(text) {
  return normalize(text)
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Normalize district names with extra space handling
 */
export function normalizeDistrictName(name) {
  return normalize(name).replace(/\s+/g, " ").trim();
}

/**
 * Helper to deduplicate strings while preserving order
 */
export function dedupeStrings(values) {
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

/**
 * Extract GPS coordinates from human-readable input
 * REQUIREMENT: Must have decimal point to be treated as coordinates
 * This prevents "56/1" from being misidentified as lat/lng
 */
export function extractCoordinates(value) {
  const text = (value || "").trim();
  const pair = text.match(/(-?\d+\.\d+)\s*[,;|/]\s*(-?\d+\.\d+)/);
  if (!pair) return null;

  const lat = Number(pair[1]);
  const lng = Number(pair[2]);
  
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

/**
 * Parse house number from string
 */
export function parseHouseNumber(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  const match = text.match(/\d+/);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Extract house number from feature object, with optional street name hint
 */
export function extractHouseNumber(feature, streetHint = "") {
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

/**
 * Extract query house number
 */
export function extractQueryHouseNumber(query) {
  return parseHouseNumber(query);
}

// Backward-compatible alias requested by coordinator naming contract.
export function parseHouseNumberFromQuery(query) {
  return parseHouseNumber(query);
}

/**
 * Extract street fragment from query (first part before comma)
 */
export function extractStreetFragment(query) {
  const text = String(query || "").trim();
  if (!text) return "";

  const firstPart = text.split(",")[0] || text;
  return firstPart
    .replace(/\b\d+[a-z]?\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Infer street name from search results
 */
export function inferStreetFromResults(results, targetHouse) {
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

/**
 * Extract area hint (first item after comma)
 */
export function extractAreaHint(query) {
  const parts = String(query || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 2) return null;
  return parts[1];
}

/**
 * Extract area anchor (everything after first comma, normalized)
 * This is used for geographic bounded searches (Ward/District/City)
 */
export function extractAreaAnchor(query) {
  const parts = String(query || "").split(",");
  if (parts.length < 2) return null;
  return normalize(parts.slice(1).join(" "));
}

/**
 * Decompose Vietnamese address into hierarchical search stack
 * Handles both "House ngõ Alley" format and "House/Sub/Sub" format
 * Preserves road and ward context through the entire stack
 */
export function decomposeAddress(input) {
  const text = String(input || "").replace(/\s+/g, " ").trim();
  if (!text) return [];

  const parts = text.split(",");
  const head = parts[0].trim();
  const tail = parts.slice(1).join(", ").trim();

  // 1. Handle Vietnamese alley notation: "House ngõ Alley" (e.g., 38 ngõ 231)
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

  // 2. Handle hierarchical slash notation: "House/Sub/Sub" (e.g., 56/1/2)
  const slashMatch = head.match(/^(\d+(?:\/\d+)+)\b/);
  if (slashMatch) {
    const fullToken = slashMatch[1];
    const segments = fullToken.split("/");
    const stack = [];
    
    // Build stack from most specific to broadest by peeling off trailing slashes
    for (let i = segments.length; i >= 1; i--) {
      const currentNumber = segments.slice(0, i).join("/");
      const newHead = head.replace(fullToken, currentNumber);
      stack.push(tail ? `${newHead}, ${tail}` : newHead);
    }
    return dedupeStrings(stack);
  }

  return [text];
}

/**
 * Build hierarchical queries by decomposing input address
 */
export function buildHierarchicalQueries(input) {
  return decomposeAddress(input);
}

/**
 * Return true when query contains alley marker (ngo + alley number)
 */
export function isAlleyQuery(query, alleyMeta) {
  if (!alleyMeta || !Number.isFinite(alleyMeta.alleyNumber)) return false;
  const normalized = normalize(query);
  return normalized.includes(`ngo ${alleyMeta.alleyNumber}`) || normalized.includes(`ngo${alleyMeta.alleyNumber}`);
}

/**
 * Build a stable cache key from raw query and map context center (4 decimals)
 */
export function buildCacheKey(raw, context) {
  const center = context?.center;
  const lat = Number.isFinite(center?.lat) ? center.lat.toFixed(4) : "na";
  const lng = Number.isFinite(center?.lng) ? center.lng.toFixed(4) : "na";
  return `${raw}|${lat}|${lng}`;
}

/**
 * Extract slash count from house number token
 * Used to compute peel depth for alley offset calculation
 */
export function extractSlashCount(value) {
  const token = String(value || "").match(/\b\d+(?:\/\d+)*\b/)?.[0] || "";
  if (!token.includes("/")) return 0;
  return token.split("/").length - 1;
}

/**
 * Extract Vietnamese alley metadata from address
 * Returns {houseNumber, alleyNumber} or null
 */
export function extractAlleyMeta(input) {
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

/**
 * Check if feature contains expected numeric token
 */
export function featureContainsNumberToken(item, expectedNum) {
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

/**
 * Convert feature to lat/lng point
 */
export function mapToLatLng(item) {
  if (Number.isFinite(item?.lat) && Number.isFinite(item?.lng)) {
    return { lat: item.lat, lng: item.lng };
  }

  const coords = item?.raw?.geometry?.coordinates;
  if (Array.isArray(coords) && coords.length >= 2) {
    const lon = Number(coords[0]);
    const lat = Number(coords[1]);
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      return { lat, lng: lon };
    }
  }

  return null;
}

/**
 * Check if result matches given area anchor (Ward/District/City)
 */
export function areaMatchesAnchor(result, anchor) {
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

  return resultText.includes(anchor) || anchor.includes(resultText);
}

/**
 * Find exact house/alley match from results
 * Handles both slash notation (56/1) and ngõ notation (38 ngõ 231)
 */
export function findExactHouseMatch(results, query) {
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

    if (!haystack.includes(needle)) continue;
    if (anchor && !areaMatchesAnchor(item, anchor)) continue;

    return item;
  }
  return null;
}
