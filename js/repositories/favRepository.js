export class FavRepository {
  constructor(storageKey = "branchRoutesFavorites") {
    this.storageKey = storageKey;
  }

  buildId() {
    return `fav-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }

  normalizeFavorites(items) {
    let changed = false;
    const normalized = (Array.isArray(items) ? items : [])
      .map((item) => {
        const lat = Number(item?.lat);
        const lon = Number(item?.lon);
        const name = String(item?.name || "").trim();
        if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;

        let id = String(item?.id || "").trim();
        if (!id) {
          id = this.buildId();
          changed = true;
        }

        return { id, name, lat, lon };
      })
      .filter(Boolean);

    return { normalized, changed };
  }

  saveAll(items) {
    localStorage.setItem(this.storageKey, JSON.stringify(items));
    return items;
  }

  getAll() {
    try {
      const raw = localStorage.getItem(this.storageKey);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      const { normalized, changed } = this.normalizeFavorites(parsed);
      if (changed) this.saveAll(normalized);
      return normalized;
    } catch {
      return [];
    }
  }

  add(name, lat, lon) {
    const next = {
      name: String(name || "").trim(),
      lat: Number(lat),
      lon: Number(lon),
    };

    if (!next.name || !Number.isFinite(next.lat) || !Number.isFinite(next.lon)) {
      throw new Error("FAVORITE_INVALID_INPUT: name, lat, lon are required.");
    }

    const all = this.getAll();
    all.push({ ...next, id: this.buildId() });
    return this.saveAll(all);
  }

  delete(id) {
    const targetId = String(id || "").trim();
    const all = this.getAll();
    if (!targetId) {
      return all;
    }

    const next = all.filter((item) => String(item.id) !== targetId);
    return this.saveAll(next);
  }

  remove(index) {
    const all = this.getAll();
    if (!Number.isInteger(index) || index < 0 || index >= all.length) {
      return all;
    }

    return this.delete(all[index].id);
  }
}
