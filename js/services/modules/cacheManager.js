/**
 * Persistent LRU Cache implementation.
 * Connects RAM (Map) to Disk (LocalStorage) for 0ms repeat searches.
 */
const STORAGE_KEY = "PROXIMITY_CACHE_V1";

export class LRULocationCache {
  constructor(maxSize = 100) { // Increased to 100 for better persistence
    this.maxSize = maxSize;
    this.cache = new Map();
    this._loadFromDisk();
  }

  // NEW: Load everything from LocalStorage when the app starts
  _loadFromDisk() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const items = JSON.parse(saved);
        // items should be an array of [key, value] pairs
        this.cache = new Map(items.slice(-this.maxSize));
      }
    } catch (e) {
      console.warn("Could not hydrate cache from disk", e);
    }
  }

  // NEW: Save the current state to LocalStorage
  _saveToDisk() {
    try {
      const data = JSON.stringify(Array.from(this.cache.entries()));
      localStorage.setItem(STORAGE_KEY, data);
    } catch (e) {
      // If quota exceeded, clear old entries
      if (e.name === 'QuotaExceededError') {
        const halfSize = Math.floor(this.cache.size / 2);
        const keys = Array.from(this.cache.keys()).slice(0, halfSize);
        keys.forEach(k => this.cache.delete(k));
        this._saveToDisk();
      }
    }
  }

  get(key) {
    if (!this.cache.has(key)) return null;

    // Refresh order (Move to end of Map)
    const value = this.cache.get(key);
    this.cache.delete(key);
    this.cache.set(key, value);
    
    return value;
  }

  set(key, value) {
    // If key exists, delete it to update its position to "newest"
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      // Delete the oldest entry (first item in Map iterator)
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
    }

    this.cache.set(key, value);
    this._saveToDisk(); // Persist changes
  }

  has(key) {
    return this.cache.has(key);
  }

  clear() {
    this.cache.clear();
    localStorage.removeItem(STORAGE_KEY);
  }
}

/**
 * Singleton instances
 */
export const locationResultCache = new LRULocationCache(100);
export const anchorQueryCache = new Map();