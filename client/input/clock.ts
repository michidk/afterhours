import { TUNING } from "../../shared/catalog.ts";

// Timer callbacks are wakeups, not simulation ticks.
export class InputClock {
  private next: number | undefined;
  private period = TUNING.tick * 1000;
  private rateAdjustment = 0;
  get interval() {
    return this.period;
  }
  reset() {
    this.next = undefined;
    this.period = TUNING.tick * 1000;
    this.rateAdjustment = 0;
  }
  advance(now: number, send: (timestamp: number) => void) {
    if (this.next === undefined || now - this.next > TUNING.inputHoldSeconds * 1000)
      this.next = now;
    // A stale dry-buffer report must not accelerate a whole long-frame batch.
    if (now - this.next > (TUNING.inputQueue - 1) * TUNING.tick * 1000)
      this.period = Math.max(this.period, TUNING.tick * 1000);
    while (this.next <= now + 1e-6) {
      const timestamp = this.next;
      this.next += this.period;
      send(timestamp);
    }
  }
  /** Send the next slot early on a control change, without adding a slot. */
  transition(now: number, send: (timestamp: number) => void) {
    if (this.next === undefined) return;
    if (this.next > now && this.next <= now + this.period + 1e-6) {
      this.next += this.period;
      send(now);
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
    const tick = TUNING.tick * 1000;
    const error = queued - TUNING.inputBuffer;
    // A draining buffer means the server recovered; discard its old slow rate.
    this.rateAdjustment =
      error < 0
        ? 0
        : Math.min(250 - tick, this.rateAdjustment + Math.max(0, error - 1) * 0.5);
    this.period = Math.max(
      tick * 0.7,
      Math.min(
        250,
        tick +
          this.rateAdjustment +
          (queued < 0 ? -6 : error < 0 ? -2 : error * 4 + Math.max(0, error - 2) * 6),
      ),
    );
  }
}
