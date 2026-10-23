import { wrap } from "../../shared/physics/vehicle.ts";

/** The controlled body as drawn this frame. */
export interface Drawn {
  angle: number;
  speed: number;
}

/**
 * How long an action takes to show on screen, from the key going down to the first drawn change.
 * The network panel's round trip says how far away the server is; these say what the player waits
 * for: climbing into a car and the start of a turn.
 */
export class ActionLatency {
  /** The last completed measurements (ms), kept until the next one. */
  enterMs: number | undefined;
  steerMs: number | undefined;
  /** Every measurement so far, for tools that want a median rather than the last. */
  readonly samples = { enter: [] as number[], steer: [] as number[] };
  private enter: { at: number; seated: boolean } | undefined;
  private steer: { at: number; angle: number } | undefined;
  private steerHeld = 0;
  /** The enter/exit key went down while `seated` (as the driver, as drawn). */
  pressInteract(now: number, seated: boolean) {
    this.enter = { at: now, seated };
  }
  /**
   * Steering from the controls: a turn starts when it leaves the centre while the body moves
   * (a body at rest does not change heading, so there is nothing to wait for).
   */
  controls(now: number, steer: number, drawn: Drawn | undefined) {
    if (Math.abs(steer) < 0.1) this.steer = undefined;
    else if (
      Math.abs(this.steerHeld) < 0.1 &&
      Math.abs(steer) >= 0.3 &&
      drawn &&
      drawn.speed > 3
    )
      this.steer = { at: now, angle: drawn.angle };
    this.steerHeld = steer;
  }
  /** Every drawn frame: what the screen shows now. */
  frame(now: number, seated: boolean, drawn: Drawn | undefined) {
    if (this.enter) {
      if (seated !== this.enter.seated) {
        this.enterMs = now - this.enter.at;
        this.samples.enter.push(this.enterMs);
        this.enter = undefined;
      } else if (now - this.enter.at > 3000) this.enter = undefined;
    }
    if (this.steer && drawn) {
      // A degree of heading is the first thing the pilot or driver can see.
      if (Math.abs(wrap(drawn.angle - this.steer.angle)) > 0.017) {
        this.steerMs = now - this.steer.at;
        this.samples.steer.push(this.steerMs);
        this.steer = undefined;
      } else if (now - this.steer.at > 2000) this.steer = undefined;
    }
  }
}
