export const GeoMath = {
  toLatLng(point) {
    if (!point) return null;
    if (typeof point.lat === "number" && typeof point.lng === "number") return L.latLng(point.lat, point.lng);
    if (Array.isArray(point) && point.length >= 2) return L.latLng(Number(point[0]), Number(point[1]));
    return null;
  },

  flattenLatLngs(values) {
    const queue = Array.isArray(values) ? [...values] : [];
    const output = [];

    while (queue.length > 0) {
      const item = queue.shift();
      if (Array.isArray(item)) {
        queue.unshift(...item);
        continue;
      }

      const latLng = this.toLatLng(item);
      if (latLng) output.push(latLng);
    }

    return output;
  },

  // Returns snapped route point and split distances in meters for a hover coordinate.
  calculateSplitDistances(polyline, hoverLatLng) {
    if (!polyline?.getLatLngs) return null;

    const hoverPoint = this.toLatLng(hoverLatLng);
    if (!hoverPoint) return null;

    const routePoints = this.flattenLatLngs(polyline.getLatLngs());
    if (routePoints.length < 2) return null;

    const mapRef = polyline._map;
    if (!mapRef) return null;

    const snapToSegment = (a, b, p) => {
      if (L.GeometryUtil?.closestOnSegment) {
        return L.GeometryUtil.closestOnSegment(mapRef, p, a, b);
      }

      const ap = mapRef.project(p);
      const aProj = mapRef.project(a);
      const bProj = mapRef.project(b);
      const abX = bProj.x - aProj.x;
      const abY = bProj.y - aProj.y;
      const apX = ap.x - aProj.x;
      const apY = ap.y - aProj.y;
      const abLenSquared = abX * abX + abY * abY;
      const t = abLenSquared === 0 ? 0 : Math.max(0, Math.min(1, (apX * abX + apY * abY) / abLenSquared));
      const snapped = L.point(aProj.x + t * abX, aProj.y + t * abY);
      return mapRef.unproject(snapped);
    };

    let bestSegmentIndex = 0;
    let bestSnapped = routePoints[0];
    let minDistance = Number.POSITIVE_INFINITY;

    for (let i = 0; i < routePoints.length - 1; i += 1) {
      const a = routePoints[i];
      const b = routePoints[i + 1];
      const snapped = snapToSegment(a, b, hoverPoint);
      const dist = hoverPoint.distanceTo(snapped);

      if (dist < minDistance) {
        minDistance = dist;
        bestSegmentIndex = i;
        bestSnapped = snapped;
      }
    }

    let fromStartM = 0;
    for (let i = 0; i < bestSegmentIndex; i += 1) {
      fromStartM += routePoints[i].distanceTo(routePoints[i + 1]);
    }
    fromStartM += routePoints[bestSegmentIndex].distanceTo(bestSnapped);

    let remainingM = bestSnapped.distanceTo(routePoints[bestSegmentIndex + 1]);
    for (let i = bestSegmentIndex + 1; i < routePoints.length - 1; i += 1) {
      remainingM += routePoints[i].distanceTo(routePoints[i + 1]);
    }

    return {
      snappedLatLng: bestSnapped,
      fromStartM,
      remainingM,
      totalM: fromStartM + remainingM,
    };
  },

  normalizeText(value) {
    return String(value || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/đ/g, "d")
      .replace(/\s+/g, " ")
      .trim();
  },

  // Valid when target sits between two anchors, regardless of ascending or descending numbers.
  isLogicalSequence(numA, numTarget, numB) {
    if (![numA, numTarget, numB].every(Number.isFinite)) return false;
    if (numA === numB) return false;
    return (numA < numTarget && numTarget < numB) || (numB < numTarget && numTarget < numA);
  },

  interpolationRatio(numA, numTarget, numB) {
    if (![numA, numTarget, numB].every(Number.isFinite)) return null;
    if (numB === numA) return null;
    return (numTarget - numA) / (numB - numA);
  },

  interpolateCoordinate(pointA, pointB, numA, numTarget, numB) {
    if (!pointA || !pointB) return null;
    if (![pointA.lat, pointA.lng, pointB.lat, pointB.lng].every(Number.isFinite)) return null;
    if (!this.isLogicalSequence(numA, numTarget, numB)) return null;

    const ratio = this.interpolationRatio(numA, numTarget, numB);
    if (ratio === null) return null;

    return {
      lat: pointA.lat + (pointB.lat - pointA.lat) * ratio,
      lng: pointA.lng + (pointB.lng - pointA.lng) * ratio,
    };
  },

  // Alias used by resolver for concise service integration.
  interpolate(pointA, pointB, numA, numTarget, numB) {
    return this.interpolateCoordinate(pointA, pointB, numA, numTarget, numB);
  },

  validateAnchorContext(anchor, expectedStreet, expectedDistrict) {
    if (!anchor) return false;

    const street = this.normalizeText(anchor.street || anchor.name || "");
    const district = this.normalizeText(anchor.district || anchor.city || "");
    const streetExpected = this.normalizeText(expectedStreet || "");
    const districtExpected = this.normalizeText(expectedDistrict || "");

    const streetOk = !streetExpected || street.includes(streetExpected) || streetExpected.includes(street);
    const districtOk = !districtExpected || district.includes(districtExpected) || districtExpected.includes(district);

    return streetOk && districtOk;
  },

  // Checks if a feature name/display_name contains '/' indicating internal alley ('Ngách').
  isAlleyResult(item) {
    if (!item) return false;
    const name = String(item?.name || item?.display_name || "");
    const displayName = String(item?.raw?.properties?.display_name || "");
    return name.includes("/") || displayName.includes("/");
  },

  // Checks if a feature is a primary 'house' type (strict type matching).
  isPrimaryHouseType(item) {
    if (!item) return false;
    const type = String(item?.type || item?.raw?.properties?.type || "").toLowerCase();
    // Accept 'house', 'building', or 'amenity' with clear house_number.
    return type === "house" || type === "building" || type === "amenity";
  },

  // Strict filtering: prioritize exact house type + number match, exclude alleys.
  isStrictHouseMatch(item, expectedNum) {
    if (!item) return false;
    // Reject if it's an alley (contains '/').
    if (this.isAlleyResult(item)) return false;
    // Prefer primary house types.
    if (!this.isPrimaryHouseType(item)) return false;
    // Strict number match: check houseNumber field or parse from name.
    const numStr = String(item?.houseNumber || item?.raw?.properties?.housenumber || "").trim();
    if (numStr === String(expectedNum).trim()) return true;
    return false;
  },

  // Calculates interpolation with confidence score.
  interpolateWithConfidence(pointA, pointB, numA, numTarget, numB, isExactMatch = false) {
    if (!pointA || !pointB) return null;
    if (![pointA.lat, pointA.lng, pointB.lat, pointB.lng].every(Number.isFinite)) return null;
    if (!this.isLogicalSequence(numA, numTarget, numB)) return null;

    const ratio = this.interpolationRatio(numA, numTarget, numB);
    if (ratio === null) return null;

    const interpolated = {
      lat: pointA.lat + (pointB.lat - pointA.lat) * ratio,
      lng: pointA.lng + (pointB.lng - pointA.lng) * ratio,
    };

    // Exact matches get 1.0, interpolated virtual nodes get 0.8.
    const confidence = isExactMatch ? 1.0 : 0.8;

    return {
      ...interpolated,
      confidence,
      ratio,
    };
  },
};
