export type Sleep = (milliseconds: number) => Promise<void>;

export class MinIntervalLimiter {
  private nextAllowedAt = 0;
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly minIntervalMs: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: Sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  ) {}

  wait(): Promise<void> {
    const result = this.tail.then(async () => {
      const delay = Math.max(0, this.nextAllowedAt - this.now());
      if (delay > 0) await this.sleep(delay);
      const interval = Number.isFinite(this.minIntervalMs) ? Math.max(0, this.minIntervalMs) : 0;
      this.nextAllowedAt = Math.max(this.now(), this.nextAllowedAt) + interval;
    });
    this.tail = result.catch(() => undefined);
    return result;
  }
}
