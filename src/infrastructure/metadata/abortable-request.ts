/** Stop awaiting an IPC response when the caller cancels; the native timeout bounds its remaining work. */
export function abortableRequest<T>(request: () => Promise<T>, signal?: AbortSignal | null): Promise<T> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException("请求已取消", "AbortError"));
  if (!signal) return request();
  return new Promise<T>((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal.reason ?? new DOMException("请求已取消", "AbortError")); };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => {
      if (signal.aborted) throw signal.reason ?? new DOMException("请求已取消", "AbortError");
      return request();
    }).then(
      (value) => { cleanup(); resolve(value); },
      (cause) => { cleanup(); reject(cause); },
    );
  });
}
