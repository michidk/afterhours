import { sample, slope, toCell } from "./field.ts";
import { pointInPolygon } from "./geom.ts";
import type { GeneratedMap } from "./types.ts";

/** Human-readable description of what lies under a world position. */
export function describeAt(map: GeneratedMap, x: number, z: number) {
  const half = map.options.size / 2;
  if (Math.abs(x) > half || Math.abs(z) > half) return "Outside the map.";
  const lines = [`x ${x.toFixed(0)}  z ${z.toFixed(0)}`];
  const h = sample(map.shaped, x, z),
    raw = sample(map.terrain, x, z);
  lines.push(
    `height ${h.toFixed(1)} m${Math.abs(h - raw) > 0.05 ? ` (natural ${raw.toFixed(1)} m)` : ""}`,
  );
  lines.push(`slope ${(slope(map.shaped, x, z) * 100).toFixed(0)} %`);
  const { u, v } = toCell(map.terrain, x, z),
    i = Math.round(v) * map.terrain.w + Math.round(u);
  if (h <= map.seaLevel) lines.push("sea");
  lines.push(`desirability ${(map.desirability[i] * 100).toFixed(0)} %`);
  for (const lake of map.lakes)
    if (pointInPolygon({ x, z }, lake.outline))
      lines.push(`lake at ${lake.level.toFixed(1)} m`);
  for (const b of map.blocks)
    if (pointInPolygon({ x, z }, b.polygon)) {
      lines.push(`block ${b.id}: ${b.zone}, ${b.lots.length} lots`);
      break;
    }
  for (const p of map.parks)
    if (pointInPolygon({ x, z }, p.polygon)) lines.push(`${p.kind} park`);
  let nearestEdge = -1,
    nearestDistance = Infinity;
  for (const e of map.roads.edges)
    for (let k = 1; k < e.points.length; k++) {
      const a = e.points[k - 1],
        b = e.points[k];
      const dx = b.x - a.x,
        dz = b.z - a.z,
        t = Math.max(
          0,
          Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz || 1)),
        );
      const d = Math.hypot(x - a.x - dx * t, z - a.z - dz * t);
      if (d < nearestDistance) {
        nearestDistance = d;
        nearestEdge = e.id;
      }
    }
  if (nearestEdge >= 0 && nearestDistance < 30) {
    const e = map.roads.edges[nearestEdge];
    lines.push(
      `${e.kind} road #${e.id} ${e.width} m wide, ${nearestDistance.toFixed(1)} m away${e.bridge ? ", bridge" : ""}`,
    );
  }
  for (const b of map.buildings) {
    if (b.footprint && !pointInPolygon({ x, z }, b.footprint)) continue;
    const c = Math.cos(-b.angle),
      s = Math.sin(-b.angle),
      lx = (x - b.x) * c - (z - b.z) * s,
      lz = (x - b.x) * s + (z - b.z) * c;
    if (Math.abs(lx) <= b.w / 2 && Math.abs(lz) <= b.d / 2) {
      lines.push(
        `${b.kind} ${b.w.toFixed(0)}×${b.d.toFixed(0)} m, ${b.h.toFixed(0)} m tall, pad ${b.y.toFixed(1)} m`,
      );
      break;
    }
  }
  return lines.join("\n");
}
