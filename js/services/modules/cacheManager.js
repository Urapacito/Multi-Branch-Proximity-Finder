/**
 * Cache Management Module
 * Manages LRU location cache and Photon query cache
 */

/**
 * LRU Cache implementation for production-grade caching.
 * Prevents redundant API calls for recently searched addresses.
 */
export class LRULocationCache {
  constructor(maxSize = 50) {
    this.maxSize = maxSize;
    this.cache = new Map();
    this.accessOrder = [];
  }

  get(key) {
    if (!this.cache.has(key)) return null;
    this.accessOrder = this.accessOrder.filter(k => k !== key);
    this.accessOrder.push(key);
    return this.cache.get(key);
  }

  set(key, value) {
    if (this.cache.has(key)) {
      this.accessOrder = this.accessOrder.filter(k => k !== key);
    } else if (this.accessOrder.length >= this.maxSize) {
      const lruKey = this.accessOrder.shift();
      this.cache.delete(lruKey);
    }
    this.cache.set(key, value);
    this.accessOrder.push(key);
  }

  clear() {
    this.cache.clear();
    this.accessOrder = [];
  }
}

/**
 * Singleton instances for cross-module cache access
 */
export const locationResultCache = new LRULocationCache(50);
export const anchorQueryCache = new Map();
