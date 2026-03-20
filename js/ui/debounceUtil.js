export function debounceByKey(timerStore, key, callback, delayMs) {
  const existing = timerStore.get(key);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(callback, delayMs);
  timerStore.set(key, timer);
}
