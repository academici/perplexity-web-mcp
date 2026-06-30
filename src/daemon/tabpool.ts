import type { SaturationCfg } from "../config.js";
import { DispatcherError } from "../dispatcher.js";

export interface Slot {
  tabIndex: number;
  release(): void;
}

interface Waiter {
  resolve: (s: Slot) => void;
  reject: (e: Error) => void;
  settled: boolean;
  timer?: NodeJS.Timeout;
}

// Async semaphore bounding concurrent search tabs. When all slots are busy the
// configured saturation policy decides what a new acquire() does:
//   queue     — wait (FIFO) until a slot frees, no timeout
//   fail-fast — reject immediately with BROWSER_BUSY
//   hybrid    — wait up to waitMs, then reject with BROWSER_BUSY
export class TabPool {
  private inUse = 0;
  private nextTabIndex = 0;
  private waiters: Waiter[] = [];

  constructor(private readonly cap: number, private readonly saturation: SaturationCfg) {}

  get active(): number { return this.inUse; }
  get waiting(): number { return this.waiters.length; }
  get capacity(): number { return this.cap; }

  acquire(): Promise<Slot> {
    if (this.inUse < this.cap) {
      return Promise.resolve(this.makeSlot());
    }
    if (this.saturation.mode === "fail-fast") {
      return Promise.reject(
        new DispatcherError("BROWSER_BUSY", `All ${this.cap} browser tabs are busy. Retry shortly.`),
      );
    }
    return new Promise<Slot>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, settled: false };
      if (this.saturation.mode === "hybrid") {
        const waitMs = this.saturation.waitMs;
        waiter.timer = setTimeout(() => {
          if (waiter.settled) return;
          waiter.settled = true;
          const i = this.waiters.indexOf(waiter);
          if (i >= 0) this.waiters.splice(i, 1);
          reject(new DispatcherError("BROWSER_BUSY", `Browser busy: waited ${waitMs}ms, no free tab. Retry shortly.`));
        }, waitMs);
        waiter.timer.unref?.();
      }
      this.waiters.push(waiter);
    });
  }

  private makeSlot(): Slot {
    this.inUse++;
    const tabIndex = this.nextTabIndex++;
    let released = false;
    return {
      tabIndex,
      release: () => {
        if (released) return;
        released = true;
        this.inUse--;
        this.wakeNext();
      },
    };
  }

  private wakeNext(): void {
    while (this.waiters.length > 0) {
      const w = this.waiters.shift()!;
      if (w.settled) continue;
      w.settled = true;
      if (w.timer) clearTimeout(w.timer);
      w.resolve(this.makeSlot());
      return;
    }
  }
}
