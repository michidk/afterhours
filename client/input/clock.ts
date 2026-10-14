import { TUNING } from "../../shared/catalog.ts";

// Timer callbacks are wakeups, not simulation ticks.
export class InputClock {
  private next: number | undefined;
  private interval = TUNING.tick * 1000;
  reset() {
    this.next = undefined;
    this.interval = TUNING.tick * 1000;
  }
  advance(now: number, send: (timestamp: number) => void) {
    if (this.next === undefined || now - this.next > 250) this.next = now;
    while (this.next <= now + 1e-6) {
      const timestamp = this.next;
      this.next += this.interval;
      send(timestamp);
    }
  }
  /**
   * Phase-lock the schedule to the server's buffer: a dry queue means the server
   * ran held controls, a deep queue means commands wait. Keep small adjustments
   * near the target, but slow sending more strongly as the FIFO fills so a slow
   * server does not shed commands that the client has already predicted.
   */
  feedback(queued: number | undefined) {
    if (queued === undefined || this.next === undefined) return;
    this.interval =
      TUNING.tick * 1000 +
      Math.min(TUNING.tick * 1000, Math.max(0, queued - TUNING.inputBuffer) * 4);
    // Negative means the server already ran slots on held controls ahead of our
    // commands; pull the schedule in faster so control changes stop risking a miss.
    if (queued < 0) this.next -= 6;
    else if (queued < TUNING.inputBuffer) this.next -= 2;
  }
}
