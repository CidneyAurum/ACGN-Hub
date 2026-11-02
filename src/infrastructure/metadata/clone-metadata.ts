/** Metadata caches contain JSON response data and mapped optional fields only.
 * Keep native clone semantics when available; the older-WebView fallback is
 * deliberately limited to plain objects, arrays and JSON primitives plus
 * undefined. It never silently converts Dates, instances or circular graphs.
 */
export function cloneMetadata<T>(value: T): T {
  if (typeof globalThis.structuredClone === "function") return globalThis.structuredClone(value);
  const ancestors = new Set<object>();
  const copy = (current: unknown): unknown => {
    if (current === null || current === undefined || typeof current === "string" || typeof current === "boolean") return current;
    if (typeof current === "number" && Number.isFinite(current)) return current;
    if (typeof current !== "object") throw new TypeError("Metadata cache accepts only plain JSON data");
    if (ancestors.has(current)) throw new TypeError("Circular metadata cannot be cached without structuredClone");
    const prototype = Object.getPrototypeOf(current);
    if (!Array.isArray(current) && prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Metadata cache accepts only plain JSON objects");
    }
    ancestors.add(current);
    try {
      if (Array.isArray(current)) return current.map(copy);
      const result: Record<string, unknown> = {};
      for (const key of Object.keys(current)) {
        Object.defineProperty(result, key, { value: copy((current as Record<string, unknown>)[key]), enumerable: true, writable: true, configurable: true });
      }
      return result;
    } finally { ancestors.delete(current); }
  };
  return copy(value) as T;
}
