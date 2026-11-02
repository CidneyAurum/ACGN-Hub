/** Compatibility for Android WebViews predating AbortSignal.timeout/any. */
const disposers = new WeakMap<AbortSignal, () => void>();

function abortWith(controller: AbortController, reason: unknown): void {
  // Old signals do not expose reason at all. Install it before dispatching the
  // abort event so subscribers observe the original cancellation immediately.
  if (!("reason" in controller.signal)) {
    try { Object.defineProperty(controller.signal, "reason", { value: reason, configurable: true }); }
    catch { /* A non-extensible signal still retains cancellation. */ }
  }
  controller.abort(reason);
  // Older AbortController implementations ignore the optional reason argument.
  if (controller.signal.reason !== reason) {
    try { Object.defineProperty(controller.signal, "reason", { value: reason, configurable: true }); }
    catch { /* A browser-owned non-extensible signal still retains cancellation. */ }
  }
}

export function timeoutSignal(milliseconds: number): AbortSignal {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") return AbortSignal.timeout(milliseconds);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) throw new RangeError("Timeout must be a non-negative safe integer");
  const controller = new AbortController();
  const timer = setTimeout(() => {
    disposeAbortSignal(controller.signal);
    abortWith(controller, new DOMException("The operation timed out", "TimeoutError"));
  }, milliseconds);
  disposers.set(controller.signal, () => clearTimeout(timer));
  return controller.signal;
}

export function anySignal(signals: Iterable<AbortSignal>): AbortSignal {
  const inputs = [...signals];
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.any === "function") return AbortSignal.any(inputs);
  const controller = new AbortController();
  const listeners = new Map<AbortSignal, () => void>();
  const cleanup = () => {
    for (const [signal, listener] of listeners) signal.removeEventListener("abort", listener);
    listeners.clear();
  };
  const abort = (signal: AbortSignal) => {
    const reason = signal.reason ?? new DOMException("The operation was aborted", "AbortError");
    disposeAbortSignal(controller.signal);
    abortWith(controller, reason);
  };
  disposers.set(controller.signal, cleanup);
  for (const signal of inputs) {
    if (signal.aborted) { abort(signal); break; }
    if (listeners.has(signal)) continue;
    const listener = () => abort(signal);
    listeners.set(signal, listener);
    signal.addEventListener("abort", listener, { once: true });
  }
  return controller.signal;
}

/** Dispose only signals owned by these fallbacks, never caller cancellation. */
export function disposeAbortSignal(signal: AbortSignal): void {
  const dispose = disposers.get(signal);
  disposers.delete(signal);
  dispose?.();
}

export function throwIfAborted(signal?: AbortSignal | null): void {
  if (!signal) return;
  if (typeof signal.throwIfAborted === "function") { signal.throwIfAborted(); return; }
  if (signal.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}
