import { test } from "node:test";
import assert from "node:assert/strict";
import {
  trailTiles,
  paintTrail,
  TRAIL_TEXTURE_SIZE,
  TRAIL_TILE_WIDTH,
} from "../client/effects/trail-data.ts";

test("rubber atlas covers expanded and negative city coordinates at constant detail", () => {
  assert.deepEqual(trailTiles(780, -780, 0.5), ["12,-13"]);
  assert.deepEqual(trailTiles(-0.1, 63.9, 0.5), ["-1,0", "-1,1", "0,0", "0,1"]);
  assert.ok((0.26 * TRAIL_TEXTURE_SIZE) / TRAIL_TILE_WIDTH >= 4);
});
test("tile-edge rubber is painted in both tiles with matching world placement and grooves", () => {
  const positions: number[][] = [],
    widths: number[] = [];
  const ctx = {
    save() {},
    restore() {},
    translate(x: number, z: number) {
      positions.push([x, z]);
    },
    rotate() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    stroke(this: { lineWidth: number }) {
      widths.push(this.lineWidth);
    },
    lineWidth: 0,
  } as unknown as CanvasRenderingContext2D;
  const mark = { x: 64, z: 65, angle: 0, length: 0.5, life: 40, tiles: [] };
  paintTrail(ctx, mark, 0, 1);
  paintTrail(ctx, mark, 1, 1);
  assert.deepEqual(positions, [
    [1024, 1008],
    [0, 1008],
  ]);
  assert.equal(widths.length, 10);
  assert.ok(Math.min(...widths) < Math.max(...widths) / 5);
});
