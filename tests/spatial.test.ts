import { test } from "node:test";
import assert from "node:assert/strict";
import { SpatialGrid } from "../shared/spatial.ts";

test("spatial candidates preserve order, overlap, negative cells and independent results", () => {
  const grid = new SpatialGrid<string>(16);
  grid.insert("across-origin", 0, 0, 6);
  grid.insert("negative", -20, -20);
  grid.insert("positive", 20, 20);
  grid.insert("across-origin", 0, 0, 6);
  assert.deepEqual(grid.query(0, 0, 24), ["negative", "across-origin", "positive"]);
  const first = grid.query(0, 0, 6);
  first.push("caller-only");
  assert.deepEqual(grid.query(1, 1, 6), ["across-origin"]);
  assert.deepEqual(grid.query(-20, -20, 0), ["negative"]);
  assert.deepEqual(grid.query(20, 20, 0), ["positive"]);
});

test("spatial query cache invalidates on insert and clear, including cached misses", () => {
  const grid = new SpatialGrid<string>();
  assert.deepEqual(grid.query(100, 100, 1), []);
  grid.insert("new", 100, 100);
  assert.deepEqual(grid.query(100, 100, 1), ["new"]);
  grid.clear();
  assert.deepEqual(grid.query(100, 100, 1), []);
  grid.insert("replacement", 100, 100);
  assert.deepEqual(grid.query(100, 100, 1), ["replacement"]);
});
