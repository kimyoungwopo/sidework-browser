import type { ProviderActivity } from '../contract';
interface Waiter { signal: AbortSignal; abort: () => void; resolve: (release: () => void) => void; reject: (error: Error) => void }
const cancelled = () => new Error('작업이 취소됐습니다.');

/** One planner shares this gate across all independent logical jobs. */
export class ProcessGate {
  private running = 0;
  private readonly waiting: Waiter[] = [];
  constructor(private readonly limit: number, private readonly onActivity?: (activity: ProviderActivity) => void) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 8) throw new Error('maxProcesses must be an integer 1..8.');
  }
  private publish(): void {
    // Reporting failures must never strand a reservation or suppress cancellation.
    try { this.onActivity?.({ running: this.running, waiting: this.waiting.length, limit: this.limit }); } catch { /* Observer only. */ }
  }
  acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(cancelled());
    return new Promise((resolve, reject) => {
      if (this.running < this.limit && !this.waiting.length) { this.enter(resolve); return; }
      const waiter: Waiter = { signal, resolve, reject, abort: () => {
        const index = this.waiting.indexOf(waiter);
        if (index < 0) return;
        this.waiting.splice(index, 1);
        signal.removeEventListener('abort', waiter.abort);
        this.publish(); reject(cancelled());
      } };
      this.waiting.push(waiter); signal.addEventListener('abort', waiter.abort, { once: true });
      this.publish();
      if (signal.aborted) waiter.abort();
    });
  }
  private enter(resolve: (release: () => void) => void): void {
    this.running++; this.publish();
    let released = false;
    resolve(() => {
      if (released) return;
      released = true; this.running--;
      while (this.waiting.length && this.running < this.limit) {
        const waiter = this.waiting.shift()!;
        waiter.signal.removeEventListener('abort', waiter.abort);
        if (waiter.signal.aborted) waiter.reject(cancelled());
        else this.enter(waiter.resolve);
      }
      this.publish();
    });
  }
}
