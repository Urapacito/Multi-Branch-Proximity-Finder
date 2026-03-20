import { debounceByKey } from "./debounceUtil.js";
import { createModalFactory } from "./modalFactory.js";
import { createOverlayManager } from "./overlayManager.js";
import { createRowManager } from "./rowManager.js";

const AUTOCOMPLETE_DELAY = 500;
const INTRO_SEEN_KEY = "introSeen";
const DEFAULT_SUPPORT_URL = "";

export function createUiManager() {
  const originInput = document.getElementById("originInput");
  const originAutocomplete = document.getElementById("originAutocomplete");
  const destinationRowsEl = document.getElementById("destinationRows");
  const addDestinationBtn = document.getElementById("addDestinationBtn");
  const favoriteBtn = document.getElementById("favoriteBtn");
  const favoriteDropdown = document.getElementById("favoriteDropdown");
  const useLocationBtn = document.getElementById("useLocationBtn");
  const pickOnMapBtn = document.getElementById("pickOnMapBtn");
  const calculateBtn = document.getElementById("calculateBtn");
  const clearBtn = document.getElementById("clearBtn");
  const statusText = document.getElementById("statusText");
  const statusMessage = document.getElementById("statusMessage");
  const loadingIndicator = document.getElementById("loadingIndicator");
  const originError = document.getElementById("originError");
  const destinationsError = document.getElementById("destinationsError");
  const destinationsErrorList = document.getElementById("destinationsErrorList");
  const resultsList = document.getElementById("resultsList");
  const resultCount = document.getElementById("resultCount");
  const mapElement = document.getElementById("map");

  let activeDestinationId = null;
  const debounceTimers = new Map();

  const modalFactory = createModalFactory({
    introSeenKey: INTRO_SEEN_KEY,
    defaultSupportUrl: DEFAULT_SUPPORT_URL,
  });

  const overlayManager = createOverlayManager({
    mapElement,
    loadingIndicator,
  });

  const rowManager = createRowManager({
    destinationRowsEl,
  });

  function setStatus(message, isError = false) {
    statusMessage.textContent = message;
    statusText.style.color = isError ? "#9f1239" : "#2f4e7a";
  }

  function clearFieldErrors() {
    originError.textContent = "";
    destinationsError.textContent = "";
    destinationsErrorList.innerHTML = "";
  }

  function setFieldError(field, message) {
    if (field === "origin") originError.textContent = message;
    if (field === "destinations") destinationsError.textContent = message;
  }

  function setDestinationErrors(items) {
    destinationsErrorList.innerHTML = "";
    items.forEach((item) => {
      const li = document.createElement("li");
      li.textContent = `Row ${item.row}: ${item.reason} (${item.value})`;
      destinationsErrorList.appendChild(li);
    });
  }

  function hideDropdown(dropdown) {
    dropdown.classList.add("hidden");
    dropdown.innerHTML = "";
  }

  function renderAutocomplete(dropdown, items, onSelect) {
    dropdown.innerHTML = "";
    if (!items.length) {
      hideDropdown(dropdown);
      return;
    }

    items.forEach((item) => {
      const el = document.createElement("div");
      el.className = "autocomplete-item";
      el.innerHTML = `
        <div class="autocomplete-name">${item.name || item.label || "Unknown"}</div>
        <div class="autocomplete-address">${item.address || item.label || ""}</div>
      `;
      el.addEventListener("click", () => onSelect(item));
      dropdown.appendChild(el);
    });

    dropdown.classList.remove("hidden");
  }

  function setActiveDestination(destinationId) {
    activeDestinationId = destinationId || null;
    const cards = resultsList.querySelectorAll(".result-item");
    cards.forEach((card) => {
      const id = card.dataset.destinationId;
      card.classList.toggle("selected-card", activeDestinationId === id);
    });
  }

  function renderResults(results) {
    resultsList.innerHTML = "";
    resultCount.textContent = `${results.length} result${results.length === 1 ? "" : "s"}`;

    results.forEach((item, index) => {
      const source = String(item.source || item.provider || "manual").toUpperCase();
      const canSaveFavorite = source !== "FAVORITE";
      const favoriteActionHtml = canSaveFavorite
        ? `<button class="favorite-marker-btn" type="button" data-action="favorite" data-destination-id="${item.id}"><i class="fa-solid fa-heart" aria-hidden="true"></i> Save Favorite</button>`
        : "";

      const li = document.createElement("li");
      li.className = "result-item";
      li.dataset.destinationId = String(item.id);
      li.innerHTML = `
        <div class="result-top">
          <p class="result-name">${index + 1}. ${item.name}</p>
          <span class="distance-chip">Road ${item.roadDistanceKm.toFixed(2)} km</span>
        </div>
        <p class="result-meta">Source: ${source}</p>
        <p class="result-meta">ETA: ${item.route.durationMin.toFixed(0)} min (approx.)</p>
        <span class="result-method">Method: ${item.method || "MANUAL"}</span>
        <button class="add-marker-btn" type="button" data-action="focus" data-destination-id="${item.id}">Focus Marker</button>
        ${favoriteActionHtml}
      `;
      resultsList.appendChild(li);
    });

    setActiveDestination(activeDestinationId);
  }

  function openNamingModal(defaultName = "") {
    return modalFactory.showNamingModal(defaultName);
  }

  function renderFavorites(items = []) {
    if (!favoriteDropdown) return;

    favoriteDropdown.innerHTML = "";
    if (!Array.isArray(items) || items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "favorite-empty";
      empty.textContent = "No saved favorites yet.";
      favoriteDropdown.appendChild(empty);
      return;
    }

    items.forEach((item, index) => {
      const row = document.createElement("div");
      row.className = "favorite-item";

      const selectBtn = document.createElement("button");
      selectBtn.type = "button";
      selectBtn.className = "favorite-select-btn";
      selectBtn.dataset.action = "favorite-select";
      selectBtn.dataset.favoriteId = String(item.id || "");
      selectBtn.innerHTML = `
        <span class="favorite-item-name">${item.name || `Favorite ${index + 1}`}</span>
        <span class="favorite-item-coords">${Number(item.lat).toFixed(5)}, ${Number(item.lon).toFixed(5)}</span>
      `;

      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.className = "favorite-delete-btn";
      deleteBtn.dataset.action = "favorite-delete";
      deleteBtn.dataset.favoriteId = String(item.id || "");
      deleteBtn.setAttribute("aria-label", `Delete favorite ${item.name || index + 1}`);
      deleteBtn.textContent = "×";

      row.appendChild(selectBtn);
      row.appendChild(deleteBtn);
      favoriteDropdown.appendChild(row);
    });
  }

  function showFavoritesDropdown() {
    if (!favoriteDropdown || !favoriteBtn) return;
    favoriteDropdown.classList.remove("hidden");
    favoriteBtn.setAttribute("aria-expanded", "true");
  }

  function hideFavoritesDropdown() {
    if (!favoriteDropdown || !favoriteBtn) return;
    favoriteDropdown.classList.add("hidden");
    favoriteBtn.setAttribute("aria-expanded", "false");
  }

  function bindFavoriteControls({ onOpenFavorites, onSelectFavorite, onDeleteFavorite }) {
    if (!favoriteBtn || !favoriteDropdown) return;

    favoriteBtn.addEventListener("click", async () => {
      if (!favoriteDropdown.classList.contains("hidden")) {
        hideFavoritesDropdown();
        return;
      }

      const favorites = await onOpenFavorites?.();
      renderFavorites(favorites || []);
      showFavoritesDropdown();
    });

    favoriteDropdown.addEventListener("click", (event) => {
      const deleteButton = event.target.closest("button[data-action='favorite-delete']");
      if (deleteButton) {
        event.stopPropagation();
        const favoriteId = String(deleteButton.dataset.favoriteId || "");
        const nextItems = onDeleteFavorite?.(favoriteId);
        if (Array.isArray(nextItems)) {
          renderFavorites(nextItems);
        }
        return;
      }

      const item = event.target.closest("button[data-action='favorite-select']");
      if (!item) return;
      const favoriteId = String(item.dataset.favoriteId || "");
      onSelectFavorite?.(favoriteId);
      hideFavoritesDropdown();
    });

    document.addEventListener("click", (event) => {
      if (favoriteDropdown.classList.contains("hidden")) return;
      const inDropdown = favoriteDropdown.contains(event.target);
      const inButton = favoriteBtn.contains(event.target);
      if (!inDropdown && !inButton) hideFavoritesDropdown();
    });
  }

  function bindOriginAutocomplete({ onQuery, onSelect }) {
    originInput.addEventListener("input", () => {
      debounceByKey(debounceTimers, "origin", async () => {
        const query = originInput.value.trim();
        if (query.length < 2) {
          hideDropdown(originAutocomplete);
          return;
        }
        const suggestions = await onQuery(query);
        renderAutocomplete(originAutocomplete, suggestions, onSelect);
      }, AUTOCOMPLETE_DELAY);
    });

    originInput.addEventListener("blur", () => setTimeout(() => hideDropdown(originAutocomplete), 120));
  }

  function bindDestinationAutocomplete({ onQuery, onSelect }) {
    destinationRowsEl.addEventListener("input", (event) => {
      const input = event.target.closest("input");
      if (!input) return;

      const rowEl = input.closest(".destination-row");
      const rowId = rowEl?.dataset.rowId;
      const row = rowManager.getRow(rowId);
      if (!row) return;

      row.coords = null;
      row.provider = "manual";
      row.sourceOfTruth = "query";
      rowManager.setRowVerificationState(rowId, "exact");

      debounceByKey(debounceTimers, `dest-${rowId}`, async () => {
        const query = input.value.trim();
        if (query.length < 2) {
          hideDropdown(row.dropdown);
          return;
        }
        const suggestions = await onQuery(query);
        renderAutocomplete(row.dropdown, suggestions, (item) => onSelect(rowId, item));
      }, AUTOCOMPLETE_DELAY);
    });

    destinationRowsEl.addEventListener("blur", (event) => {
      const rowEl = event.target.closest(".destination-row");
      if (!rowEl) return;
      const row = rowManager.getRow(rowEl.dataset.rowId);
      if (!row) return;
      setTimeout(() => hideDropdown(row.dropdown), 120);
    }, true);
  }

  function bindDelegatedActions({ onRemoveRow, onResultFocus, onResultSelect, onResultFavorite }) {
    destinationRowsEl.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-action='remove']");
      if (!button) return;
      const rowId = button.dataset.rowId;
      onRemoveRow(rowId);
    });

    resultsList.addEventListener("click", (event) => {
      const favoriteBtnEl = event.target.closest("button[data-action='favorite']");
      if (favoriteBtnEl) {
        event.stopPropagation();
        onResultFavorite?.(favoriteBtnEl.dataset.destinationId);
        return;
      }

      const focusBtn = event.target.closest("button[data-action='focus']");
      if (focusBtn) {
        event.stopPropagation();
        onResultFocus(focusBtn.dataset.destinationId);
        return;
      }

      const card = event.target.closest(".result-item");
      if (!card) return;
      onResultSelect(card.dataset.destinationId);
    });
  }

  modalFactory.initIntroductionModal();
  overlayManager.initialize();

  return {
    elements: {
      originInput,
      addDestinationBtn,
      favoriteBtn,
      useLocationBtn,
      pickOnMapBtn,
      calculateBtn,
      clearBtn,
    },
    state: {
      getDestinationRows: rowManager.getDestinationRows,
      getFilledDestinationRows: rowManager.getFilledDestinationRows,
      setActiveDestination,
      setRowVerificationState: rowManager.setRowVerificationState,
      updateDestinationLabels: rowManager.updateDestinationLabels,
    },
    addDestinationRow: rowManager.addDestinationRow,
    removeDestinationRow: rowManager.removeDestinationRow,
    setStatus,
    showLoading: overlayManager.showLoading,
    hideLoading: overlayManager.hideLoading,
    showRouteHoverTooltip: overlayManager.showRouteHoverTooltip,
    hideRouteHoverTooltip: overlayManager.hideRouteHoverTooltip,
    openNamingModal,
    renderFavorites,
    bindFavoriteControls,
    hideFavoritesDropdown,
    setLoading: overlayManager.setLoading,
    setRouteUpdating: overlayManager.setRouteUpdating,
    clearFieldErrors,
    setFieldError,
    setDestinationErrors,
    renderResults,
    bindOriginAutocomplete,
    bindDestinationAutocomplete,
    bindDelegatedActions,
  };
}
