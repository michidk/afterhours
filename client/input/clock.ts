import { TUNING } from "../../shared/catalog.ts";

// Timer callbacks are wakeups, not simulation ticks.
export class InputClock {
  private next: number | undefined;
  reset() {
    this.next = undefined;
  }
  advance(now: number, send: (timestamp: number) => void) {
    const tick = TUNING.tick * 1000;
    if (this.next === undefined || now - this.next > 250) this.next = now;
    while (this.next <= now + 1e-6) {
      const timestamp = this.next;
      this.next += tick;
      send(timestamp);
    }
  }
}
