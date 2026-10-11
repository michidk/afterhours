export const TRAIL_TILE_WIDTH = 64;
export const TRAIL_TEXTURE_SIZE = 1024;
export const TRAIL_TILE_LIMIT = 16;
export type TrailMark = {
  x: number;
  z: number;
  angle: number;
  length: number;
  life: number;
  tiles: string[];
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
  const alpha = Math.min(1, mark.life / 10);
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
