export function createRowManager({ destinationRowsEl }) {
  const rowState = new Map();

  function createRowId() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    return `row-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  }

  function updateDestinationLabels() {
    const labels = destinationRowsEl.querySelectorAll(".row-label");
    labels.forEach((labelEl, index) => {
      const rowEl = labelEl.closest(".destination-row");
      if (!rowEl) return;

      const rowId = rowEl.dataset.rowId;
      const row = rowState.get(rowId);
      if (!row) return;

      const displayIndex = index + 1;
      labelEl.innerText = `Destination ${displayIndex}`;
      row.displayIndex = displayIndex;
      row.input.placeholder = `Enter destination ${displayIndex}`;
      row.input.setAttribute("aria-label", `Destination ${displayIndex}`);

      const removeBtn = rowEl.querySelector("button[data-action='remove']");
      if (removeBtn) {
        removeBtn.setAttribute("aria-label", `Remove Destination ${displayIndex}`);
      }
    });
  }

  function setRowVerificationState(rowId, state) {
    const row = rowState.get(rowId);
    if (!row) return;

    row.rowEl.classList.remove("imprecise", "verified");
    row.verificationState = state || "exact";

    if (state === "imprecise") {
      const tip = "Location may be imprecise. Please verify or drag the marker to correct.";
      row.rowEl.classList.add("imprecise");
      row.rowEl.title = tip;
      row.input.title = tip;
      return;
    }

    if (state === "verified") {
      const tip = "Location Verified";
      row.rowEl.classList.add("verified");
      row.rowEl.title = tip;
      row.input.title = tip;
      return;
    }

    row.rowEl.title = "";
    row.input.title = "";
  }

  function createRow(rowId) {
    const rowEl = document.createElement("div");
    rowEl.className = "destination-row";
    rowEl.dataset.rowId = String(rowId);

    rowEl.innerHTML = `
      <label class="row-label"></label>
      <div class="input-container">
        <input type="text" autocomplete="off" placeholder="Enter destination" />
        <button type="button" class="remove-btn" data-action="remove" data-row-id="${rowId}" aria-label="Remove destination">×</button>
        <div class="autocomplete-dropdown hidden"></div>
      </div>
    `;

    const input = rowEl.querySelector("input");
    const dropdown = rowEl.querySelector(".autocomplete-dropdown");
    const labelEl = rowEl.querySelector(".row-label");

    rowState.set(rowId, {
      rowId,
      rowEl,
      input,
      dropdown,
      labelEl,
      coords: null,
      label: "",
      provider: "manual",
      isFavorite: false,
      verificationState: "exact",
      sourceOfTruth: "query",
      displayIndex: 0,
    });

    return rowEl;
  }

  function addDestinationRow() {
    const rowId = createRowId();
    const rowEl = createRow(rowId);
    destinationRowsEl.appendChild(rowEl);
    updateDestinationLabels();

    return rowState.get(rowId);
  }

  function removeDestinationRow(rowId) {
    const row = rowState.get(rowId);
    if (!row) return;
    row.rowEl.remove();
    rowState.delete(rowId);
    updateDestinationLabels();
  }

  function getDestinationRows() {
    return Array.from(rowState.values());
  }

  function getFilledDestinationRows() {
    return getDestinationRows().filter((row) => row.input.value.trim());
  }

  function getRow(rowId) {
    return rowState.get(rowId);
  }

  return {
    createRowId,
    addDestinationRow,
    removeDestinationRow,
    updateDestinationLabels,
    setRowVerificationState,
    getDestinationRows,
    getFilledDestinationRows,
    getRow,
  };
}
