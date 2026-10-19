import test from "node:test";
import assert from "node:assert/strict";
import {
  playerSightRadius,
  segmentHitsBox,
  segmentHitsBuilding,
} from "../client/world/occluders.ts";

const min = { x: 0, y: 0, z: 0 },
  max = { x: 10, y: 10, z: 10 };
test("segment/box slab test with padding", () => {
  assert.equal(
    segmentHitsBox({ x: -5, y: 5, z: 5 }, { x: 15, y: 5, z: 5 }, min, max),
    true,
  );
  assert.equal(
    segmentHitsBox({ x: -5, y: 20, z: 5 }, { x: 15, y: 20, z: 5 }, min, max),
    false,
  );
  assert.equal(
    segmentHitsBox({ x: -5, y: 13, z: 5 }, { x: 15, y: 13, z: 5 }, min, max, 4),
    true,
  );
  assert.equal(
    segmentHitsBox({ x: -5, y: 5, z: 5 }, { x: -2, y: 5, z: 5 }, min, max),
    false,
  );
  assert.equal(
    segmentHitsBox({ x: 5, y: 5, z: 20 }, { x: 5, y: 5, z: 15 }, min, max),
    false,
  );
  assert.equal(
    segmentHitsBox({ x: 5, y: 5, z: 5 }, { x: 5, y: 5, z: 5 }, min, max),
    true,
  );
});

const tower = { x: 0, z: 0, w: 20, d: 20, h: 30, y: 0 };
test("a sight line fades a building only when it actually crosses it", () => {
  // Player 2 m from the west wall, camera up and further west: nothing is in between.
  const player = { x: -12, y: 1, z: 0 },
    camera = { x: -30, y: 15, z: 0 };
  assert.equal(segmentHitsBuilding(camera, player, tower), false);
  assert.equal(
    segmentHitsBuilding(camera, player, tower, 0.35),
    false,
    "a person-wide sight line still misses a wall two metres away",
  );
  // The old test padded the box by 4 m and started the line 6 m from the player.
  assert.equal(
    segmentHitsBox(
      camera,
      player,
      { x: -10, y: 0, z: -10 },
      { x: 10, y: 30, z: 10 },
      4,
    ),
    true,
    "the padded bounds are what made a nearby building fade",
  );
  // Same player, camera on the far side: the tower is between them.
  assert.equal(segmentHitsBuilding({ x: 30, y: 15, z: 0 }, player, tower), true);
  // Camera inside the building (swung behind a wall) fades it too.
  assert.equal(
    segmentHitsBuilding({ x: 0, y: 10, z: 0 }, { x: -12, y: 1, z: 0 }, tower),
    true,
  );
});
test("sight lines above the roof, beside the building or below its pad are clear", () => {
  assert.equal(
    segmentHitsBuilding({ x: 30, y: 45, z: 0 }, { x: -30, y: 40, z: 0 }, tower),
    false,
    "a line that passes over the roof",
  );
  assert.equal(
    segmentHitsBuilding({ x: 30, y: 15, z: 14 }, { x: -30, y: 15, z: 14 }, tower),
    false,
    "a line four metres off the side wall",
  );
  assert.equal(
    segmentHitsBuilding(
      { x: 30, y: 2, z: 0 },
      { x: -30, y: 2, z: 0 },
      { ...tower, y: 10 },
    ),
    false,
    "a line under a building raised on a pad",
  );
  assert.equal(
    segmentHitsBuilding(
      { x: 30, y: 15, z: 10.3 },
      { x: -30, y: 15, z: 10.3 },
      tower,
      0.35,
    ),
    true,
    "the line is as thick as a person: a graze within 0.35 m counts",
  );
  assert.equal(
    segmentHitsBuilding(
      { x: 30, y: 15, z: 10.6 },
      { x: -30, y: 15, z: 10.6 },
      tower,
      0.35,
    ),
    false,
    "and a clear pass 0.6 m away does not",
  );
});
test("rotated footprints are tested as rectangles, not their larger axis-aligned bounds", () => {
  const diamond = { x: 0, z: 0, w: 20, d: 20, h: 30, y: 0, angle: Math.PI / 4 };
  // Corner of the axis-aligned bounds (about 14 m each way) but outside the 45 degree lot.
  const a = { x: -13, y: 10, z: 13 },
    b = { x: -3, y: 10, z: 13 };
  assert.equal(
    segmentHitsBox(a, b, { x: -14.2, y: 0, z: -14.2 }, { x: 14.2, y: 30, z: 14.2 }),
    true,
    "bounds claim a hit",
  );
  assert.equal(
    segmentHitsBuilding(a, b, diamond),
    false,
    "the real footprint is missed",
  );
  assert.equal(
    segmentHitsBuilding({ x: -14, y: 10, z: 0 }, { x: 14, y: 10, z: 0 }, diamond),
    true,
    "a line through its middle is still blocked",
  );
});

test("early fade margin catches side and roof edges before the center is blocked", () => {
  for (const [y, z] of [
    [15, 11.4],
    [31.4, 0],
  ]) {
    const camera = { x: 30, y, z },
      player = { x: -30, y, z };
    assert.equal(segmentHitsBuilding(camera, player, tower, 0.35), false);
    assert.equal(segmentHitsBuilding(camera, player, tower, 1.5), true);
  }
  assert.equal(
    segmentHitsBuilding({ x: -30, y: 15, z: 0 }, { x: -12, y: 1, z: 0 }, tower, 1.5),
    false,
    "a building two metres beside the player stays solid",
  );
});

test("player clearance covers a quarter of the viewport height and grows with zoom", () => {
  const player = { x: 0, y: 0, z: 0 };
  assert.ok(
    Math.abs(playerSightRadius({ x: 0, y: 0, z: 40 }, player, Math.PI / 2) - 20) <
      1e-10,
  );
  assert.ok(
    Math.abs(playerSightRadius({ x: 0, y: 0, z: 80 }, player, Math.PI / 2) - 40) <
      1e-10,
  );
  const radius = playerSightRadius({ x: 0, y: 30, z: 40 }, player, 0.72);
  assert.ok(radius > 9 && radius < 10);
  assert.equal(
    segmentHitsBuilding(
      { x: 30, y: 15, z: 18 },
      { x: -30, y: 1, z: 18 },
      tower,
      radius,
    ),
    true,
  );
});
