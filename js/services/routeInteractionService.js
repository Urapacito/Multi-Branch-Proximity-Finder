export function createRouteInteractionService() {
  let activeRouteId = null;
  let customWaypoints = [];

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
      lat: Number(point.lat),
      lng: Number(point.lng),
    };
  }

  function setActiveRoute(routeId, waypoints = []) {
    if (routeId !== activeRouteId) {
      activeRouteId = routeId || null;
      customWaypoints = waypoints.map(cloneWaypoint);
      return;
    }

    customWaypoints = waypoints.map(cloneWaypoint);
  }

  function clearActiveRoute() {
    activeRouteId = null;
    customWaypoints = [];
  }

  function getActiveRouteId() {
    return activeRouteId;
  }

  function getCustomWaypoints() {
    return customWaypoints.map(cloneWaypoint);
  }

  function updateWaypointAt(index, nextLatLng) {
    if (!Number.isInteger(index) || index < 0 || index >= customWaypoints.length) return null;
    const normalized = toLeafletLatLng(nextLatLng);
    if (!normalized) return null;

    customWaypoints[index] = {
      id: customWaypoints[index]?.id || createWaypointId(),
      lat: normalized.lat,
      lng: normalized.lng,
    };
    return customWaypoints[index];
  }

  function removeWaypoint(id) {
    const waypointId = String(id || "").trim();
    if (!waypointId) return getCustomWaypoints();

    const index = customWaypoints.findIndex((item) => String(item?.id || "") === waypointId);
    if (index === -1) return getCustomWaypoints();

    customWaypoints.splice(index, 1);
    return getCustomWaypoints();
  }

  function removeWaypointAt(index) {
    if (!Number.isInteger(index) || index < 0 || index >= customWaypoints.length) return null;
    const target = customWaypoints[index];
    const updated = removeWaypoint(target?.id);
    return Array.isArray(updated) ? (target || null) : null;
  }

  function getFormattedOSRMString(origin, destination) {
    const points = [origin, ...customWaypoints, destination]
      .filter(Boolean)
      .map((point) => `${Number(point.lng)},${Number(point.lat)}`);

    return points.join(";");
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
      let distance;

      if (mapRef) {
        distance = distancePointToSegmentMeters(routePoints[i], routePoints[i + 1], point, mapRef);
      } else {
        const a = routePoints[i].distanceTo(point);
        const b = routePoints[i + 1].distanceTo(point);
        distance = Math.min(a, b);
      }

      if (distance < minDistance) {
        minDistance = distance;
        bestIndex = i;
      }
    }

    return bestIndex;
  }

  function findInsertionIndex(newLatlng, currentRoutePolyline) {
    const point = toLeafletLatLng(newLatlng);
    if (!point) return customWaypoints.length;

    const routePoints = flattenRouteLatLngs(currentRoutePolyline);
    if (routePoints.length < 2) return customWaypoints.length;

    const routeDistanceTotals = [0];
    for (let i = 1; i < routePoints.length; i += 1) {
      const step = routePoints[i - 1].distanceTo(routePoints[i]);
      routeDistanceTotals[i] = routeDistanceTotals[i - 1] + step;
    }

    const closestSegmentIndex = findClosestSegmentIndex(point, currentRoutePolyline);
    const projectedBaseDistance = routeDistanceTotals[closestSegmentIndex] || 0;

    const rankedWaypoints = customWaypoints.map((waypoint, index) => {
      const wp = L.latLng(waypoint.lat, waypoint.lng);

      if (L.GeometryUtil?.closestOnSegment) {
        let bestDist = Number.POSITIVE_INFINITY;
        let bestAlong = 0;

        for (let i = 0; i < routePoints.length - 1; i += 1) {
          const snapped = L.GeometryUtil.closestOnSegment(currentRoutePolyline._map, wp, routePoints[i], routePoints[i + 1]);
          const segmentDist = wp.distanceTo(snapped);
          if (segmentDist < bestDist) {
            bestDist = segmentDist;
            bestAlong = routeDistanceTotals[i];
          }
        }

        return { index, along: bestAlong };
      }

      const segmentIndex = findClosestSegmentIndex(wp, currentRoutePolyline);
      return { index, along: routeDistanceTotals[segmentIndex] || 0 };
    }).sort((a, b) => a.along - b.along);

    let insertionIndex = rankedWaypoints.length;
    for (let i = 0; i < rankedWaypoints.length; i += 1) {
      if (projectedBaseDistance <= rankedWaypoints[i].along) {
        insertionIndex = i;
        break;
      }
    }

    return Math.max(0, Math.min(insertionIndex, customWaypoints.length));
  }

  function insertWaypoint(newLatlng, currentRoutePolyline) {
    const normalized = toLeafletLatLng(newLatlng);
    if (!normalized) return { index: customWaypoints.length, waypoint: null };

    const index = findInsertionIndex(normalized, currentRoutePolyline);
    const waypoint = {
      id: createWaypointId(),
      lat: normalized.lat,
      lng: normalized.lng,
    };
    customWaypoints.splice(index, 0, waypoint);
    return { index, waypoint };
  }

  return {
    setActiveRoute,
    clearActiveRoute,
    getActiveRouteId,
    getCustomWaypoints,
    updateWaypointAt,
    removeWaypoint,
    removeWaypointAt,
    findInsertionIndex,
    insertWaypoint,
    getFormattedOSRMString,
  };
}
