import { TERRAIN_STEP } from "../../shared/terrain.ts";

export const TRAIL_TILE_WIDTH = 64;
export const TRAIL_TEXTURE_SIZE = 1024;
export const TRAIL_TILE_LIMIT = 16;
/** Above generated asphalt (0.10) and its lane paint (0.12), below curbs and sidewalks. */
export const TRAIL_LIFT = 0.14;
/** Clears the slightly higher airfield runway markings. */
export const TRAIL_AIRFIELD_LIFT = 0.2;
/** Rubber stays for minutes, then fades out over the final stretch in a few steps. */
export const TRAIL_LIFETIME = 180;
export const TRAIL_FADE = 60;
const TRAIL_SHADES = 6;
/** Most marks kept at once; past it the oldest go first, however young. */
export const TRAIL_MARK_LIMIT = 20000;
/** Opacity step of a mark. Tiles repaint only when one of their marks changes step. */
export const trailShade = (life: number) =>
  Math.max(
    0,
    Math.min(1, Math.ceil((life / TRAIL_FADE) * TRAIL_SHADES) / TRAIL_SHADES),
  );
export type TrailMark = {
  x: number;
  z: number;
  angle: number;
  length: number;
  life: number;
  tiles: string[];
  /** Opacity step the mark was last painted with. */
  shade?: number;
};

/** Absolute world coordinates; neither coverage nor detail depends on city size. */
export function trailTiles(x: number, z: number, length: number) {
  const radius = Math.max(0.2, length / 2 + 0.2),
    result: string[] = [];
  for (
    let col = Math.floor((x - radius) / TRAIL_TILE_WIDTH);
    col <= Math.floor((x + radius) / TRAIL_TILE_WIDTH);
    col++
  )
    for (
      let row = Math.floor((z - radius) / TRAIL_TILE_WIDTH);
      row <= Math.floor((z + radius) / TRAIL_TILE_WIDTH);
      row++
    )
      result.push(`${col},${row}`);
  return result;
}

export function paintTrail(
  ctx: CanvasRenderingContext2D,
  mark: TrailMark,
  col: number,
  row: number,
) {
  const scale = TRAIL_TEXTURE_SIZE / TRAIL_TILE_WIDTH;
  ctx.save();
  ctx.translate(
    (mark.x - col * TRAIL_TILE_WIDTH) * scale,
    ((row + 1) * TRAIL_TILE_WIDTH - mark.z) * scale,
  );
  ctx.rotate(mark.angle);
  ctx.lineCap = "round";
  const alpha = trailShade(mark.life);
  // Translucent rubber bands soften the edge and preserve tyre grooves.
  for (const [width, opacity] of [
    [0.28, 0.12],
    [0.22, 0.25],
    [0.16, 0.2],
  ]) {
    ctx.strokeStyle = `rgba(22,25,25,${alpha * opacity})`;
    ctx.lineWidth = width * scale;
    ctx.beginPath();
    ctx.moveTo(0, (-mark.length * scale) / 2);
    ctx.lineTo(0, (mark.length * scale) / 2);
    ctx.stroke();
  }
  ctx.strokeStyle = `rgba(105,107,100,${alpha * 0.22})`;
  ctx.lineWidth = 0.025 * scale;
  for (const offset of [-0.065, 0.065]) {
    ctx.beginPath();
    ctx.moveTo(offset * scale, (-mark.length * scale) / 2);
    ctx.lineTo(offset * scale, (mark.length * scale) / 2);
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * One tile as a grid on the terrain's own vertices and diagonal, so rubber follows hills
 * exactly where the cars drive instead of sinking under a flat plane. Positions are
 * relative to the tile centre in x and z; y is absolute. Tile edges fall on terrain
 * vertices because both the tile width and the terrain origin are multiples of the step.
 */
export function trailTileGeometry(
  col: number,
  row: number,
  height: (x: number, z: number) => number,
  lift: number,
) {
  const cells = TRAIL_TILE_WIDTH / TERRAIN_STEP,
    side = cells + 1,
    positions: number[] = [],
    uvs: number[] = [],
    indices: number[] = [];
  for (let j = 0; j < side; j++)
    for (let i = 0; i < side; i++) {
      const x = i * TERRAIN_STEP,
        z = j * TERRAIN_STEP;
      positions.push(
        x - TRAIL_TILE_WIDTH / 2,
        height(col * TRAIL_TILE_WIDTH + x, row * TRAIL_TILE_WIDTH + z) + lift,
        z - TRAIL_TILE_WIDTH / 2,
      );
      // The painted canvas has +z at its top, matching a ground plane's uv layout.
      uvs.push(x / TRAIL_TILE_WIDTH, z / TRAIL_TILE_WIDTH);
    }
  for (let j = 0; j < cells; j++)
    for (let i = 0; i < cells; i++) {
      const a = j * side + i;
      // Same split as shared/terrain.ts: the diagonal joins (x + 1, z) and (x, z + 1).
      // Wound so Babylon's computed normals face up, with the diagonal unchanged.
      indices.push(a, a + 1, a + side, a + 1, a + side + 1, a + side);
    }
  return { positions, uvs, indices };
}
