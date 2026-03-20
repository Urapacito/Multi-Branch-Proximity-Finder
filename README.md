# Multi-Branch Proximity Finder

A simple route planning web app for comparing multiple destinations from a single origin, with advanced fallback geocoding and interactive route editing. Built as simple as possible.

## Overview

Branch Routes helps answer a practical operational question:

> Given one origin and many branch addresses, which destination is closest by actual road network distance?

The app supports (so far):

- Multiple destination input rows with live autocomplete.
- Draggable markers for manual correction and verification.
- Ranked results (closest to furthest) based on road distance, not straight-line distance.
- Route-level interaction with waypoint injection/removal and immediate recalculation.
- Named Favorites saved in `localStorage` with one-click destination reuse.
- Explainable geocoding confidence states (`RED`, `ORANGE`, `GREY`) for operational trust.

## System Architecture

The codebase follows a 3-layer architecture with clear responsibility boundaries.

### 1) Presentation Layer

Primary responsibility: rendering, user interaction, and visual feedback.

Key modules:

- `index.html`: app shell, Leaflet + Font Awesome bootstrapping.
- `style.css`: logistics-focused styling, map controls, overlays, route interaction cursors.
- `js/ui/uiManager.js`: orchestration entrypoint for UI managers.
- `js/ui/modalFactory.js`: all modal creation/show/hide logic.
- `js/ui/overlayManager.js`: loading and hover overlays (`Updating Route...`, route hover tooltip).
- `js/ui/rowManager.js`: destination row state and label management.
- `js/controllers/mapController.js`: Leaflet rendering and map interaction control.

### 2) Application Layer

Primary responsibility: domain logic, orchestration rules, and state transitions.

Key modules:

- `js/main.js`: app flow coordinator (origin/destination resolution, route calculation, ranking, event wiring).
- `js/services/locationService.js`: geocoding resolution strategy, hierarchical fallback, interpolation pipeline.
- `js/services/routeInteractionService.js`: active route waypoint state, insertion ordering, waypoint lifecycle helpers.
- `js/services/geoMath.js`: geospatial math primitives (interpolation, anchor validation, split distance calculations).

### 3) Data Layer

Primary responsibility: provider communication, normalization, retries, and error semantics.

Key module:

- `js/repositories/geoRepository.js`: Photon/Nominatim/OSRM I/O with endpoint fallback, timeout, retry, and normalized return models.
- `js/repositories/favRepository.js`: localStorage-backed named favorites (`getAll`, `add`, `remove`).

## Separation of Concerns and Provider Swapping

A major design objective is provider-agnostic orchestration:

- The application layer asks for capabilities (`searchPhoton`, `searchNominatim`, `fetchOsrmRoute`) rather than hardcoding transport details.
- The data layer handles endpoint selection, retries, CORS-adjacent behavior, timeout policy, and error normalization.
- Swapping providers is localized to repository functions and mappers, without rewriting UI/controller logic.

This separation allows incremental upgrades such as:

- Replacing the routing backend.
- Introducing additional geocoders.
- Extending confidence logic without touching rendering code.

## Core Logic

### Hierarchical Interpolation Engine

When direct geocoding has gaps (common in dense urban addressing), Branch Routes applies an inward-out decomposition strategy plus interpolation:

1. Parse and decompose complex address tokens (including alley/slash structures).
2. Query providers from most specific form to broader forms.
3. Attempt strict exact house-number matching first.
4. If exact hits fail, locate valid numeric anchors around the target and interpolate coordinates.
5. If interpolation is not possible, degrade gracefully to best-guess fuzzy match.

Result state semantics:

- `RED`: verified/direct hit (`PHOTON` or direct resolved point).
- `ORANGE`: computed/interpolated estimate (`GEOMATH` approximation).
- `GREY`: low-confidence fuzzy fallback.

This model improves operational explainability: users can distinguish ground-truth results from computed estimates.

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