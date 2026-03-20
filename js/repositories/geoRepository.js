const PHOTON_ENDPOINTS = [
  "https://photon.komoot.io/api",
  "https://photon.komoot.de/api",
];

const NOMINATIM_ENDPOINTS = [
  "https://nominatim.openstreetmap.org/search",
  "https://nominatim.osm.ch/search",
];

const OSRM_ENDPOINTS = [
  "https://router.project-osrm.org/route/v1/driving",
  "https://routing.openstreetmap.de/routed-car/route/v1/driving",
];

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

async function fetchJsonWithFallback(urls, options = {}) {
  let lastError = null;
  const maxRetriesPerUrl = Number.isFinite(options.maxRetriesPerUrl) ? options.maxRetriesPerUrl : 1;

  for (const url of urls) {
    let isRoutingRequest = false;
    try {
      const hostname = new URL(url).hostname.toLowerCase();
      isRoutingRequest = ROUTING_DOMAINS.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
    } catch {
      isRoutingRequest = false;
    }

    const method = String(options.method || "GET").toUpperCase();

    for (let attempt = 0; attempt <= maxRetriesPerUrl; attempt += 1) {
      const timeout = withTimeout(options.timeoutMs || 12000);
      try {
        const headers = {
          Accept: "application/json",
          ...(options.userAgent ? { "User-Agent": options.userAgent } : {}),
          ...options.headers,
        };

        if (!isRoutingRequest) {
          // Keep project identity header for geocoding endpoints; strip for routing endpoints.
          headers["X-GeoMath-Client"] = options.userAgent || "multi-branch-proximity-finder/1.0";
        }

        if (isRoutingRequest) {
          for (const key of Object.keys(headers)) {
            if (key.toLowerCase() === "x-geomath-client") {
              delete headers[key];
            }
          }
        }

        const response = await fetch(url, {
          method,
          mode: "cors",
          cache: "no-store",
          referrerPolicy: "strict-origin-when-cross-origin",
          headers,
          signal: timeout.signal,
        });

        // OPTIONS 204 is part of CORS negotiation and should not be treated as a hard error.
        if (response.status === 204 && method === "OPTIONS") {
          return null;
        }

        if (response.status === 429) {
          const retryAfterMs = parseRetryAfterMs(response.headers.get("Retry-After"));
          if (attempt < maxRetriesPerUrl) {
            await sleep(retryAfterMs || 1200);
            continue;
          }

          throw new Error("Server Busy (429). Please retry in a moment.");
        }

        if (!response.ok) {
          lastError = new Error(`${response.status} ${response.statusText}`);
          break;
        }

        return await response.json();
      } catch (error) {
        lastError = error;

        if (attempt < maxRetriesPerUrl) {
          await sleep(600 * (attempt + 1));
          continue;
        }
      } finally {
        timeout.clear();
      }
    }
  }

  throw lastError || new Error("All endpoints failed.");
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

function buildOsrmUrls(points) {
  const routeParams = "overview=full&geometries=geojson";
  const coordinateString = points.map((point) => `${point.lng},${point.lat}`).join(";");
  return OSRM_ENDPOINTS.map((base) => `${base}/${coordinateString}?${routeParams}`);
}

export async function searchPhoton(query, mapCenter, limit = 8) {
  const urls = buildPhotonUrls(query, mapCenter, limit);
  const data = await fetchJsonWithFallback(urls);
  const features = Array.isArray(data?.features) ? data.features : [];
  return features.map(mapPhotonFeature).filter(Boolean);
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

export async function fetchOsrmRoute(inputPoints, maybeDestination) {
  const points = normalizeRoutePoints(inputPoints, maybeDestination);
  if (points.length < 2) {
    throw new Error("ROUTING_INVALID_POINTS: At least 2 valid coordinates are required.");
  }

  const urls = buildOsrmUrls(points);

  let data;
  try {
    data = await fetchJsonWithFallback(urls, {
      method: "GET",
      headers: {},
    });
  } catch (error) {
    const reason = error?.message ? String(error.message) : "Unknown routing failure.";
    throw new Error(`ROUTING_REQUEST_FAILED: ${reason}`);
  }

  if (!data || data.code !== "Ok" || !Array.isArray(data.routes) || data.routes.length === 0) {
    const code = data?.code ? String(data.code) : "NoRoute";
    throw new Error(`ROUTING_RESPONSE_INVALID: ${code}`);
  }

  const best = data.routes[0];
  return {
    geometry: best.geometry,
    distanceKm: best.distance / 1000,
    durationMin: best.duration / 60,
  };
}
