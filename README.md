# Multi-Branch Proximity Finder
## Sophisticated Geospatial Resolution Engine

A production-grade route planning system with advanced address resolution and interactive map manipulation, designed for operational clarity and scalable geocoding accuracy.

**Core Mission:**
> Bridge the gap between vague, complex user input (Nested addresses, manual corrections) and precise map coordinates via a deterministic confidence-grading pipeline.

**Use Case:**
> Given one origin and many branch addresses, which destination is closest by actual road network distance? And how confident are we in each geocoded location?

## System Architecture

The system employs a **3-layer modular architecture** with explicit separation of concerns, enabling independent testing, provider swapping, and algorithmic evolution.

### Layer 1: Data Access Layer (Repositories)

**Responsibility:** Clean I/O abstraction, provider communication, resilience.

Key modules:

- `js/repositories/geoRepository.js`:
  - Multi-endpoint fallback (Photon, Nominatim, OSRM).
  - Automatic retry with backoff on timeout/rate-limit.
  - Timeout enforcement (12 seconds per request).
  - Normalized response models across providers.
  - CORS-aware request headers; provider-specific header suppression.

- `js/repositories/favRepository.js`:
  - localStorage-backed coordinate bookmarking.
  - `getAll()`, `add()`, `remove()` CRUD interface.
  - Lightweight persistence for repeat destinations.

**Benefits:**
- Swappable providers without touching application logic.
- Centralized error handling and retry policy.
- Guaranteed timeout enforcement across all endpoints.

### Layer 2: Orchestration Services

**Responsibility:** Domain logic, state management, confidence pipelines.

Key modules:

- `js/services/locationService.js` (Main Coordinator):
  - Entry point for address resolution (`resolveLocation(inputValue, mapContext)`).
  - Orchestrates the 6-phase resolution pipeline.
  - LRU caching of finalized results.
  - Dependency injection of API clients for testability.

- `js/services/modules/addressUtils.js` (Parsing & Normalization):
  - Vietnamese diacritical normalization (đ → d).
  - Hierarchical address decomposition (slash notation: `56/1/2`, alley notation: `38 Alley 231`).
  - Cache key generation with 4-decimal coordinate precision.
  - Area anchor extraction for territory-bounded searches.

- `js/services/modules/scoringEngine.js` (Confidence Grading):
  - Multi-dimensional heuristic scoring (house number, street, district, POI type).
  - Vectorized single-pass scoring for performance.
  - Territory-mismatch safety valve (prevents marker teleportation).
  - Result formatters for manual, exact, and fuzzy results.

- `js/services/modules/interpolationService.js` (Geometric Logic):
  - Haversine distance calculations in plain JavaScript (no Leaflet dependency).
  - Bounding anchor discovery for numeric addresses.
  - Curved path interpolation along street geometries.
  - Fallback single-anchor positioning.

- `js/services/geoMath.js` (Geospatial Math Primitives):
  - Linear interpolation between two coordinates.
  - Path-following with distance offset (Alley/Ngõ precision).
  - Logical sequence validation for neighbors.
  - Anchor context validation.

- `js/services/routeInteractionService.js`:
  - Waypoint lifecycle state management.
  - Route manipulation (insertion, removal, reordering).

### Layer 3: Presentation & Controllers

**Responsibility:** Rendering, user interaction, visual feedback.

Key modules:

- `js/main.js`: App flow orchestration (input resolution, route ranking, event wiring).
- `js/controllers/mapController.js`: Leaflet rendering and map interaction.
- `js/ui/uiManager.js`: UI state coordination.
- `js/ui/*`: Modal factories, overlay management, row state, debounce utilities.

---

## The Resolution Pipeline
### 6-Phase Address Decomposition & Resolution

The system resolves user input through an ordered confidence waterfall:

#### **Phase 1: Cache Check**
- Inspect LRU result cache (50-entry limit) for exact match.
- Return cached result immediately if hit (RTT: < 50ms).

#### **Phase 2: Coordinate Bypass**
- Attempt manual coordinate parsing (strict: requires decimal point).
- Format: `21.0, 105.8` (accepted); `56/1` (rejected as address, not coords).
- Return manual result with `confidence: 1.0`.

#### **Phase 3: Decomposition**
- Parse complex address tokens into hierarchical stack:
  - **Slash notation:** `56/1/2 Road` → `["56/1/2 Road", "56/1 Road", "56 Road"]`
  - **Alley notation:** `38 alley 231 Street` → `["38 alley 231 Street", "Alley 231 Street", "38 Street"]`
- Extract area anchor (Ward/District/City) for bounded searches.
- Calculate peel depth in meters for per-layer geometric offset.

#### **Phase 4: Parallel Search Execution**
- For each hierarchical layer, launch **simultaneous** Photon + Nominatim queries.
- Use `Promise.all()` to minimize RTT per layer (40% latency reduction vs. sequential).
- Implement global API delay post-batch to respect provider rate limits.

#### **Phase 5: Ordered Resolution Attempts**
For each search result batch:

1. **Exact Match** (`confidence: "high"`):
   - Detect house number or alley token in result metadata.
   - Apply peel-depth offset along geometry path if available.
   - Return immediately with `markerTone: "default"`.

2. **Geometric Interpolation** (`confidence: 0.8`, `isInterpolated: true`):
   - Find numeric neighbors (±2, ±4, ... ±30 increment).
   - Compute linear interpolation between anchors.
   - Use curved path geometry if available (GeoMath.followPathDistance).
   - Return virtual house node with `markerTone: "orange"`.

3. **Alley Offset** (`confidence: 0.6`, Vietnamese-specific):
   - Detect "Alley XYZ" token in query and results.
   - Apply 20-meter perpendicular offset from street centerline.

4. **Fuzzy Best-Guess** (`confidence: 0.5`, `isFuzzy: true`):
   - Score all accumulated results across all layers.
   - Apply -250 penalty for territory mismatch (safety valve).
   - Return highest-scoring result with `markerTone: "GREY"`.

#### **Phase 6: Cache Storage**
- Store finalized result in LRU cache with stable key.
- Key format: `${raw}|${lat.toFixed(4)}|${lng.toFixed(4)}`.

---

## Technical Features for Developers

### 1. LRU Caching Strategy

**Why:** 
- Minimize redundant API calls for repeat queries.
- Reduce external API costs and latency.

**How:**
- 50-entry limit with automatic LRU eviction.
- Separate cache for finalized location results and Photon query anchors.
- Cache key stability: normalized query + center coordinates (4 decimals).

**Example:**
```javascript
// First call: network I/O (500ms)
const result = await resolveLocation("56/1 Flower Street, Lake Ward", mapContext);

// Identical follow-up call: cache hit (< 50ms)
const same = await resolveLocation("56/1 Flower Street, Lake Ward", mapContext);
```

### 2. Dependency Injection

**Why:**
- Keep core logic provider-agnostic and testable.
- Enable swappable mock API clients for unit testing.

**How:**
- Services accept injected dependencies rather than importing directly.
- Main coordinator (`locationService.js`) wires up API clients at runtime.
- Interpolator accepts `deps` object: `{ searchPhoton, searchNominatim, extractStreetFragment, ... }`.

**Example:**
```javascript
// Coordinator injects dependencies:
const result = await Interpolator.buildInterpolationCandidate(
  query,
  targetHouse,
  district,
  mapContext,
  seedResults,
  {
    searchPhoton,     // Injected from geoRepository
    searchNominatim,  // Injected from geoRepository
    extractStreetFragment,  // Injected from addressUtils
    inferStreetFromResults, // Injected from addressUtils
  }
);
```

### 3. Resilience & Automatic Fallbacks

**Provider Switching:**
- Photon → Nominatim: If Photon fails, automatically retry with Nominatim.
- OSRM Primary ↔ Fallback: If primary OSRM endpoint times out, switch to secondary.

**Rate-Limit Handling:**
- Detect HTTP 429 response.
- Parse `Retry-After` header (seconds or HTTP date).
- Automatically backoff and retry within timeout window.
- Return normalized error to application layer for UI feedback.

**Timeout Enforcement:**
- 12-second timeout per request (configurable).
- AbortController-based cancellation.
- Prevents hanging requests from stalling the UI.

**API Delay Pacing:**
- 400ms delay between batch geocoding requests.
- Prevents provider rate-limit triggers during hierarchical searches.

---

## LocationObject Data Structure

All resolution methods return a standardized `LocationObject` for UI rendering and business logic:

```javascript
{
  lat: number,                    // Decimal latitude (-90 to 90)
  lng: number,                    // Decimal longitude (-180 to 180)
  label: string,                  // Human-friendly display label
  
  // Confidence & semantics
  confidence: number | string,    // 1.0 (manual), "high" (exact), 0.8 (interpolated), 0.7 (single anchor), 0.6 (alley), 0.5 (fuzzy)
  confidenceLabel: string,        // "MANUAL_COORDS", "EXACT", "INTERPOLATED", "FUZZY_GUESS", etc.
  matchType: string,              // "exact", "interpolated", "approximate", "best-guess"
  
  // UI metadata
  markerTone: string,             // "default" (high confidence), "orange" (computed), "grey" (low confidence), "pink" (favorite)
  provider: string,               // "manual", "PHOTON", "NOMINATIM", "GEOMATH_INTERPOLATED", etc.
  
  // Transparency flags
  isInterpolated: boolean,        // True if virtual node (computed between anchors)
  isFuzzy: boolean,               // True if low-confidence best-guess
  isImprecise: boolean,           // True if geometric approximation
  needsVerification: boolean,     // True if user should verify before dispatch
  
  // Optional fields
  method: string,                 // "PHOTON (EXACT)", "GEOMATH (APPROXIMATE)", etc.
  sourceType: string,             // Result POI type from provider
  snappedToPoi: boolean,          // True if snapped to nearby POI
  districtMatch: boolean,         // True if matches expected district anchor
}
```

**UI Rendering Examples:**
```javascript
// High-confidence result (green marker)
if (location.confidence === "high") mapMarker.setStyle({ color: "green" });

// Interpolated result (orange marker with caution badge)
if (location.isInterpolated) {
  mapMarker.setStyle({ color: "orange" });
  showBadge("COMPUTED", "This location was interpolated.");
}

// Fuzzy result (grey marker, requires verification)
if (location.isFuzzy) {
  mapMarker.setStyle({ color: "grey" });
  showBadge("LOW CONFIDENCE", "Verify before dispatch.");
}
```

---

## Provider-Agnostic Orchestration

A core design principle enables incremental provider migration without rewriting application logic:

- **API abstraction:** The application layer calls `searchPhoton()` and `searchNominatim()`, not hardcoded provider details.
- **Error normalization:** All provider errors (timeouts, 429, CORS) are normalized to standard exception types.
- **Request policy:** Timeout, retry count, backoff strategy defined once in the data layer.
- **Response mapping:** Provider-specific response formats are normalized to `LocationObject` in the data layer.

**Migration path example:**
- Replace `https://router.project-osrm.org` → your private OSRM instance.
- Update only `geoRepository.js` endpoint URLs.
- No changes needed in `locationService.js`, `uiManager.js`, or `mapController.js`.

### Interactive Route Manipulation

The route interaction subsystem uses a `Ghost Path` technique for high-precision UX:

- Visible route polyline: user-facing blue route.
- Interaction polyline: thick, invisible path on top (`weight: 20`, `opacity: 0`) to enlarge the hover/drag hit-box.

Benefits:

- Reliable cursor capture on thin route geometry.
- Stable hover tooltip updates with snapped split-distance math.
- Practical desktop usability for dense map segments.

### Draggable Waypoint Lifecycle

Waypoint lifecycle is explicitly managed as stateful application logic:

1. User inserts a waypoint via route interaction.
2. Waypoint gets stable internal ID and marker binding.
3. Drag operations update temporary preview geometry.
4. Drag end triggers formal OSRM recalculation with full point sequence.
5. Context menu / double-click removes waypoint by ID and immediately recalculates route.
6. Marker object is removed from the map to avoid ghost artifacts.

This keeps route geometry, UI markers, and internal waypoint arrays consistent across all transitions.

### Named Favorites Lifecycle

Favorites are treated as first-class reusable coordinates:

1. User clicks the heart action on a result card.
2. A naming modal captures a human-friendly label.
3. The app saves `{ name, lat, lon }` to `localStorage` through `FavRepository`.
4. Favorite dropdown (next to Add Destination) renders all saved entries.
5. Selecting a favorite creates a destination row prefilled with coordinates and renders a light-pink marker (`marker-pink`) for quick visual differentiation.

## Performance and Optimization

### Request Debouncing and Flood Control

Branch Routes applies multiple anti-flood protections:

- Input autocomplete debounce for origin/destination typing.
- Provider pacing delays in geocoding fallback loops.
- Throttled route hover computations for high-frequency mouse events.

Together these controls reduce API pressure and avoid jitter under rapid UI input.

### State-Managed UI Overlays

Loading feedback is reference-counted and explicit:

- `showLoading()` increments active loading operations.
- `hideLoading()` decrements or force-resets state.
- Overlay visibility is driven by operation state, preventing spinner leaks.

This is especially important around async route recalculation and recoverable provider failures.

## Visuals and UX

Branch Routes uses a practical, logistics-oriented UI language:

- Font Awesome 6 floating control stack for quick global actions.
- Structured sidebar with sticky controls for repeated operational use.
- Distance chips, method badges, and verification cues for fast decision-making.
- Hover route tooltip for split-distance context (`from start` / `to destination`).
- Favorite control stack with heart actions, naming modal, and saved-location dropdown for repeat operations.

## Installation

### Requirements

- Modern browser with ES module support.
- Network access to external map/geocoding/routing providers.

### Run locally

Because the project uses ES modules (`type="module"`), run via a local HTTP server (not `file://`).

Option 1: VS Code Live Server

1. Open the project folder.
2. Start Live Server.
3. Open the generated localhost URL.

Option 2: Python simple server

```bash
cd "path to the project"
python -m http.server 8080
```

Then open:

- `http://localhost:8080`


Option 3: Vite
1. Init and install (if not yet)
```bash
npm install
```
2. Run 
```bash
npm run dev
```

## API Providers

### Geocoding

- Photon
  - `https://photon.komoot.io/api`
  - `https://photon.komoot.de/api`
- Nominatim
  - `https://nominatim.openstreetmap.org/search`
  - `https://nominatim.osm.ch/search`

### Routing

- OSRM (primary and fallback)
  - `https://router.project-osrm.org/route/v1/driving`
  - `https://routing.openstreetmap.de/routed-car/route/v1/driving`

### Provider Resilience Strategy

Repository-level behavior includes:

- Multi-endpoint fallback.
- Timeout handling.
- Retry with backoff.
- Rate-limit awareness (`429` / `Retry-After`).
- Error normalization for application-level handling.

## Project Structure

```text
index.html
style.css
js/
  main.js
  controllers/
    mapController.js
  repositories/
    favRepository.js
    geoRepository.js
  services/
    geoMath.js
    locationService.js
    routeInteractionService.js
  ui/
    uiManager.js
    modalFactory.js
    overlayManager.js
    rowManager.js
    debounceUtil.js
```

## Engineering Notes

This project intentionally favors maintainable backend-style patterns in frontend code:

- Explicit orchestration (`main.js`).
- Modular service contracts.
- Deterministic state transitions for map interaction.
- Failure-aware async boundaries.

That approach keeps Branch Routes scalable as provider logic, geospatial math, and route interaction complexity continue to grow.

## Support me? 
Ehe update later.