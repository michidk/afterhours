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
  /**
   * Phase-lock the schedule to the server's buffer: a dry queue means the server
   * had to freeze the body, a deep queue means commands wait. Each 15 Hz report
   * shifts the next command by one or two milliseconds, so the 30 Hz rate changes
   * by at most a few percent, the rendered pose moves by centimetres rather than a
   * tick, and the buffer deepens quickly under jitter but drains slowly when calm.
   */
  feedback(queued: number | undefined) {
    if (queued === undefined || this.next === undefined) return;
    // Negative means the server already ran slots on held controls ahead of our
    // commands; pull the schedule in faster so control changes stop risking a miss.
    if (queued < 0) this.next -= 6;
    else if (queued < TUNING.inputBuffer) this.next -= 2;
    else if (queued > TUNING.inputBuffer + 1) this.next += 1;
  }
}
