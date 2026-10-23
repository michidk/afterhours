import assert from "node:assert/strict";
import test from "node:test";
import { SeatWatch } from "../client/network/seat-watch.ts";
import type { Entity } from "../shared/world.ts";

const car = (extra: Partial<Entity> = {}) =>
  ({ id: "c", kind: "car", health: 100, ...extra }) as Entity;
const me = (vehicle?: string) => ({ id: "p", kind: "player", vehicle }) as Entity;
const reasonOf = (watch: SeatWatch) => watch.loss?.reason;
const world = (...entities: Entity[]) => new Map(entities.map((e) => [e.id, e]));

test("a vehicle that disappears under the rider is reported as removed", () => {
  const watch = new SeatWatch();
  const warn = console.warn;
  console.warn = () => {};
  try {
    watch.update(0, "p", world(me("c"), car()));
    assert.equal(watch.loss, undefined);
    watch.update(100, "p", world(me()));
    assert.equal(reasonOf(watch), "the server removed the vehicle");
  } finally {
    console.warn = warn;
  }
});

test("a wreck and a burn-out are told apart from a removal", () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    for (const [extra, reason] of [
      [{ wreck: 180 }, "the vehicle was wrecked"],
      [{ health: 0 }, "the vehicle burned out"],
    ] as const) {
      const watch = new SeatWatch();
      watch.update(0, "p", world(me("c"), car()));
      watch.update(100, "p", world(me(), car(extra)));
      assert.equal(reasonOf(watch), reason);
    }
  } finally {
    console.warn = warn;
  }
});

test("pressing the exit key, or never sitting, is not a loss", () => {
  const watch = new SeatWatch();
  watch.update(0, "p", world(me(), car()));
  watch.update(50, "p", world(me("c"), car()));
  watch.update(1000, "p", world(me(), car()), 900);
  assert.equal(watch.loss, undefined);
});
