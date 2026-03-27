const ROUTE_ENDPOINTS_BY_MODE = {
  car: [
    "https://routing.openstreetmap.de/routed-car/route/v1/driving",
    "https://router.project-osrm.org/route/v1/driving",
  ],
  motorcycle: [
    "https://routing.openstreetmap.de/routed-bike/route/v1/bicycle",
  ],
};

function normalizeRoutePoint(point) {
  if (!point || typeof point !== "object") return null;
  const lat = Number(point.lat);
  const lng = Number(point.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

function normalizeRoutePoints(inputPoints, maybeDestination) {
  if (Array.isArray(inputPoints)) {
    return inputPoints.map(normalizeRoutePoint).filter(Boolean);
  }
  return [normalizeRoutePoint(inputPoints), normalizeRoutePoint(maybeDestination)].filter(Boolean);
}

function buildRouteQuery(points) {
  return points.map((point) => `${point.lng},${point.lat}`).join(";");
}

function buildPublicOsrmUrlsByMode(points, mode = "driving") {
  const normalizedMode = mode === "motorcycle" ? "motorcycle" : (mode === "car" ? "car" : "car");
  const endpoints = ROUTE_ENDPOINTS_BY_MODE[normalizedMode] || ROUTE_ENDPOINTS_BY_MODE.car;
  const coordinateString = buildRouteQuery(points);
  return endpoints.map((base) => `${base}/${coordinateString}?overview=full&geometries=geojson&steps=false&alternatives=false`);
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

function buildFerryFallbackPayload(points, mode = "driving") {
  const coordinates = points.map((point) => [point.lng, point.lat]);
  let distanceM = 0;
  for (let i = 1; i < points.length; i += 1) {
    distanceM += haversineMeters(points[i - 1], points[i]);
  }
  const speedMps = mode === "motorcycle" ? 9.0 : 8.0;
  const durationS = distanceM > 0 ? distanceM / speedMps : 0;

  return {
    routes: [
      {
        geometry: { type: "LineString", coordinates },
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

/**
 * Transform OSRM GeoJSON [lng, lat] coordinates into Leaflet [lat, lng].
 */
export function flipCoords(coordinates = []) {
  return (coordinates || [])
    .filter((item) => Array.isArray(item) && item.length >= 2)
    .map(([lng, lat]) => [Number(lat), Number(lng)])
    .filter(([lat, lng]) => Number.isFinite(lat) && Number.isFinite(lng));
}

/**
 * Robust route fetcher with optional proxy support.
 * For production, prefer passing proxyUrl to avoid public OSRM CORS variance.
 */
export async function fetchRoute(inputPoints, maybeDestination, options = {}) {
  const points = normalizeRoutePoints(inputPoints, maybeDestination);
  if (points.length < 2) {
    throw new Error("ROUTING_INVALID_POINTS: At least 2 valid coordinates are required.");
  }

  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 12000;

  // Preferred path: your own backend proxy endpoint.
  if (options.proxyUrl) {
    const signalController = new AbortController();
    const timeoutId = setTimeout(() => signalController.abort(), timeoutMs);

    try {
      const query = new URLSearchParams({
        coords: buildRouteQuery(points),
      });
      const response = await fetch(`${options.proxyUrl}?${query.toString()}`, {
        method: "GET",
        signal: signalController.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`ROUTING_PROXY_FAILED: HTTP ${response.status} ${text}`.trim());
      }

      const data = await response.json();
      return data;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // Fallback path: public OSRM mirrors (browser may still be CORS-blocked depending on endpoint policy).
  const selectedMode = options.mode === "motorcycle" ? "motorcycle" : (options.mode === "car" ? "car" : "car");
  const urls = buildPublicOsrmUrlsByMode(points, selectedMode);
  let lastError = null;

  for (const url of urls) {
    const signalController = new AbortController();
    const timeoutId = setTimeout(() => signalController.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method: "GET",
        mode: "cors",
        signal: signalController.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      return data;
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  if (options.allowFerry !== false) {
    return buildFerryFallbackPayload(points, selectedMode);
  }

  const reason = String(lastError?.message || "Unknown routing failure");
  throw new Error(`ROUTING_REQUEST_FAILED: ${reason}. If this is a browser CORS block, use options.proxyUrl with a backend proxy.`);
}

export function createRouteInteractionService() {
  const routeWaypointsMap = new Map();

  function normalizeWaypointType(type) {
    return type === "shaping" ? "shaping" : "via";
  }

  function createWaypointId() {
    if (window.crypto?.randomUUID) return `wp-${window.crypto.randomUUID()}`;
    return `wp-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  }

  function toLeafletLatLng(value) {
    if (!value) return null;
    if (typeof value.lat === "number" && typeof value.lng === "number") return L.latLng(value.lat, value.lng);
    if (typeof value.lat === "number" && typeof value.lon === "number") return L.latLng(value.lat, value.lon);
    if (Array.isArray(value) && value.length >= 2) return L.latLng(Number(value[0]), Number(value[1]));
    return null;
  }

  function cloneWaypoint(point) {
    return {
      id: point?.id || createWaypointId(),
      lat: Number(point?.lat),
      lng: Number(point?.lng),
      type: normalizeWaypointType(point?.type),
    };
  }

  function flattenRouteLatLngs(currentRoutePolyline) {
    if (!currentRoutePolyline?.getLatLngs) return [];
    const raw = currentRoutePolyline.getLatLngs();
    const queue = Array.isArray(raw) ? [...raw] : [];
    const flattened = [];

    while (queue.length > 0) {
      const item = queue.shift();
      if (Array.isArray(item)) {
        queue.unshift(...item);
        continue;
      }
      const latLng = toLeafletLatLng(item);
      if (latLng) flattened.push(latLng);
    }

    return flattened;
  }

  function distancePointToSegmentMeters(a, b, p, mapRef) {
    const projectedA = mapRef.project(a);
    const projectedB = mapRef.project(b);
    const projectedP = mapRef.project(p);

    const abX = projectedB.x - projectedA.x;
    const abY = projectedB.y - projectedA.y;
    const apX = projectedP.x - projectedA.x;
    const apY = projectedP.y - projectedA.y;
    const abLenSquared = abX * abX + abY * abY;
    const t = abLenSquared === 0 ? 0 : Math.max(0, Math.min(1, (apX * abX + apY * abY) / abLenSquared));

    const closestProjected = L.point(projectedA.x + t * abX, projectedA.y + t * abY);
    const closestLatLng = mapRef.unproject(closestProjected);
    return p.distanceTo(closestLatLng);
  }

  function findClosestSegmentIndex(newLatlng, currentRoutePolyline) {
    const routePoints = flattenRouteLatLngs(currentRoutePolyline);
    if (routePoints.length < 2) return 0;

    const point = toLeafletLatLng(newLatlng);
    if (!point) return 0;

    const mapRef = currentRoutePolyline?._map;
    let minDistance = Number.POSITIVE_INFINITY;
    let bestIndex = 0;

    for (let i = 0; i < routePoints.length - 1; i += 1) {
      const distance = mapRef
        ? distancePointToSegmentMeters(routePoints[i], routePoints[i + 1], point, mapRef)
        : Math.min(routePoints[i].distanceTo(point), routePoints[i + 1].distanceTo(point));

      if (distance < minDistance) {
        minDistance = distance;
        bestIndex = i;
      }
    }

    return bestIndex;
  }

  function findInsertionIndex(destinationId, newLatlng, currentRoutePolyline) {
    const point = toLeafletLatLng(newLatlng);
    const currentWaypoints = routeWaypointsMap.get(destinationId) || [];
    if (!point) return currentWaypoints.length;

    const routePoints = flattenRouteLatLngs(currentRoutePolyline);
    if (routePoints.length < 2) return currentWaypoints.length;

    const routeDistanceTotals = [0];
    for (let i = 1; i < routePoints.length; i += 1) {
      routeDistanceTotals[i] = routeDistanceTotals[i - 1] + routePoints[i - 1].distanceTo(routePoints[i]);
    }

    const closestSegmentIndex = findClosestSegmentIndex(point, currentRoutePolyline);
    const projectedBaseDistance = routeDistanceTotals[closestSegmentIndex] || 0;

    const rankedWaypoints = currentWaypoints
      .map((waypoint, index) => {
        const wp = L.latLng(waypoint.lat, waypoint.lng);
        const segmentIndex = findClosestSegmentIndex(wp, currentRoutePolyline);
        return { index, along: routeDistanceTotals[segmentIndex] || 0 };
      })
      .sort((a, b) => a.along - b.along);

    let insertionIndex = rankedWaypoints.length;
    for (let i = 0; i < rankedWaypoints.length; i += 1) {
      if (projectedBaseDistance <= rankedWaypoints[i].along) {
        insertionIndex = i;
        break;
      }
    }

    return Math.max(0, Math.min(insertionIndex, currentWaypoints.length));
  }

  function getWaypointsForRoute(destinationId) {
    return (routeWaypointsMap.get(destinationId) || []).map(cloneWaypoint);
  }

  function setWaypointsForRoute(destinationId, waypoints = []) {
    routeWaypointsMap.set(destinationId, waypoints.map(cloneWaypoint));
    return getWaypointsForRoute(destinationId);
  }

  function clearWaypointsForRoute(destinationId) {
    routeWaypointsMap.delete(destinationId);
  }

  function clearAllRoutes() {
    routeWaypointsMap.clear();
  }

  function insertWaypoint(destinationId, newLatlng, currentRoutePolyline) {
    const normalized = toLeafletLatLng(newLatlng);
    const currentWaypoints = routeWaypointsMap.get(destinationId) || [];
    if (!normalized) return { index: currentWaypoints.length, waypoint: null };

    const index = findInsertionIndex(destinationId, normalized, currentRoutePolyline);
    const waypoint = { id: createWaypointId(), lat: normalized.lat, lng: normalized.lng, type: "via" };
    currentWaypoints.splice(index, 0, waypoint);
    routeWaypointsMap.set(destinationId, currentWaypoints);
    return { index, waypoint: cloneWaypoint(waypoint) };
  }

  function updateWaypointAt(destinationId, index, nextLatLng) {
    const currentWaypoints = routeWaypointsMap.get(destinationId) || [];
    if (!Number.isInteger(index) || index < 0 || index >= currentWaypoints.length) return null;

    const normalized = toLeafletLatLng(nextLatLng);
    if (!normalized) return null;

    const next = {
      id: currentWaypoints[index]?.id || createWaypointId(),
      lat: normalized.lat,
      lng: normalized.lng,
      type: normalizeWaypointType(currentWaypoints[index]?.type),
    };
    currentWaypoints[index] = next;
    routeWaypointsMap.set(destinationId, currentWaypoints);
    return cloneWaypoint(next);
  }

  function removeWaypoint(destinationId, waypointId) {
    const currentWaypoints = routeWaypointsMap.get(destinationId) || [];
    const needle = String(waypointId || "").trim();
    if (!needle) return getWaypointsForRoute(destinationId);

    const index = currentWaypoints.findIndex((item) => String(item?.id || "") === needle);
    if (index === -1) return getWaypointsForRoute(destinationId);

    currentWaypoints.splice(index, 1);
    routeWaypointsMap.set(destinationId, currentWaypoints);
    return getWaypointsForRoute(destinationId);
  }

  function removeWaypointAt(destinationId, index) {
    const currentWaypoints = routeWaypointsMap.get(destinationId) || [];
    if (!Number.isInteger(index) || index < 0 || index >= currentWaypoints.length) return null;
    const removed = currentWaypoints[index];
    currentWaypoints.splice(index, 1);
    routeWaypointsMap.set(destinationId, currentWaypoints);
    return cloneWaypoint(removed);
  }

  function setWaypointType(destinationId, waypointId, type) {
    const currentWaypoints = routeWaypointsMap.get(destinationId) || [];
    const needle = String(waypointId || "").trim();
    if (!needle) return null;

    const index = currentWaypoints.findIndex((item) => String(item?.id || "") === needle);
    if (index === -1) return null;

    const next = {
      ...currentWaypoints[index],
      type: normalizeWaypointType(type),
    };
    currentWaypoints[index] = next;
    routeWaypointsMap.set(destinationId, currentWaypoints);
    return cloneWaypoint(next);
  }

  function getFormattedOSRMString(destinationId, origin, destination) {
    const points = [origin, ...getWaypointsForRoute(destinationId), destination]
      .filter(Boolean)
      .map((point) => `${Number(point.lng)},${Number(point.lat)}`);
    return points.join(";");
  }

  return {
    getWaypointsForRoute,
    setWaypointsForRoute,
    clearWaypointsForRoute,
    clearAllRoutes,
    insertWaypoint,
    updateWaypointAt,
    removeWaypoint,
    removeWaypointAt,
    setWaypointType,
    findInsertionIndex,
    getFormattedOSRMString,
  };
}
