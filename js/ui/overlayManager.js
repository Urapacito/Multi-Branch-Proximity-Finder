export function createOverlayManager({ mapElement, loadingIndicator }) {
  let routeUpdatingOverlay = null;
  let routeHoverTooltip = null;
  let activeLoadingOps = 0;

  function ensureRouteUpdatingOverlay() {
    if (routeUpdatingOverlay) return routeUpdatingOverlay;
    if (!mapElement) return null;

    const parent = mapElement.parentElement;
    if (!parent) return null;

    routeUpdatingOverlay = document.createElement("div");
    routeUpdatingOverlay.id = "route-updating-overlay";
    routeUpdatingOverlay.className = "route-updating-overlay";
    routeUpdatingOverlay.innerHTML = `
      <span class="route-updating-spinner" aria-hidden="true"></span>
      <span class="route-updating-label">Updating Route...</span>
    `;

    parent.appendChild(routeUpdatingOverlay);
    return routeUpdatingOverlay;
  }

  function ensureRouteHoverTooltip() {
    if (routeHoverTooltip) return routeHoverTooltip;
    if (!mapElement) return null;

    const parent = mapElement.parentElement;
    if (!parent) return null;

    routeHoverTooltip = document.createElement("div");
    routeHoverTooltip.id = "route-hover-tooltip";
    routeHoverTooltip.className = "route-hover-tooltip";
    routeHoverTooltip.innerHTML = `
      <div class="route-hover-group">
        <span class="route-hover-value" data-role="from-start">0 m</span>
        <span class="route-hover-label">from start</span>
      </div>
      <span class="route-hover-divider" aria-hidden="true"></span>
      <div class="route-hover-group">
        <span class="route-hover-value" data-role="remaining">0 m</span>
        <span class="route-hover-label">to dest.</span>
      </div>
    `;

    parent.appendChild(routeHoverTooltip);
    return routeHoverTooltip;
  }

  function showLoading(label = "Updating Route...") {
    activeLoadingOps += 1;

    loadingIndicator.classList.remove("hidden");

    const overlay = ensureRouteUpdatingOverlay();
    if (!overlay) return;

    const labelEl = overlay.querySelector(".route-updating-label");
    if (labelEl) labelEl.textContent = label;

    overlay.classList.add("show");
  }

  function hideLoading(options = {}) {
    const force = options.force === true;
    if (force) {
      activeLoadingOps = 0;
    } else {
      activeLoadingOps = Math.max(0, activeLoadingOps - 1);
    }

    if (activeLoadingOps > 0) return;

    loadingIndicator.classList.add("hidden");

    const overlay = ensureRouteUpdatingOverlay();
    if (!overlay) return;

    overlay.classList.remove("show");
  }

  function showRouteHoverTooltip(payload) {
    const tooltip = ensureRouteHoverTooltip();
    if (!tooltip || !payload) return;

    const fromStartEl = tooltip.querySelector('[data-role="from-start"]');
    const remainingEl = tooltip.querySelector('[data-role="remaining"]');
    if (fromStartEl) fromStartEl.textContent = payload.fromStartText || "0 m";
    if (remainingEl) remainingEl.textContent = payload.remainingText || "0 m";

    tooltip.classList.toggle("show-remove-hint", Boolean(payload.isWaypoint));

    const offsetX = 18;
    const offsetY = -18;
    const x = Number(payload?.position?.x || 0) + offsetX;
    const y = Number(payload?.position?.y || 0) + offsetY;

    tooltip.style.left = `${x}px`;
    tooltip.style.top = `${y}px`;
    tooltip.classList.add("show");
  }

  function hideRouteHoverTooltip() {
    const tooltip = ensureRouteHoverTooltip();
    if (!tooltip) return;
    tooltip.classList.remove("show");
  }

  function setLoading(isLoading) {
    if (isLoading) {
      showLoading("Calculating routes...");
      return;
    }

    hideLoading({ force: true });
  }

  function setRouteUpdating(isUpdating) {
    if (isUpdating) {
      showLoading("Updating Route...");
      return;
    }

    hideLoading({ force: true });
  }

  function initialize() {
    ensureRouteUpdatingOverlay();
    ensureRouteHoverTooltip();
  }

  return {
    ensureRouteUpdatingOverlay,
    ensureRouteHoverTooltip,
    showLoading,
    hideLoading,
    showRouteHoverTooltip,
    hideRouteHoverTooltip,
    setLoading,
    setRouteUpdating,
    initialize,
  };
}
