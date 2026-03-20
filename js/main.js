import { getAutocompleteSuggestions, resolveLocation, routeBetween } from "./services/locationService.js";
import { createMapController } from "./controllers/mapController.js";
import { createUiManager } from "./ui/uiManager.js";
import { FavRepository } from "./repositories/favRepository.js";

const ui = createUiManager();
const favRepo = new FavRepository();
const mapCtrl = createMapController({
  onOriginDragged: async (coords) => {
    ui.elements.originInput.value = `${coords.lat.toFixed(6)}, ${coords.lng.toFixed(6)}`;
    ui.setStatus("Origin moved. Recomputing routes...");
    await recalculateRoutes();
  },
  onDestinationDragged: async (rowId, coords) => {
    const row = ui.state.getDestinationRows().find((r) => r.rowId === rowId);
    if (!row) return;
    row.coords = coords;
    row.provider = row.isFavorite ? "favorite" : "manual";
    row.sourceOfTruth = "manual-drag";
    row.input.value = `${coords.lat.toFixed(6)}, ${coords.lng.toFixed(6)}`;
    ui.state.setRowVerificationState(rowId, "verified");
    mapCtrl.setDestinationMarker(rowId, row.coords, row.label || row.input.value, false, {
      tone: row.isFavorite ? "pink" : "default",
      isFavorite: row.isFavorite,
    });
    ui.setStatus(`Destination ${rowId} moved. Recomputing routes...`);
    await recalculateRoutes();
  },
  onDestinationSelected: (id) => selectResult(id),
  onRouteRecalculateStart: () => ui.showLoading("Updating Route..."),
  onRouteRecalculateEnd: () => ui.hideLoading({ force: true }),
  onRouteRecalculateError: (_destinationId, error) => {
    if (error?.message) ui.setStatus(`Route update failed: ${error.message}`, true);
  },
  onRouteHover: (_destinationId, payload) => {
    ui.showRouteHoverTooltip(payload);
  },
  onRouteHoverEnd: () => {
    ui.hideRouteHoverTooltip();
  },
  onRouteUpdated: (destinationId, payload) => {
    const index = latestResults.findIndex((item) => item.id === destinationId);
    if (index === -1 || !payload?.route) return;

    latestResults[index] = {
      ...latestResults[index],
      route: payload.route,
      roadDistanceKm: payload.route.distanceKm,
      waypoints: payload.waypoints || [],
    };

    latestResults = [...latestResults].sort((a, b) => a.roadDistanceKm - b.roadDistanceKm);
    ui.renderResults(latestResults);
  },
  onRequestFavoriteName: async ({ defaultName, destinationId }) => {
    const current = latestResults.find((item) => item.id === destinationId);
    const seed = defaultName || current?.name || "";
    return ui.openNamingModal(seed, { destinationId });
  },
  onFavoriteSaved: ({ name, lat, lon, destinationId }) => {
    const all = favRepo.add(name, lat, lon);

    const target = latestResults.find((item) => item.id === destinationId);
    if (target) {
      target.isFavorite = true;
      target.source = "FAVORITE";
      target.provider = "favorite";
    }

    if (destinationId) {
      ui.hideResultFavoriteButton(destinationId);
    }

    ui.renderFavorites(all);
    ui.setStatus(`Saved favorite: ${name}`);
    return all;
  },
});

let latestResults = [];
const getMapContext = () => mapCtrl.getMapContext();

async function resolveOrigin() {
  const value = ui.elements.originInput.value.trim();
  if (!value) return null;
  return resolveLocation(value, getMapContext());
}

async function recalculateRoutes() {
  const originResolved = await resolveOrigin();
  if (!originResolved) return;

  mapCtrl.setOrigin({ lat: originResolved.lat, lng: originResolved.lng }, originResolved.label, false);

  const unresolved = [];
  const routed = [];

  for (const row of ui.state.getFilledDestinationRows()) {
    let resolved = null;
    if (row.sourceOfTruth === "manual-drag" && row.coords) {
      const isFavoriteRow = Boolean(row.isFavorite) || String(row.provider || "").toUpperCase() === "FAVORITE";
      resolved = {
        ...row.coords,
        label: row.input.value,
        provider: row.provider || "manual",
        needsVerification: false,
        markerTone: isFavoriteRow ? "pink" : "default",
        isFavorite: isFavoriteRow,
      };
    } else if (row.coords) {
      const isFavoriteRow = Boolean(row.isFavorite) || String(row.provider || "").toUpperCase() === "FAVORITE";
      resolved = {
        ...row.coords,
        label: row.input.value,
        provider: row.provider || "manual",
        markerTone: isFavoriteRow ? "pink" : "default",
        isFavorite: isFavoriteRow,
      };
    }

    if (!resolved) {
      resolved = await resolveLocation(row.input.value.trim(), getMapContext());
    }

    if (!resolved) {
      unresolved.push({ row: row.displayIndex || "?", value: row.input.value, reason: "Address not resolved" });
      continue;
    }

    row.coords = { lat: resolved.lat, lng: resolved.lng };
    row.provider = resolved.provider || "manual";
    row.isFavorite = Boolean(resolved.isFavorite) || String(row.provider || "").toUpperCase() === "FAVORITE";
    if (row.sourceOfTruth !== "manual-drag") row.sourceOfTruth = "query";
    row.label = resolved.label || row.input.value;
    row.input.value = row.label;

    ui.state.setRowVerificationState(row.rowId, resolved.needsVerification ? "imprecise" : "exact");
    mapCtrl.setDestinationMarker(row.rowId, row.coords, row.label, false, {
      tone: resolved.markerTone || (row.isFavorite ? "pink" : "default"),
      isFavorite: row.isFavorite,
    });

    const route = await routeBetween({ lat: originResolved.lat, lng: originResolved.lng }, row.coords);
    if (!route) {
      unresolved.push({ row: row.displayIndex || "?", value: row.input.value, reason: "No drivable route" });
      continue;
    }

    routed.push({
      id: row.rowId,
      name: row.label,
      coords: row.coords,
      provider: row.provider,
      source: String(row.provider || "").toUpperCase() === "FAVORITE" ? "FAVORITE" : "QUERY",
      isFavorite: row.isFavorite,
      route,
      roadDistanceKm: route.distanceKm,
      method: resolved.method,
      waypoints: [],
    });
  }

  latestResults = routed.sort((a, b) => a.roadDistanceKm - b.roadDistanceKm);
  mapCtrl.drawRoutes(latestResults);
  mapCtrl.fitToRoutesAndOrigin();
  ui.renderResults(latestResults);

  if (unresolved.length > 0) {
    ui.setFieldError("destinations", `${unresolved.length} destination(s) could not be resolved.`);
    ui.setDestinationErrors(unresolved);
  }

  ui.setStatus(`Calculated ${latestResults.length} destination route(s).`);
}

function selectResult(destinationId) {
  ui.state.setActiveDestination(destinationId);
  mapCtrl.selectDestination(destinationId, { focusMap: false });
}

ui.bindOriginAutocomplete({
  onQuery: (query) => getAutocompleteSuggestions(query, getMapContext()),
  onSelect: (item) => {
    const label = item.label || item.address || item.name;
    ui.elements.originInput.value = label;
    mapCtrl.setOrigin({ lat: item.lat, lng: item.lng }, label, true);
  },
});

ui.bindDestinationAutocomplete({
  onQuery: (query) => getAutocompleteSuggestions(query, getMapContext()),
  onSelect: (rowId, item) => {
    const row = ui.state.getDestinationRows().find((r) => r.rowId === rowId);
    if (!row) return;
    row.coords = { lat: item.lat, lng: item.lng };
    row.provider = item.source || "photon";
    row.isFavorite = false;
    row.sourceOfTruth = "query";
    row.label = item.label || item.address || item.name;
    row.input.value = row.label;
    ui.state.setRowVerificationState(rowId, "exact");
    mapCtrl.setDestinationMarker(rowId, row.coords, row.label, true, { tone: "default" });
  },
});

ui.bindDelegatedActions({
  onRemoveRow: (rowId) => {
    ui.removeDestinationRow(rowId);
    mapCtrl.removeDestinationMarker(rowId);
    latestResults = latestResults.filter((item) => item.id !== rowId);
    ui.renderResults(latestResults);
    mapCtrl.applyRouteSelection(null);
  },
  onResultFocus: (id) => {
    ui.state.setActiveDestination(id);
    mapCtrl.selectDestination(id, { focusMap: true });
  },
  onResultSelect: (id) => selectResult(id),
  onResultFavorite: async (id) => {
    const match = latestResults.find((item) => item.id === id);
    const saved = await mapCtrl.saveDestinationAsFavorite(id, match?.name || "");
    if (!saved) return;
  },
});

ui.bindFavoriteControls({
  onOpenFavorites: () => favRepo.getAll(),
  onSelectFavorite: (favoriteId) => {
    const favorites = favRepo.getAll();
    const favorite = favorites.find((item) => String(item.id) === String(favoriteId));
    if (!favorite) return;

    const row = ui.addDestinationRow();
    row.coords = { lat: Number(favorite.lat), lng: Number(favorite.lon) };
    row.provider = "favorite";
    row.isFavorite = true;
    row.sourceOfTruth = "manual-drag";
    row.label = favorite.name;
    row.input.value = `${favorite.name} (${row.coords.lat.toFixed(6)}, ${row.coords.lng.toFixed(6)})`;
    ui.state.setRowVerificationState(row.rowId, "verified");

    mapCtrl.setDestinationMarker(row.rowId, row.coords, favorite.name, true, { tone: "pink" });
    ui.setStatus(`Loaded favorite: ${favorite.name}`);
  },
  onDeleteFavorite: (favoriteId) => {
    const next = favRepo.delete(favoriteId);
    return next;
  },
});

ui.elements.addDestinationBtn.addEventListener("click", () => ui.addDestinationRow());
ui.elements.calculateBtn.addEventListener("click", async () => {
  ui.clearFieldErrors();
  ui.setLoading(true);
  try { await recalculateRoutes(); } finally { ui.setLoading(false); }
});
ui.elements.clearBtn.addEventListener("click", () => {
  mapCtrl.clearMap();
  ui.renderResults([]);
  ui.setStatus("Map and results cleared.");
});

ui.elements.useLocationBtn.addEventListener("click", () => {
  if (!navigator.geolocation) {
    ui.setStatus("Geolocation is not supported by this browser.", true);
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      ui.elements.originInput.value = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
      mapCtrl.setOrigin({ lat, lng }, "My Location", true);
      ui.setStatus("Current location loaded.");
    },
    () => ui.setStatus("Unable to access your location.", true),
    { enableHighAccuracy: true, timeout: 10000 }
  );
});

ui.elements.pickOnMapBtn.addEventListener("click", () => {
  ui.setStatus("Click on the map to set origin.");
  mapCtrl.pickOnNextMapClick((coords) => {
    ui.elements.originInput.value = `${coords.lat.toFixed(6)}, ${coords.lng.toFixed(6)}`;
    mapCtrl.setOrigin(coords, "Picked Origin", true);
    ui.setStatus("Origin set from map click.");
  });
});

ui.addDestinationRow();
ui.setStatus("Ready. Add destinations and calculate routes.");
