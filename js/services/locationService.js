import { fetchOsrmRoute as routeBetweenRaw, searchNominatim, searchPhoton } from "../repositories/geoRepository.js";
import * as Parser from "./modules/addressUtils.js";
import * as Scorer from "./modules/scoringEngine.js";
import * as Interpolator from "./modules/interpolationService.js";
import { locationResultCache } from "./modules/cacheManager.js";

const API_CALL_DELAY_MS = 400;
const ALLEY_OFFSET_METERS = 20;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function parallelSearchPhase(hierarchicalQueries, center, mapContext) {
  // 1. Create a "Search Batch" for every address layer simultaneously
  const batchPromises = hierarchicalQueries.map(async (queryLayer, index) => {
    const foundSlash = Parser.extractSlashCount(queryLayer);
    const rootSlash = Parser.extractSlashCount(hierarchicalQueries[0]);
    
    // Calculate how "deep" we are based on how many slashes were removed
    const peelDepthMeters = Math.max(0, (rootSlash - foundSlash) * ALLEY_OFFSET_METERS);

    // 2. Perform Racing Searches for each layer
    // searchPhoton now races .io and .de mirrors internally
    const [photonResults, nominatimResults] = await Promise.all([
      searchPhoton(queryLayer, center, 8).catch(() => []),
      searchNominatim(queryLayer, {
        limit: 8,
        countryCode: "vn",
        viewbox: mapContext?.bounds, // Use viewbox for Nominatim bias
      }).catch(() => []),
    ]);

    return {
      queryLayer,
      peelDepthMeters,
      mergedResults: [...photonResults, ...nominatimResults],
    };
  });

  // 3. Wait for all layers to return (The "Race of Races")
  const results = await Promise.all(batchPromises);

  // OPTIONAL: Only sleep if worried about hitting rate limits 
  // on Nominatim. If Photon is your primary, you can remove this.
  // if (results.length > 0) await sleep(API_CALL_DELAY_MS);

  return results;
}

/**
 * MAIN ENTRY POINT: Orchestrates the multi-stage resolution pipeline.
 */
export async function resolveLocation(inputValue, mapContext) {
  const raw = (inputValue || "").trim();
  if (!raw) return null;

  // 1. CACHE LAYER (Performance)
  const cacheKey = Parser.buildCacheKey(raw, mapContext);
  const cached = locationResultCache.get(cacheKey);
  if (cached) return cached;

  // 2. COORDINATE BYPASS (Manual Override)
  const coords = Parser.extractCoordinates(raw);
  if (coords) {
    const manual = Scorer.formatManualResult(coords, raw);
    locationResultCache.set(cacheKey, manual);
    return manual;
  }

  // 3. CONTEXT PREPARATION
  const center = mapContext?.center || null;
  const district = Parser.extractAreaAnchor(raw) || Parser.extractAreaHint(raw);
  const targetHouseNumber = Parser.parseHouseNumber(raw);
  const alleyMeta = Parser.extractAlleyMeta(raw);
  const hierarchicalQueries = Parser.decomposeAddress(raw);

  // 4. SEARCH PHASE (I/O - Parallel API Calls)
  const layerSearchResults = await parallelSearchPhase(hierarchicalQueries, center, mapContext);

  // 5. RESOLUTION PHASE (Logic - Ordered by Confidence)
  const allCollectedResults = [];

  for (const layer of layerSearchResults) {
    allCollectedResults.push(...layer.mergedResults);
    if (layer.mergedResults.length === 0) continue;

    // A. EXACT MATCH (Highest Confidence)
    const exactMatch = Parser.findExactHouseMatch(layer.mergedResults, layer.queryLayer);
    if (exactMatch) {
      const result = Scorer.processExactResult(exactMatch, layer.peelDepthMeters, raw);
      locationResultCache.set(cacheKey, result);
      return result;
    }

    // B. INTERPOLATION (Smart Fallback)
    if (Number.isFinite(targetHouseNumber)) {
      const interp = await Interpolator.buildInterpolationCandidate(
        layer.queryLayer,
        targetHouseNumber,
        district,
        mapContext,
        layer.mergedResults,
        {
          extractStreetFragment: Parser.extractStreetFragment,
          inferStreetFromResults: Parser.inferStreetFromResults,
          fetchPhotonQueryWithCache: async (query, expectedDistrict, context) => {
            return searchPhoton(query, context?.center || null, 8);
          },
          searchAnchorQueryWithBroadRetry: async (targetNum, streetFragment, districtLabel, expectedDistrict, context) => {
            const specificQuery = districtLabel ? `${targetNum} ${streetFragment}, ${districtLabel}` : `${targetNum} ${streetFragment}`;
            const specific = await searchPhoton(specificQuery, context?.center || null, 8);
            if (specific.length > 0) return specific;
            if (districtLabel) {
              return searchPhoton(`${targetNum} ${streetFragment}`, context?.center || null, 8);
            }
            return specific;
          },
          searchPhoton,
          searchNominatim,
        }
      );
      if (interp) {
        locationResultCache.set(cacheKey, interp);
        return interp;
      }
    }

    // C. ALLEY OFFSET (Vietnamese specific "ngõ" logic)
    if (alleyMeta && Parser.isAlleyQuery(layer.queryLayer, alleyMeta)) {
      const depthDistance = layer.peelDepthMeters > 0 ? layer.peelDepthMeters : ALLEY_OFFSET_METERS;
      const alleyResult = Scorer.processExactResult({
        ...Scorer.findBestMatch(layer.mergedResults, raw, {
          expectedDistrict: district,
          areaMatchesAnchor: Parser.areaMatchesAnchor,
          extractAreaAnchor: Parser.extractAreaAnchor,
          extractQueryHouseNumber: Parser.extractQueryHouseNumber,
        }),
        source: "GEOMATH_ALLEY_OFFSET",
      }, depthDistance, raw);
      if (alleyResult) {
        locationResultCache.set(cacheKey, alleyResult);
        return alleyResult;
      }
    }
  }

  // 6. FUZZY FALLBACK (Best Guess)
  const bestGuess = Scorer.findBestMatch(allCollectedResults, raw, {
    expectedDistrict: district,
    areaMatchesAnchor: Parser.areaMatchesAnchor,
    extractAreaAnchor: Parser.extractAreaAnchor,
    extractQueryHouseNumber: Parser.extractQueryHouseNumber,
  });
  if (bestGuess) {
    const result = Scorer.formatFuzzyResult(bestGuess);
    locationResultCache.set(cacheKey, result);
    return result;
  }

  return null;
}

// Keep thin wrappers for the other public methods
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

export async function routeBetween(origin, destination, options = {}) {
  try {
    // 1. Call the racing repository function
    const data = await routeBetweenRaw([origin, destination], null, options);

    if (!data?.routes || data.routes.length === 0) {
      return null;
    }

    const primary = data.routes[0];

    // 2. Return the structure main.js expects
    return {
      geometry: primary.geometry, // This is the GeoJSON for the blue line
      distanceKm: primary.distance / 1000, // OSRM is in meters
      durationMin: primary.duration / 60,   // OSRM is in seconds
      weight: primary.weight,
      method: primary.method || (primary.isFerryFallback ? "FERRY_FALLBACK" : "OSRM"),
      isFerryFallback: Boolean(primary.isFerryFallback || data.isFerryFallback),
    };
  } catch (error) {
    console.error("Routing calculation failed:", error);
    return null;
  }
}