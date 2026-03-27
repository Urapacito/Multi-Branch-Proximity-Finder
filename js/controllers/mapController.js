import { createRouteInteractionService, fetchRoute, flipCoords } from "../services/routeInteractionService.js";
import { GeoMath } from "../services/geoMath.js";
import { debounceByKey } from "../ui/debounceUtil.js";

export function createMapController(options = {}) {
  const {
    mapElementId = "map",
    initialView = { lat: 21.0285, lng: 105.8542, zoom: 12 },
    onOriginDragged,
    onDestinationDragged,
    onDestinationSelected,
    onRouteRecalculateStart,
    onRouteRecalculateEnd,
    onRouteRecalculateError,
    onRouteUpdated,
    onRouteHover,
    onRouteHoverEnd,
    onRequestFavoriteName,
    onFavoriteSaved,
    routeProxyUrl,
    getRouteMode,
  } = options;

  const map = L.map(mapElementId, { zoomControl: true }).setView([initialView.lat, initialView.lng], initialView.zoom);

  if (!map.getPane("routeInteractionPane")) {
    const pane = map.createPane("routeInteractionPane");
    pane.style.zIndex = "460";
    pane.style.pointerEvents = "auto";
  }

  const baseLayers = {
    Streets: L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap contributors",
    }),
    Satellite: L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
      maxZoom: 19,
      attribution: "Tiles &copy; Esri",
    }),
    Light: L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
      maxZoom: 20,
      attribution: "&copy; OpenStreetMap &copy; CARTO",
    }),
    Terrain: L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
      maxZoom: 17,
      attribution: "Map data: &copy; OpenStreetMap contributors, SRTM | Map style: &copy; OpenTopoMap",
    }),
  };

  const layerCatalog = [
    {
      key: "Streets",
      label: "Standard",
      thumb: "https://tile.openstreetmap.org/13/6551/3165.png",
    },
    {
      key: "Satellite",
      label: "Satellite",
      thumb: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/13/3165/6551",
    },
    {
      key: "Light",
      label: "Light",
      thumb: "https://a.basemaps.cartocdn.com/light_all/13/6551/3165.png",
    },
    {
      key: "Terrain",
      label: "Terrain",
      thumb: "https://a.tile.opentopomap.org/13/6551/3165.png",
    },
  ];

  let activeBaseLayerKey = "Streets";
  let layerPanelEl = null;
  let layerPanelToggleBtn = null;

  function applyBaseLayer(nextKey) {
    const normalizedKey = baseLayers[nextKey] ? nextKey : "Streets";
    if (normalizedKey === activeBaseLayerKey) return;

    const current = baseLayers[activeBaseLayerKey];
    if (current && map.hasLayer(current)) {
      map.removeLayer(current);
    }

    const nextLayer = baseLayers[normalizedKey] || baseLayers.Streets;
    nextLayer.addTo(map);
    activeBaseLayerKey = normalizedKey;

    if (!layerPanelEl) return;
    const cards = layerPanelEl.querySelectorAll("[data-layer-key]");
    cards.forEach((card) => {
      const isActive = card.dataset.layerKey === activeBaseLayerKey;
      card.classList.toggle("is-active", isActive);
      card.setAttribute("aria-pressed", String(isActive));
    });
  }

  function closeLayerPanel() {
    if (!layerPanelEl) return;
    layerPanelEl.classList.add("hidden");
    layerPanelToggleBtn?.setAttribute("aria-expanded", "false");
  }

  function openLayerPanel() {
    if (!layerPanelEl || !layerPanelToggleBtn) return;
    const mapRect = map.getContainer().getBoundingClientRect();
    const btnRect = layerPanelToggleBtn.getBoundingClientRect();

    const top = Math.max(8, btnRect.top - mapRect.top - 8);
    const left = btnRect.right - mapRect.left + 10;

    layerPanelEl.style.top = `${top}px`;
    layerPanelEl.style.left = `${left}px`;
    layerPanelEl.classList.remove("hidden");
    layerPanelToggleBtn.setAttribute("aria-expanded", "true");
  }

  function toggleLayerPanel() {
    if (!layerPanelEl) return;
    if (layerPanelEl.classList.contains("hidden")) {
      openLayerPanel();
      return;
    }
    closeLayerPanel();
  }

  function ensureLayerPanel() {
    if (layerPanelEl) return layerPanelEl;
    const host = map.getContainer();

    layerPanelEl = document.createElement("div");
    layerPanelEl.className = "map-layer-panel hidden";
    layerPanelEl.innerHTML = `
      <div class="map-layer-panel-header">Map Layers</div>
      <div class="map-layer-grid"></div>
    `;

    const grid = layerPanelEl.querySelector(".map-layer-grid");
    layerCatalog.forEach((item) => {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "map-layer-card";
      card.dataset.layerKey = item.key;
      card.setAttribute("aria-pressed", String(item.key === activeBaseLayerKey));
      card.innerHTML = `
        <span class="thumb-wrap"><img src="${item.thumb}" alt="${item.label} layer preview" /></span>
        <span class="layer-name">${item.label}</span>
      `;
      card.addEventListener("click", () => {
        applyBaseLayer(item.key);
      });
      grid?.appendChild(card);
    });

    host.appendChild(layerPanelEl);
    return layerPanelEl;
  }

  function mountLayerControl() {
    const layerControl = L.control({ position: "topleft" });

    layerControl.onAdd = () => {
      const container = L.DomUtil.create("div", "leaflet-bar custom-layer-control");
      const button = L.DomUtil.create("button", "custom-layer-toggle", container);
      button.type = "button";
      button.setAttribute("aria-label", "Open map layers");
      button.setAttribute("aria-expanded", "false");
      button.innerHTML = '<i class="fa-solid fa-layer-group" aria-hidden="true"></i>';

      L.DomEvent.disableClickPropagation(container);
      L.DomEvent.disableScrollPropagation(container);
      L.DomEvent.on(button, "click", (event) => {
        L.DomEvent.stop(event);
        layerPanelToggleBtn = button;
        ensureLayerPanel();
        toggleLayerPanel();
      });

      layerPanelToggleBtn = button;
      return container;
    };

    layerControl.addTo(map);
  }

  baseLayers.Streets.addTo(map);
  mountLayerControl();
  ensureLayerPanel();
  applyBaseLayer(activeBaseLayerKey);

  map.on("click", () => closeLayerPanel());

  let originMarker = null;
  const destinationMarkers = new Map();
  const routeLayers = new Map();
  const routeInteractionLayers = new Map();
  const routeWaypointMarkers = new Map();
  const routeWaypointsById = new Map();
  const routeInteraction = createRouteInteractionService();
  const routeHoverCleanup = new Map();
  const routeRecalcTimers = new Map();
  let activeDestinationId = null;

  function formatDistance(valueM) {
    if (!Number.isFinite(valueM) || valueM < 0) return "0 m";
    if (valueM < 1000) return `${Math.round(valueM)} m`;
    return `${(valueM / 1000).toFixed(1)} km`;
  }

  function createThrottledHoverHandler(callback, waitMs = 60) {
    let timeoutId = null;
    let latestEvent = null;
    let lastRun = 0;

    const run = () => {
      timeoutId = null;
      lastRun = performance.now();
      callback(latestEvent);
    };

    const throttled = (event) => {
      latestEvent = event;
      const now = performance.now();
      const remaining = waitMs - (now - lastRun);

      if (remaining <= 0) {
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        run();
        return;
      }

      if (!timeoutId) {
        timeoutId = setTimeout(run, remaining);
      }
    };

    throttled.cancel = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
    };

    return throttled;
  }

  function attachRouteHoverEvents(destinationId, line) {
    const onMove = createThrottledHoverHandler((event) => {
      if (!event?.latlng || !event?.containerPoint) return;

      const split = GeoMath.calculateSplitDistances(line, event.latlng);
      if (!split) return;

      onRouteHover?.(destinationId, {
        fromStartText: formatDistance(split.fromStartM),
        remainingText: formatDistance(split.remainingM),
        position: {
          x: event.containerPoint.x,
          y: event.containerPoint.y,
        },
      });
    });

    const onOut = () => {
      onMove.cancel?.();
      onRouteHoverEnd?.(destinationId);
    };

    line.on("mouseover", onMove);
    line.on("mousemove", onMove);
    line.on("mouseout", onOut);

    routeHoverCleanup.set(destinationId, () => {
      onMove.cancel?.();
      line.off("mouseover", onMove);
      line.off("mousemove", onMove);
      line.off("mouseout", onOut);
    });
  }

  function clearRouteHoverSubscriptions() {
    routeHoverCleanup.forEach((dispose) => dispose?.());
    routeHoverCleanup.clear();
    onRouteHoverEnd?.();
  }

  function clearRouteRecalcTimer(destinationId) {
    const timer = routeRecalcTimers.get(destinationId);
    if (timer) clearTimeout(timer);
    routeRecalcTimers.delete(destinationId);
  }

  function clearAllRouteRecalcTimers() {
    routeRecalcTimers.forEach((timer) => clearTimeout(timer));
    routeRecalcTimers.clear();
  }

  function setWaypointDraggingCursor(isDragging) {
    if (!document?.body) return;
    document.body.classList.toggle("route-waypoint-dragging", Boolean(isDragging));
  }

  function originIcon() {
    return L.divIcon({
      className: "origin-div-icon",
      html: '<span style="display:block;width:14px;height:14px;border-radius:50%;background:#1a73e8;border:2px solid #ffffff;box-shadow:0 0 0 2px rgba(26,115,232,0.35);"></span>',
      iconSize: [14, 14],
      iconAnchor: [7, 7],
      popupAnchor: [0, -8],
    });
  }

  function destinationIcon(tone = "default") {
    const color = tone === "orange"
      ? "#f59e0b"
      : tone === "grey"
        ? "#9aa0a6"
        : tone === "pink"
          ? "#f472b6"
          : "#e53935";
    return L.divIcon({
      className: `destination-div-icon${tone === "pink" ? " marker-pink" : ""}`,
      html: `<span style="position:relative;display:block;width:38px;height:38px;"><span style="position:absolute;left:50%;top:2px;transform:translateX(-50%) rotate(-45deg);display:block;width:24px;height:24px;border-radius:50% 50% 50% 0;background:${color};border:1.5px solid #ffffff;box-shadow:0 2px 5px rgba(0,0,0,0.32);"></span><span style="position:absolute;left:50%;top:12px;transform:translateX(-50%);display:block;width:9px;height:9px;border-radius:50%;background:#ffffff;"></span></span>`,
      iconSize: [38, 38],
      iconAnchor: [19, 38],
      popupAnchor: [0, -34],
    });
  }

  const defaultRedIcon = destinationIcon("default");
  const pinkIcon = destinationIcon("pink");
  const orangeIcon = destinationIcon("orange");
  const greyIcon = destinationIcon("grey");

  function resolveDestinationIcon(options = {}) {
    const tone = String(options.tone || "").toLowerCase();
    if (tone === "pink") return pinkIcon;
    if (tone === "orange") return orangeIcon;
    if (tone === "grey") return greyIcon;
    if (options.isFavorite) return pinkIcon;
    return defaultRedIcon;
  }

  function routeWaypointIcon(index, isShaping = false) {
    const safeIndex = Number.isFinite(index) ? Number(index) : -1;

    if (isShaping || safeIndex < 0) {
      return L.divIcon({
        className: "route-waypoint-div-icon shaping-point",
        html: "<span class=\"shaping-point-dot\"></span>",
        iconSize: [12, 12],
        iconAnchor: [6, 6],
      });
    }

    const label = String(safeIndex + 1);
    return L.divIcon({
      className: "route-waypoint-div-icon",
      html: `<div class="wp-marker-wrapper">
              <span class="wp-number">${label}</span>
            </div>`,
      iconSize: [24, 24],
      iconAnchor: [12, 12],
    });
  }

  function cloneWaypoint(point) {
    return {
      id: point?.id,
      lat: Number(point.lat),
      lng: Number(point.lng),
      type: point?.type === "shaping" ? "shaping" : "via",
    };
  }

  function getOriginCoords() {
    if (!originMarker) return null;
    const latLng = originMarker.getLatLng();
    return { lat: latLng.lat, lng: latLng.lng };
  }

  function getDestinationCoords(destinationId) {
    const marker = destinationMarkers.get(destinationId);
    if (!marker) return null;
    const latLng = marker.getLatLng();
    return { lat: latLng.lat, lng: latLng.lng };
  }

  function hideFavoriteButtonInResultCard(destinationId) {
    const card = document.querySelector(`.result-item[data-dest-id='${destinationId}']`);
    const button = card?.querySelector("button[data-action='favorite']");
    button?.classList.add("hidden");
  }

  async function saveDestinationAsFavorite(destinationId, defaultName = "") {
    const coords = getDestinationCoords(destinationId);
    if (!coords) return null;

    const favoriteName = await onRequestFavoriteName?.({
      destinationId,
      defaultName,
      lat: coords.lat,
      lon: coords.lng,
    });

    if (!favoriteName) return null;

    const saved = await onFavoriteSaved?.({
      name: favoriteName,
      lat: coords.lat,
      lon: coords.lng,
      destinationId,
    });

    if (saved) {
      hideFavoriteButtonInResultCard(destinationId);

      window.dispatchEvent(new CustomEvent("favorite:saved", {
        detail: {
          destinationId,
          name: favoriteName,
        },
      }));
    }

    return saved || { name: favoriteName, lat: coords.lat, lon: coords.lng };
  }

  function ensureRouteWaypoints(destinationId) {
    const existing = routeWaypointsById.get(destinationId) || [];
    routeInteraction.setWaypointsForRoute(destinationId, existing.map(cloneWaypoint));
  }

  function persistRouteWaypoints(destinationId) {
    routeWaypointsById.set(destinationId, routeInteraction.getWaypointsForRoute(destinationId).map(cloneWaypoint));
  }

  function updateWaypointMarkerIndexes(destinationId) {
    const markers = routeWaypointMarkers.get(destinationId) || [];
    markers.forEach((marker, index) => {
      marker.__waypointIndex = index;
      const isShaping = marker.__waypointType === "shaping";
      marker.setIcon(routeWaypointIcon(index, isShaping));
      marker.setZIndexOffset(1200);
    });
  }

  function clearWaypointMarkers(destinationId) {
    const markers = routeWaypointMarkers.get(destinationId);
    if (!markers) return;

    markers.forEach((marker) => map.removeLayer(marker));
    routeWaypointMarkers.delete(destinationId);
  }

  function clearAllWaypointMarkers() {
    Array.from(routeWaypointMarkers.keys()).forEach((destinationId) => clearWaypointMarkers(destinationId));
  }

  function updatePolylinePreview(destinationId) {
    const line = routeLayers.get(destinationId);
    const interactionLine = routeInteractionLayers.get(destinationId);
    if (!line) return;

    const origin = getOriginCoords();
    const destination = getDestinationCoords(destinationId);
    if (!origin || !destination) return;

    const waypoints = routeInteraction.getWaypointsForRoute(destinationId);
    const latLngs = [origin, ...waypoints, destination].map((point) => [point.lat, point.lng]);
    line.setLatLngs(latLngs);
    interactionLine?.setLatLngs(latLngs);
  }

  function replaceRouteLayers(destinationId, latLngs) {
    const oldCleanup = routeHoverCleanup.get(destinationId);
    oldCleanup?.();
    routeHoverCleanup.delete(destinationId);

    const oldLine = routeLayers.get(destinationId);
    if (oldLine) map.removeLayer(oldLine);

    const oldInteraction = routeInteractionLayers.get(destinationId);
    if (oldInteraction) map.removeLayer(oldInteraction);

    const line = L.polyline(latLngs, {
      ...routeStyle("default"),
      interactive: false,
    }).addTo(map);

    const interactionLine = L.polyline(latLngs, {
      pane: "routeInteractionPane",
      weight: 20,
      opacity: 0,
      className: "route-interaction-layer",
    }).addTo(map);

    interactionLine.on("mousedown", (event) => handleInitialClick(destinationId, event));
    attachRouteHoverEvents(destinationId, interactionLine);

    routeLayers.set(destinationId, line);
    routeInteractionLayers.set(destinationId, interactionLine);
  }

  function scheduleRouteRecalculation(destinationId, delayMs = 260) {
    debounceByKey(routeRecalcTimers, destinationId, () => {
      routeRecalcTimers.delete(destinationId);
      void recalculateRouteWithWaypoints(destinationId);
    }, delayMs);
  }

  function normalizeOsrmRoutePayload(payload) {
    if (!payload || typeof payload !== "object") return null;

    // Normalized shape (already mapped by some callers).
    if (payload?.geometry?.coordinates && Array.isArray(payload.geometry.coordinates)) {
      const distanceKm = Number.isFinite(payload.distanceKm)
        ? payload.distanceKm
        : Number.isFinite(payload.distance)
          ? payload.distance / 1000
          : null;
      const durationMin = Number.isFinite(payload.durationMin)
        ? payload.durationMin
        : Number.isFinite(payload.duration)
          ? payload.duration / 60
          : null;

      return {
        ...payload,
        distanceKm,
        durationMin,
      };
    }

    // Raw OSRM shape.
    const primary = Array.isArray(payload.routes) ? payload.routes[0] : null;
    if (!primary?.geometry?.coordinates || !Array.isArray(primary.geometry.coordinates)) return null;

    return {
      ...primary,
      geometry: primary.geometry,
      distanceKm: Number.isFinite(primary.distance) ? primary.distance / 1000 : null,
      durationMin: Number.isFinite(primary.duration) ? primary.duration / 60 : null,
      raw: payload,
    };
  }

  async function recalculateRouteWithWaypoints(destinationId) {
    const line = routeLayers.get(destinationId);
    if (!line) return;

    const origin = getOriginCoords();
    const destination = getDestinationCoords(destinationId);
    if (!origin || !destination) return;

    ensureRouteWaypoints(destinationId);
    const branchWaypoints = routeInteraction.getWaypointsForRoute(destinationId);
    const points = [origin, ...branchWaypoints, destination];
    if (points.length < 2) return;

    onRouteRecalculateStart?.(destinationId);
    try {
      const payload = await fetchRoute(points, null, {
        proxyUrl: routeProxyUrl,
        timeoutMs: 12000,
        mode: typeof getRouteMode === "function" ? getRouteMode() : "driving",
        allowFerry: true,
      });
      const route = normalizeOsrmRoutePayload(payload);
      if (!route?.geometry?.coordinates) return;

      const latLngs = flipCoords(route.geometry.coordinates);
      if (latLngs.length < 2) return;
      replaceRouteLayers(destinationId, latLngs);
      applyRouteSelection(activeDestinationId);

      persistRouteWaypoints(destinationId);
      onRouteUpdated?.(destinationId, {
        route,
        waypoints: routeInteraction.getWaypointsForRoute(destinationId).map(cloneWaypoint),
      });
    } catch (error) {
      onRouteRecalculateError?.(destinationId, error);
    } finally {
      onRouteRecalculateEnd?.(destinationId);
    }
  }

  function attachWaypointMarkerEvents(destinationId, marker) {
    const removeWaypointFromRoute = async (event) => {
      L.DomEvent?.stop(event);

      const markerId = marker.__waypointId;
      if (!markerId) return;

      ensureRouteWaypoints(destinationId);
      routeInteraction.removeWaypoint(destinationId, markerId);
      persistRouteWaypoints(destinationId);

      const markers = routeWaypointMarkers.get(destinationId) || [];
      const markerIndex = markers.findIndex((item) => item.__waypointId === markerId);
      if (markerIndex !== -1) markers.splice(markerIndex, 1);
      routeWaypointMarkers.set(destinationId, markers);

      marker.remove();
      updateWaypointMarkerIndexes(destinationId);
      onRouteHoverEnd?.(destinationId);
      await recalculateRouteWithWaypoints(destinationId);
    };

    marker.on("dragstart", () => {
      setWaypointDraggingCursor(true);
      map.closePopup();
      onRouteHoverEnd?.(destinationId);
    });

    marker.on("drag", () => {
      const index = marker.__waypointIndex;
      if (!Number.isInteger(index)) return;

      map.closePopup();
      ensureRouteWaypoints(destinationId);
      routeInteraction.updateWaypointAt(destinationId, index, marker.getLatLng());
      persistRouteWaypoints(destinationId);
      updatePolylinePreview(destinationId);
      scheduleRouteRecalculation(destinationId);
    });

    marker.on("dragend", async () => {
      setWaypointDraggingCursor(false);
      map.closePopup();
      const index = marker.__waypointIndex;
      if (!Number.isInteger(index)) return;

      ensureRouteWaypoints(destinationId);
      routeInteraction.updateWaypointAt(destinationId, index, marker.getLatLng());
      persistRouteWaypoints(destinationId);
      await recalculateRouteWithWaypoints(destinationId);
    });

    marker.on("mouseover", (event) => {
      const routeLine = routeInteractionLayers.get(destinationId) || routeLayers.get(destinationId);
      const split = routeLine ? GeoMath.calculateSplitDistances(routeLine, marker.getLatLng()) : null;
      if (!split) return;

      const containerPoint = event?.containerPoint || map.latLngToContainerPoint(marker.getLatLng());
      onRouteHover?.(destinationId, {
        fromStartText: formatDistance(split.fromStartM),
        remainingText: formatDistance(split.remainingM),
        isWaypoint: true,
        position: {
          x: containerPoint.x,
          y: containerPoint.y,
        },
      });
    });

    marker.on("mouseout", () => onRouteHoverEnd?.(destinationId));
    marker.on("contextmenu", (event) => {
      L.DomEvent.stop(event);
      L.DomEvent.preventDefault(event);
      onRouteHoverEnd?.(destinationId);

      const menu = L.DomUtil.create("div", "route-context-menu");
      menu.style.display = "flex";
      menu.style.flexDirection = "column";
      menu.style.gap = "6px";

      const deleteBtn = L.DomUtil.create("button", "menu-item delete", menu);
      deleteBtn.type = "button";
      deleteBtn.textContent = "Delete from route";

      const shapingBtn = L.DomUtil.create("button", "menu-item shaping", menu);
      shapingBtn.type = "button";
      shapingBtn.textContent = marker.__waypointType === "shaping" ? "Set as via point" : "Set as shaping point";

      L.DomEvent.disableClickPropagation(menu);
      L.DomEvent.on(deleteBtn, "click", async (e) => {
        L.DomEvent.stop(e);
        map.closePopup();
        await removeWaypointFromRoute(e);
      });

      L.DomEvent.on(shapingBtn, "click", (e) => {
        L.DomEvent.stop(e);
        ensureRouteWaypoints(destinationId);
        const nextType = marker.__waypointType === "shaping" ? "via" : "shaping";
        routeInteraction.setWaypointType(destinationId, marker.__waypointId, nextType);
        persistRouteWaypoints(destinationId);
        marker.__waypointType = nextType;
        marker.setIcon(routeWaypointIcon(marker.__waypointIndex, nextType === "shaping"));
        marker.setZIndexOffset(1200);
        map.closePopup();
      });

      L.popup({ closeButton: false, className: "route-menu-popup" })
        .setLatLng(event.latlng)
        .setContent(menu)
        .openOn(map);
    });
  }

  function handleInitialClick(destinationId, event) {
    const line = routeInteractionLayers.get(destinationId) || routeLayers.get(destinationId);
    if (!line || !event?.latlng) return;

    map.closePopup();

    ensureRouteWaypoints(destinationId);
    const insertion = routeInteraction.insertWaypoint(destinationId, event.latlng, line);
    if (!insertion.waypoint) return;

    persistRouteWaypoints(destinationId);

    const marker = L.marker(event.latlng, {
      draggable: true,
      icon: routeWaypointIcon(insertion.index, insertion.waypoint?.type === "shaping"),
      zIndexOffset: 1200,
    }).addTo(map);

    marker.__waypointIndex = insertion.index;
    marker.__waypointId = insertion.waypoint.id;
    marker.__waypointType = insertion.waypoint?.type === "shaping" ? "shaping" : "via";
    attachWaypointMarkerEvents(destinationId, marker);

    const markers = routeWaypointMarkers.get(destinationId) || [];
    markers.splice(insertion.index, 0, marker);
    routeWaypointMarkers.set(destinationId, markers);
    updateWaypointMarkerIndexes(destinationId);

    updatePolylinePreview(destinationId);
    void recalculateRouteWithWaypoints(destinationId);
    onDestinationSelected?.(destinationId);
  }

  function getMapContext() {
    const center = map.getCenter();
    const bounds = map.getBounds();
    return {
      center: { lat: center.lat, lng: center.lng },
      bounds: {
        west: bounds.getWest(),
        north: bounds.getNorth(),
        east: bounds.getEast(),
        south: bounds.getSouth(),
      },
    };
  }

  function setOrigin(coords, label = "Origin", focus = true) {
    if (originMarker) map.removeLayer(originMarker);

    originMarker = L.marker([coords.lat, coords.lng], { draggable: true, icon: originIcon() })
      .addTo(map)
      .bindPopup(`<b>Origin</b><br/>${label}`);

    originMarker.on("dragend", () => {
      const moved = originMarker.getLatLng();
      onOriginDragged?.({ lat: moved.lat, lng: moved.lng });
    });

    if (focus) {
      map.setView([coords.lat, coords.lng], 15);
      originMarker.openPopup();
    }
  }

  function setDestinationMarker(id, coords, label = "Destination", focus = false, options = {}) {
    const markerIcon = resolveDestinationIcon(options);
    const existing = destinationMarkers.get(id);
    if (existing) {
      existing.setLatLng([coords.lat, coords.lng]);
      existing.setPopupContent(`<b>${label}</b>`);
      existing.setIcon(markerIcon);
      if (focus) map.setView([coords.lat, coords.lng], 15);
      return;
    }

    const marker = L.marker([coords.lat, coords.lng], { draggable: true, icon: markerIcon })
      .addTo(map)
      .bindPopup(`<b>${label}</b>`);

    marker.on("click", () => onDestinationSelected?.(id));

    marker.on("dragend", () => {
      const moved = marker.getLatLng();
      onDestinationDragged?.(id, { lat: moved.lat, lng: moved.lng });
    });

    destinationMarkers.set(id, marker);
    if (focus) map.setView([coords.lat, coords.lng], 15);
  }

  function addDestinationMarkers(destinations = [], options = {}) {
    const { focus = false } = options;
    destinations.forEach((destination) => {
      if (!destination?.id || !destination?.coords) return;

      const lat = Number(destination.coords.lat);
      const lon = Number(destination.coords.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

      const markerStyle = resolveDestinationIcon({
        isFavorite: Boolean(destination.isFavorite),
        tone: destination.tone,
      });

      const existing = destinationMarkers.get(destination.id);
      if (existing) {
        existing.setLatLng([lat, lon]);
        existing.setIcon(markerStyle);
        existing.setPopupContent(`<b>${destination.label || "Destination"}</b>`);
      } else {
        const marker = L.marker([lat, lon], { draggable: true, icon: markerStyle })
          .addTo(map)
          .bindPopup(`<b>${destination.label || "Destination"}</b>`);

        marker.on("click", () => onDestinationSelected?.(destination.id));
        marker.on("dragend", () => {
          const moved = marker.getLatLng();
          onDestinationDragged?.(destination.id, { lat: moved.lat, lng: moved.lng });
        });

        destinationMarkers.set(destination.id, marker);
      }

      if (focus) map.setView([lat, lon], 15);
    });
  }

  function removeDestinationMarker(id) {
    clearRouteRecalcTimer(id);
    const marker = destinationMarkers.get(id);
    if (marker) {
      map.removeLayer(marker);
      destinationMarkers.delete(id);
    }

    const route = routeLayers.get(id);
    if (route) {
      map.removeLayer(route);
      routeLayers.delete(id);
    }

    const interaction = routeInteractionLayers.get(id);
    if (interaction) {
      map.removeLayer(interaction);
      routeInteractionLayers.delete(id);
    }

    clearWaypointMarkers(id);
    routeWaypointsById.delete(id);
    routeInteraction.clearWaypointsForRoute(id);

    const cleanup = routeHoverCleanup.get(id);
    cleanup?.();
    routeHoverCleanup.delete(id);
    onRouteHoverEnd?.(id);
  }

  function clearAllDestinationMarkers() {
    clearAllRouteRecalcTimers();
    destinationMarkers.forEach((marker) => map.removeLayer(marker));
    destinationMarkers.clear();
    clearAllWaypointMarkers();
    routeWaypointsById.clear();
    routeInteraction.clearAllRoutes();
  }

  function routeStyle(state) {
    if (state === "selected") return { color: "#1a73e8", weight: 6, opacity: 1, dashArray: null };
    if (state === "dim") return { color: "#1a73e8", weight: 4, opacity: 0.2, dashArray: "5, 10" };
    return { color: "#1a73e8", weight: 5, opacity: 0.6, dashArray: null };
  }

  function drawRoutes(results) {
    clearAllRouteRecalcTimers();
    clearRouteHoverSubscriptions();
    routeLayers.forEach((layer) => map.removeLayer(layer));
    routeInteractionLayers.forEach((layer) => map.removeLayer(layer));
    routeLayers.clear();
    routeInteractionLayers.clear();
    clearAllWaypointMarkers();
    routeWaypointsById.clear();
    routeInteraction.clearAllRoutes();

    results.forEach((item) => {
      const coords = item.route?.geometry?.coordinates;
      if (!coords) return;
      const latLngs = flipCoords(coords);
      if (latLngs.length < 2) return;
      replaceRouteLayers(item.id, latLngs);

      if (Array.isArray(item.waypoints) && item.waypoints.length > 0) {
        routeWaypointsById.set(item.id, item.waypoints.map(cloneWaypoint));
        routeInteraction.setWaypointsForRoute(item.id, item.waypoints.map(cloneWaypoint));

        const waypointMarkers = item.waypoints.map((point) => {
          const waypointType = point?.type === "shaping" ? "shaping" : "via";
          const marker = L.marker([point.lat, point.lng], {
            draggable: true,
            icon: routeWaypointIcon(Number.NaN, waypointType === "shaping"),
            zIndexOffset: 1200,
          }).addTo(map);
          marker.__waypointId = point.id;
          marker.__waypointType = waypointType;
          attachWaypointMarkerEvents(item.id, marker);
          return marker;
        });

        routeWaypointMarkers.set(item.id, waypointMarkers);
        updateWaypointMarkerIndexes(item.id);
      }
    });

    applyRouteSelection(activeDestinationId);
  }

  function applyRouteSelection(destinationId) {
    activeDestinationId = destinationId || null;

    routeLayers.forEach((layer, id) => {
      if (!activeDestinationId) {
        layer.setStyle(routeStyle("default"));
      } else {
        layer.setStyle(routeStyle(id === activeDestinationId ? "selected" : "dim"));
      }
    });
  }

  function selectDestination(destinationId, options = {}) {
    const { focusMap = false } = options;
    applyRouteSelection(destinationId);
    if (focusMap) focusDestination(destinationId);
  }

  function fitToRoutesAndOrigin() {
    const all = Array.from(routeLayers.values());
    if (all.length === 0) return;

    const merged = all[0].getBounds();
    all.slice(1).forEach((line) => merged.extend(line.getBounds()));
    if (originMarker) merged.extend(originMarker.getLatLng());
    map.fitBounds(merged.pad(0.2));
  }

  function focusDestination(id) {
    const marker = destinationMarkers.get(id);
    if (marker) {
      map.setView(marker.getLatLng(), 15);
      marker.openPopup();
    }

    const route = routeLayers.get(id);
    if (route) map.fitBounds(route.getBounds().pad(0.2));
  }

  function clearMap() {
    clearAllRouteRecalcTimers();
    if (originMarker) {
      map.removeLayer(originMarker);
      originMarker = null;
    }
    routeLayers.forEach((layer) => map.removeLayer(layer));
    routeInteractionLayers.forEach((layer) => map.removeLayer(layer));
    routeLayers.clear();
    routeInteractionLayers.clear();
    clearRouteHoverSubscriptions();
    clearAllDestinationMarkers();
    setWaypointDraggingCursor(false);
    activeDestinationId = null;
    map.setView([initialView.lat, initialView.lng], initialView.zoom);
  }

  function pickOnNextMapClick(callback) {
    const onceHandler = (event) => {
      callback?.({ lat: event.latlng.lat, lng: event.latlng.lng });
      map.off("click", onceHandler);
    };
    map.on("click", onceHandler);
  }

  return {
    map,
    getMapContext,
    setOrigin,
    setDestinationMarker,
    addDestinationMarkers,
    removeDestinationMarker,
    drawRoutes,
    applyRouteSelection,
    selectDestination,
    fitToRoutesAndOrigin,
    focusDestination,
    saveDestinationAsFavorite,
    pickOnNextMapClick,
    clearMap,
  };
}
