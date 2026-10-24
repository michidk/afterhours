import { InputStamper } from "../../client/network/lead.ts";

const TICK = 1000 / 30;
export interface Link {
  /** One-way delay in ms: base plus uniform jitter of ±`jitter`. */
  base: number;
  jitter: number;
  /** Chance per packet of a stall, and its length in ms (head-of-line blocking on TCP). */
  stall?: [number, number];
}
export interface LinkStats {
  /** Mean ticks early inputs arrived at the server (the panel's "server input buffer"). */
  lead: number;
  /** Share of inputs that arrived after their tick and were dropped. */
  dropped: number;
  /** Mean ms from sending an input to the server running it. */
  age: number;
}

/** Deterministic PRNG so a run is reproducible. */
const rng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/**
 * A 30 Hz client and a server that snapshots at 15 Hz over a jittery in-order link, running
 * the real `InputStamper`. Measures the steady state of the lead controller.
 */
export function simulate(
  link: Link,
  seconds = 60,
  seed = 1,
  stamper = new InputStamper(),
  /** Client send period in ms; slightly under a tick models a browser timer running fast. */
  period = TICK,
) {
  const random = rng(seed),
    delay = () =>
      link.base +
      (random() * 2 - 1) * link.jitter +
      (link.stall && random() < link.stall[0] ? link.stall[1] * random() : 0);
  // Snapshots in flight to the client, in order: [arrival, tick, lead].
  let lastLead = 0,
    serverTick = 0,
    received = 0,
    nextSnapshot = 0,
    snapshotArrival = 0,
    inputArrival = 0;
  const snapshots: [number, number, number][] = [];
  const arrivals: { at: number; stamp: number; sent: number }[] = [];
  const stats = { lead: 0, dropped: 0, age: 0, n: 0 };
  const end = seconds * 1000,
    warm = 10_000;
  stamper.reset(0);
  const inputs: { at: number; stamp: number; sent: number }[] = [];
  for (let t = 0; t <= end; t += Math.min(period, TICK)) {
    // Deliver snapshots that reached the client by now.
    while (snapshots.length && snapshots[0][0] <= t) {
      const [at, tick, lead] = snapshots.shift()!;
      serverTick = tick;
      received = at;
      stamper.feedback(lead);
    }
    // The client sends this tick's input.
    const stamp = stamper.stamp(serverTick + (t - received) / TICK);
    if (stamp !== undefined) {
      inputArrival = Math.max(inputArrival, t + delay());
      inputs.push({ at: inputArrival, stamp, sent: t });
    }
    // The server consumes inputs that have arrived; snapshots go out every other tick.
    while (inputs.length && inputs[0].at <= t + TICK) {
      const i = inputs.shift()!;
      const now = Math.floor(i.at / TICK);
      lastLead = i.stamp - now;
      if (i.sent >= warm) {
        stats.n++;
        stats.lead += lastLead;
        if (lastLead < 0) stats.dropped++;
        stats.age += Math.max(i.stamp * TICK, i.at) - i.sent;
      }
    }
    if (t >= nextSnapshot) {
      nextSnapshot += 2 * TICK;
      snapshotArrival = Math.max(snapshotArrival, t + delay());
      snapshots.push([snapshotArrival, Math.floor(t / TICK), lastLead]);
    }
  }
  void arrivals;
  return {
    lead: stats.lead / stats.n,
    dropped: stats.dropped / stats.n,
    age: stats.age / stats.n,
  } satisfies LinkStats;
}
