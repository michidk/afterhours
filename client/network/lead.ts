/** Ticks ahead of the server that an input aims to land. */
export const LEAD_TARGET = 2;

/**
 * Stamps each input with the server tick it should run on and tunes how far ahead that is
 * from the lead the server reports back (ticks early, negative = late and dropped).
 */
export class InputStamper {
  /** Ticks of lead the stamps aim for; follows the link's delay and jitter. */
  target = LEAD_TARGET;
  private next = 0;
  reset(serverTick: number) {
    this.next = serverTick + this.target;
  }
  /**
   * `serverTick` is the server tick estimated at the moment of sending. Returns undefined
   * when the stream is already more than a tick ahead of the aim: the server runs one input
   * per tick, so a timer that fires slightly faster than 30 Hz must not queue the extra ones.
   */
  stamp(serverTick: number) {
    const estimate = Math.ceil(serverTick + this.target);
    if (this.next > estimate + 1 && this.next - estimate <= 8) return undefined;
    // Keep the stream contiguous, but resynchronise after a pause or a drift.
    const tick =
      Math.abs(estimate - this.next) > 8 ? estimate : Math.max(this.next, estimate);
    this.next = tick + 1;
    return tick;
  }
  /** Called with the `lead` of every snapshot. */
  feedback(lead: number) {
    this.target = Math.max(
      1,
      Math.min(8, this.target + (lead < 1 ? 1 : lead > LEAD_TARGET + 1 ? -0.25 : 0)),
    );
  }
}
