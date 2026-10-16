import type { Point } from "./types.ts";

/** Follow the waterline on the same diagonal triangles used by the terrain mesh. */
export function lakeShorelines(
  heights: number[],
  side: number,
  step: number,
  half: number,
  seeds: Uint8Array,
  level: number,
): Point[][] {
  const wet = new Uint8Array(heights.length),
    queue: number[] = [];
  for (let i = 0; i < seeds.length; i++)
    if (seeds[i] && heights[i] < level) {
      wet[i] = 1;
      queue.push(i);
    }
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head],
      x = i % side,
      z = Math.floor(i / side);
    for (const [dx, dz] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
      [1, -1],
      [-1, 1],
    ]) {
      const nx = x + dx,
        nz = z + dz,
        n = nz * side + nx;
      if (nx < 0 || nz < 0 || nx >= side || nz >= side || wet[n] || heights[n] >= level)
        continue;
      wet[n] = 1;
      queue.push(n);
    }
  }
  const points = new Map<string, Point>(),
    links = new Map<string, string[]>();
  const crossing = (a: number, b: number) => {
    if (a > b) [a, b] = [b, a];
    const key = `${a}:${b}`;
    if (!points.has(key)) {
      const t = (level - heights[a]) / (heights[b] - heights[a]);
      points.set(key, {
        x: ((a % side) + ((b % side) - (a % side)) * t) * step - half,
        z:
          (Math.floor(a / side) + (Math.floor(b / side) - Math.floor(a / side)) * t) *
            step -
          half,
      });
    }
    return key;
  };
  for (let z = 0; z < side - 1; z++)
    for (let x = 0; x < side - 1; x++) {
      const i = z * side + x;
      for (const tri of [
        [i, i + 1, i + side],
        [i + 1, i + side + 1, i + side],
      ]) {
        const cuts: string[] = [];
        for (let k = 0; k < 3; k++) {
          const a = tri[k],
            b = tri[(k + 1) % 3];
          if (wet[a] !== wet[b]) cuts.push(crossing(a, b));
        }
        if (cuts.length !== 2) continue;
        const [a, b] = cuts;
        links.set(a, [...(links.get(a) ?? []), b]);
        links.set(b, [...(links.get(b) ?? []), a]);
      }
    }
  const rings: Point[][] = [],
    seen = new Set<string>();
  for (const start of links.keys()) {
    if (seen.has(start)) continue;
    const ring: Point[] = [];
    let key: string | undefined = start;
    while (key !== undefined && !seen.has(key)) {
      seen.add(key);
      ring.push(points.get(key)!);
      key = links.get(key)?.find((n) => !seen.has(n));
    }
    if (ring.length >= 3) rings.push(ring);
  }
  return rings;
}
