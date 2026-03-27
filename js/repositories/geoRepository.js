const PHOTON_ENDPOINTS = [
  "https://photon.komoot.io/api",
  "https://photon.komoot.de/api",
];

const NOMINATIM_ENDPOINTS = [
  "https://nominatim.openstreetmap.org/search",
  "https://nominatim.osm.ch/search",
];

const OSRM_ENDPOINTS_BY_MODE = {
  car: [
    "https://routing.openstreetmap.de/routed-car/route/v1/driving",
    "https://router.project-osrm.org/route/v1/driving",
  ],
  motorcycle: [
    "https://routing.openstreetmap.de/routed-bike/route/v1/bicycle",
  ],
};

const ROUTING_DOMAINS = ["project-osrm.org", "openstreetmap.de"];

function withTimeout(ms = 12000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(id),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfterMs(value) {
  if (!value) return 0;

  const asSeconds = Number(value);
  if (Number.isFinite(asSeconds)) {
    return Math.max(0, asSeconds * 1000);
  }

  const asDate = Date.parse(value);
  if (Number.isFinite(asDate)) {
    return Math.max(0, asDate - Date.now());
  }

  return 0;
}

async function raceJsonFetch(urls, options = {}) {
  const controllers = urls.map(() => new AbortController());
  
  const promises = urls.map(async (url, i) => {
    try {
      const response = await fetch(url, {
        ...options,
        signal: controllers[i].signal
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      
      // CRITICAL: Parse the data BEFORE aborting others
      const data = await response.json();

      // SUCCESS: Now it's safe to cancel the slow mirrors
      controllers.forEach((ctrl, idx) => {
        if (idx !== i) ctrl.abort();
      });
      
      return data;
    } catch (err) {
      // Ignore abort errors in the console
      if (err.name === 'AbortError') return new Promise(() => {}); 
      throw err;
    }
  });

  return Promise.any(promises);
}

function mapPhotonFeature(feature) {
  const coords = feature?.geometry?.coordinates;
  if (!Array.isArray(coords) || coords.length < 2) return null;

  const p = feature.properties || {};
  const name = p.name || p.street || p.city || "Unknown";
  const street = p.street || "";
  const district = p.district || p.suburb || p.county || "";
  const city = p.city || p.county || p.state || "";
  const country = p.country || "";
  const houseNumber = p.housenumber || "";
  const address = [houseNumber, street, district || city, country].filter(Boolean).join(", ");

  return {
    lat: Number(coords[1]),
    lng: Number(coords[0]),
    name,
    street,
    district,
    city,
    country,
    houseNumber,
    type: p.type || "",
    source: "photon",
    address,
    raw: feature,
  };
}

function mapNominatimItem(item) {
  const address = item.address || {};
  const district = address.city_district || address.suburb || address.county || "";
  const city = address.city || address.town || address.county || "";

  return {
    lat: Number(item.lat),
    lng: Number(item.lon),
    name: item.name || item.display_name?.split(",")[0] || "Unknown",
    street: address.road || address.pedestrian || "",
    district,
    city,
    country: address.country || "",
    houseNumber: address.house_number || "",
    type: item.type || item.class || "",
    source: "nominatim",
    address: item.display_name || "",
    extratags: item.extratags || {},
    raw: item,
  };
}

function buildPhotonUrls(query, mapCenter, limit) {
  const params = new URLSearchParams();
  params.set("q", query);
  params.set("limit", String(limit));
  params.set("lang", "en");

  if (mapCenter) {
    params.set("lat", String(mapCenter.lat));
    params.set("lon", String(mapCenter.lng));
  }

  return PHOTON_ENDPOINTS.map((base) => `${base}/?${params.toString()}`);
}

function buildNominatimUrls(query, opts = {}) {
  const params = new URLSearchParams();
  params.set("q", query);
  params.set("format", "json");
  params.set("addressdetails", "1");
  params.set("extratags", "1");
  params.set("accept-language", "en");
  params.set("email", opts.contactEmail || "geospatial-maintainer@example.com");
  params.set("limit", String(opts.limit || 8));

  if (opts.countryCode) params.set("countrycodes", opts.countryCode);

  if (opts.bounds) {
    const { west, north, east, south } = opts.bounds;
    params.set("viewbox", `${west},${north},${east},${south}`);
    params.set("bounded", "1");
  }

  return NOMINATIM_ENDPOINTS.map((base) => `${base}?${params.toString()}`);
}

function normalizePoint(point) {
  if (!point || typeof point !== "object") return null;

  const lat = Number(point.lat);
  const lng = Number(point.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  return { lat, lng };
}

function normalizeRoutePoints(inputPoints, maybeDestination) {
  if (Array.isArray(inputPoints)) {
    return inputPoints.map(normalizePoint).filter(Boolean);
  }

  return [normalizePoint(inputPoints), normalizePoint(maybeDestination)].filter(Boolean);
}

function buildOsrmUrls(points, options = {}) {
  const normalizedMode = options.mode === "motorcycle" ? "motorcycle" : (options.mode === "car" ? "car" : "car");
  const endpoints = OSRM_ENDPOINTS_BY_MODE[normalizedMode] || OSRM_ENDPOINTS_BY_MODE.car;
  const routeParams = new URLSearchParams({
    overview: "full",
    geometries: "geojson",
    alternatives: "false",
    steps: "false",
  });

  if (normalizedMode === "motorcycle") {
    routeParams.set("continue_straight", "false");
  }

  const coordinateString = points.map((point) => `${point.lng},${point.lat}`).join(";");
  return endpoints.map((base) => `${base}/${coordinateString}?${routeParams.toString()}`);
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

function buildFerryFallbackRoute(points, mode = "driving") {
  const coordinates = points.map((point) => [point.lng, point.lat]);
  let distanceM = 0;
  for (let i = 1; i < points.length; i += 1) {
    distanceM += haversineMeters(points[i - 1], points[i]);
  }

  // Conservative speed profile for mixed land + ferry transfer estimate.
  const speedMps = mode === "motorcycle" ? 9.0 : 8.0;
  const durationS = distanceM > 0 ? distanceM / speedMps : 0;

  return {
    routes: [
      {
        geometry: {
          type: "LineString",
          coordinates,
        },
        distance: distanceM,
        duration: durationS,
        weight: durationS,
        isFerryFallback: true,
        method: "FERRY_FALLBACK",
      },
    ],
    code: "Ok",
    isFerryFallback: true,
  };
}

export async function searchPhoton(query, mapCenter, limit = 8) {
  const urls = buildPhotonUrls(query, mapCenter, limit);
  try {
    const data = await raceJsonFetch(urls, { method: "GET" });
    const features = Array.isArray(data?.features) ? data.features : [];
    return features.map(mapPhotonFeature).filter(Boolean);
  } catch (error) {
    return [];
  }
}

export async function searchNominatim(query, options = {}) {
  const urls = buildNominatimUrls(query, options);
  try {
    const data = await fetchJsonWithFallback(urls, {
      ...options,
      maxRetriesPerUrl: 2,
      userAgent: options.userAgent || "multi-branch-proximity-finder/1.0 (contact: geospatial-maintainer@example.com)",
    });
    const list = Array.isArray(data) ? data : [];
    return list.map(mapNominatimItem);
  } catch (error) {
    const message = String(error?.message || "").toLowerCase();
    const isCorsLike = message.includes("cors") || message.includes("failed to fetch") || message.includes("network");
    const isServerBusy = message.includes("429") || message.includes("server busy");

    if (isServerBusy) {
      throw new Error("Server Busy: Nominatim is rate limiting requests. Please wait and retry.");
    }

    if (isCorsLike || options.fallbackToPhoton !== false) {
      const center = options.mapCenter || null;
      const photonFallback = await searchPhoton(query, center, options.limit || 8);
      return photonFallback.map((item) => ({
        ...item,
        source: "photon-fallback",
      }));
    }

    throw error;
  }
}

export async function fetchOsrmRoute(inputPoints, maybeDestination, options = {}) {
  const points = normalizeRoutePoints(inputPoints, maybeDestination);
  
  if (points.length < 2) {
    throw new Error("ROUTING_INVALID_POINTS: At least 2 valid coordinates are required.");
  }

  const urls = buildOsrmUrls(points, options);

  try {
    // We use the new raceJsonFetch we created for Photon!
    // This fires requests to all OSRM mirrors simultaneously.
    const data = await raceJsonFetch(urls, {
      method: "GET",
      timeoutMs: 8000, // Routing can take a bit longer than geocoding
    });

    const hasPrimary = Array.isArray(data?.routes) && data.routes.length > 0;
    if (!hasPrimary && options.allowFerry !== false) {
      return buildFerryFallbackRoute(points, options.mode || "driving");
    }

    return data;
  } catch (error) {
    if (options.allowFerry !== false) {
      return buildFerryFallbackRoute(points, options.mode || "driving");
    }
    const reason = error?.message ? String(error.message) : "Unknown routing failure.";
    throw new Error(`ROUTING_REQUEST_FAILED: ${reason}`);
  }
}