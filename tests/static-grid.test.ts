import { test } from "node:test";
import assert from "node:assert/strict";
import { generateCity } from "../scripts/city-generator.ts";
import { staticGeometry } from "../shared/physics/static.ts";
import { SpatialGrid } from "../shared/spatial.ts";
import { destructibles, setBrokenProps } from "../shared/destruction.ts";
import type { City } from "../shared/world.ts";

const signature = (
  items: { x: number; z: number; w: number; d: number; h: number }[],
) => items.map((c) => `${c.x},${c.z},${c.w},${c.d},${c.h}`);

test("breaking and restoring props updates the grid in place and matches a fresh build", () => {
  const city = generateCity();
  const props = destructibles(city);
  assert.ok(props.length > 200, `enough props to exercise it: ${props.length}`);
  const incremental = staticGeometry(city);
  let seed = 5;
  const random = (n: number) =>
    (((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) * n) | 0;
  const broken = new Set<string>();
  for (let step = 0; step < 60; step++) {
    // A few props break or restore at a time, like a crash or a restoration wave.
    for (let k = 0; k < 1 + random(4); k++) {
      const id = props[random(props.length)].id;
      if (broken.has(id)) broken.delete(id);
      else broken.add(id);
    }
    setBrokenProps(city, broken);
    assert.equal(
      staticGeometry(city),
      incremental,
      "the same grid is updated in place",
    );
    // A second city sharing the geometry, built from scratch with the same props broken.
    const fresh: City = { ...city };
    setBrokenProps(fresh, broken);
    const reference = staticGeometry(fresh);
    for (let q = 0; q < 40; q++) {
      const x = props[random(props.length)].x + random(9) - 4,
        z = props[random(props.length)].z + random(9) - 4,
        r = [2, 6, 14][random(3)];
      assert.deepEqual(
        signature(incremental.query(x, z, r)),
        signature(reference.query(x, z, r)),
        `step ${step}: same colliders in the same order near ${x.toFixed(0)}, ${z.toFixed(0)}`,
      );
    }
    for (const id of broken) {
      const p = props.find((candidate) => candidate.id === id)!;
      assert.ok(
        !incremental.query(p.x, p.z, 0.5).some((c) => c.destructibleId === id),
        "a broken prop is not an obstacle",
      );
    }
  }
  setBrokenProps(city, []);
  const restored = signature(staticGeometry(city).query(props[0].x, props[0].z, 20));
  const pristine = signature(
    staticGeometry({ ...city }).query(props[0].x, props[0].z, 20),
  );
  assert.deepEqual(
    restored,
    pristine,
    "restoring everything returns the original order",
  );
});

test("changing the city's geometry still rebuilds the grid", () => {
  const city = generateCity();
  const before = staticGeometry(city);
  city.buildings = [
    ...city.buildings,
    { x: 5000, z: 5000, w: 10, d: 10, h: 20, color: "#fff", style: 0 },
  ];
  const after = staticGeometry(city);
  assert.notEqual(after, before);
  assert.equal(after.query(5000, 5000, 4).length, 1);
});

test("spatial grid removal and ranked insertion keep cells ordered", () => {
  const grid = new SpatialGrid<{ id: string; order: number }>(10, false);
  const items = ["a", "b", "c", "d"].map((id, order) => ({ id, order }));
  for (const item of items) grid.insert(item, 1, 1, 0);
  grid.remove(items[1], 1, 1, 0);
  assert.deepEqual(
    grid.query(1, 1, 2).map((i) => i.id),
    ["a", "c", "d"],
  );
  grid.insertRanked(items[1], 1, 1, 0, (i) => i.order);
  assert.deepEqual(
    grid.query(1, 1, 2).map((i) => i.id),
    ["a", "b", "c", "d"],
  );
  grid.remove(items[3], 1, 1, 0);
  grid.remove(items[0], 1, 1, 0);
  grid.insertRanked(items[3], 1, 1, 0, (i) => i.order);
  grid.insertRanked(items[0], 1, 1, 0, (i) => i.order);
  grid.insertRanked(items[0], 1, 1, 0, (i) => i.order);
  assert.deepEqual(
    grid.query(1, 1, 2).map((i) => i.id),
    ["a", "b", "c", "d"],
    "no duplicates",
  );
  grid.remove({ id: "missing", order: 9 }, 1, 1, 0);
  assert.equal(
    grid.query(1, 1, 2).length,
    4,
    "removing an absent item changes nothing",
  );
});
