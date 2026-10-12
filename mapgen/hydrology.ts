import { distanceTransform, toWorld } from "./field.ts";
import { Noise, derive } from "./random.ts";
import type { HeightField, Lake, Point, River } from "./types.ts";

/** Binary min-heap over typed arrays; no allocation inside the flood loop. */
class Heap {
  private keys: Float64Array;
  private vals: Int32Array;
  size = 0;
  constructor(capacity: number) {
    this.keys = new Float64Array(capacity);
    this.vals = new Int32Array(capacity);
  }
  push(key: number, val: number) {
    let i = this.size++;
    if (i >= this.keys.length) {
      const keys = new Float64Array(this.keys.length * 2),
        vals = new Int32Array(this.vals.length * 2);
      keys.set(this.keys);
      vals.set(this.vals);
      this.keys = keys;
      this.vals = vals;
    }
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.keys[parent] <= key) break;
      this.keys[i] = this.keys[parent];
      this.vals[i] = this.vals[parent];
      i = parent;
    }
    this.keys[i] = key;
    this.vals[i] = val;
  }
  pop() {
    const top = this.vals[0],
      key = this.keys[--this.size],
      val = this.vals[this.size];
    let i = 0;
    for (;;) {
      let child = i * 2 + 1;
      if (child >= this.size) break;
      if (child + 1 < this.size && this.keys[child + 1] < this.keys[child]) child++;
      if (this.keys[child] >= key) break;
      this.keys[i] = this.keys[child];
      this.vals[i] = this.vals[child];
      i = child;
    }
    this.keys[i] = key;
    this.vals[i] = val;
    return top;
  }
}
const NEIGHBOURS = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, Math.SQRT2],
  [1, -1, Math.SQRT2],
  [-1, 1, Math.SQRT2],
  [-1, -1, Math.SQRT2],
] as const;

/**
 * Priority-flood with epsilon (Barnes et al. 2014), seeded from sea cells only, so
 * every land cell gains a strictly descending path to the sea. Returns fill depth.
 */
export function fillDepressions(f: HeightField, seaLevel = 0, eps = 0.002) {
  const { w, h, data } = f,
    closed = new Uint8Array(w * h),
    heap = new Heap(w * h),
    depth = new Float32Array(w * h);
  for (let z = 0; z < h; z++)
    for (let x = 0; x < w; x++) {
      const i = z * w + x;
      if (data[i] <= seaLevel || x === 0 || z === 0 || x === w - 1 || z === h - 1) {
        closed[i] = 1;
        heap.push(data[i], i);
      }
    }
  while (heap.size) {
    const c = heap.pop(),
      cx = c % w,
      cz = (c - cx) / w,
      hc = data[c];
    for (const [dx, dz] of NEIGHBOURS) {
      const nx = cx + dx,
        nz = cz + dz;
      if (nx < 0 || nz < 0 || nx >= w || nz >= h) continue;
      const n = nz * w + nx;
      if (closed[n]) continue;
      closed[n] = 1;
      if (data[n] < hc + eps) {
        depth[n] = hc + eps - data[n];
        data[n] = hc + eps;
      }
      heap.push(data[n], n);
    }
  }
  return depth;
}

/** D8 flow directions (index of the downhill cell or -1) and accumulated flux. */
export function flowAccumulation(f: HeightField, seaLevel = 0) {
  const { w, h, data } = f,
    dir = new Int32Array(w * h).fill(-1),
    flux = new Float32Array(w * h);
  for (let z = 0; z < h; z++)
    for (let x = 0; x < w; x++) {
      const i = z * w + x;
      if (data[i] <= seaLevel) continue;
      let best = -1,
        steepest = 0;
      for (const [dx, dz, d] of NEIGHBOURS) {
        const nx = x + dx,
          nz = z + dz;
        if (nx < 0 || nz < 0 || nx >= w || nz >= h) continue;
        const n = nz * w + nx,
          s = (data[i] - data[n]) / d;
        if (s > steepest) {
          steepest = s;
          best = n;
        }
      }
      dir[i] = best;
    }
  const order = new Int32Array(w * h);
  for (let i = 0; i < order.length; i++) order[i] = i;
  // Sort by height descending with index tie-breaks for determinism.
  order.sort((a, b) => data[b] - data[a] || a - b);
  for (let i = 0; i < flux.length; i++) flux[i] = data[i] > seaLevel ? 1 : 0;
  for (const i of order) if (dir[i] >= 0) flux[dir[i]] += flux[i];
  return { dir, flux };
}

export interface Hydrology {
  rivers: River[];
  lakes: Lake[];
  riverMask: Uint8Array;
  /** Distance in metres to sea, lake or river cells. */
  waterDistance: Float32Array;
  coastDistance: Float32Array;
  flow: Float32Array;
}

/**
 * Stage 1b: lakes from deep fill components, river polylines from flow accumulation,
 * carved beds with monotone descent, then a final fill so drainage stays valid.
 */
export function generateHydrology(
  f: HeightField,
  seed: number,
  seaLevel = 0,
  log?: (label: string, ms: number) => void,
): Hydrology {
  const { w, h, data } = f;
  let mark = Date.now();
  const lap = (label: string) => {
    log?.(label, Date.now() - mark);
    mark = Date.now();
  };
  const depth = fillDepressions(f, seaLevel);
  lap("fill");
  const lakeMask = lakesFromFill(f, depth, seaLevel);
  lap("lakes");
  let { dir, flux } = flowAccumulation(f, seaLevel);
  lap("flow");
  let landCells = 0;
  for (let i = 0; i < flux.length; i++) if (flux[i] > 0) landCells++;
  const threshold = Math.max(40, landCells * 0.011);
  const rivers = traceRivers(f, dir, flux, lakeMask, threshold, seaLevel);
  lap("trace");
  carveRivers(f, rivers, seaLevel, seed);
  lap("carve");
  fillDepressions(f, seaLevel);
  ({ dir, flux } = flowAccumulation(f, seaLevel));
  lap("refill");
  const riverMask = new Uint8Array(w * h),
    water = new Uint8Array(w * h),
    sea = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    sea[i] = data[i] <= seaLevel ? 1 : 0;
    water[i] = sea[i] || lakeMask[i] ? 1 : 0;
  }
  for (const river of rivers)
    for (let k = 0; k < river.points.length; k++) {
      const p = river.points[k],
        r = river.widths[k] / 2;
      const cx = (p.x + f.size / 2) / f.cell,
        cz = (p.z + f.size / 2) / f.cell,
        rc = Math.ceil(r / f.cell);
      for (let dz = -rc; dz <= rc; dz++)
        for (let dx = -rc; dx <= rc; dx++) {
          const x = Math.round(cx + dx),
            z = Math.round(cz + dz);
          if (x < 0 || z < 0 || x >= w || z >= h) continue;
          if (Math.hypot(dx, dz) * f.cell <= r + f.cell * 0.5) {
            riverMask[z * w + x] = 1;
            water[z * w + x] = 1;
          }
        }
    }
  lap("masks");
  const waterDistance = distanceTransform(water, w, h),
    coastDistance = distanceTransform(sea, w, h);
  for (let i = 0; i < w * h; i++) {
    waterDistance[i] *= f.cell;
    coastDistance[i] *= f.cell;
  }
  lap("distance");
  const flow = new Float32Array(w * h),
    maxLog = Math.log1p(threshold * 40);
  for (let i = 0; i < w * h; i++) flow[i] = Math.min(1, Math.log1p(flux[i]) / maxLog);
  const lakes = lakeOutlines(f, lakeMask);
  lap("outlines");
  return { rivers, lakes, riverMask, waterDistance, coastDistance, flow };
}

function lakesFromFill(f: HeightField, depth: Float32Array, seaLevel: number) {
  const { w, h } = f,
    mask = new Uint8Array(w * h),
    candidate = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) candidate[i] = depth[i] > 0.4 ? 1 : 0;
  const seen = new Uint8Array(w * h),
    stack: number[] = [];
  for (let i = 0; i < w * h; i++) {
    if (!candidate[i] || seen[i]) continue;
    const cells: number[] = [];
    let maxDepth = 0;
    stack.push(i);
    seen[i] = 1;
    while (stack.length) {
      const c = stack.pop()!;
      cells.push(c);
      maxDepth = Math.max(maxDepth, depth[c]);
      const x = c % w,
        z = (c - x) / w;
      for (const [dx, dz] of NEIGHBOURS.slice(0, 4)) {
        const nx = x + dx,
          nz = z + dz;
        if (nx < 0 || nz < 0 || nx >= w || nz >= h) continue;
        const n = nz * w + nx;
        if (candidate[n] && !seen[n]) {
          seen[n] = 1;
          stack.push(n);
        }
      }
    }
    if (maxDepth > 3.5 && cells.length >= 30 && f.data[cells[0]] > seaLevel)
      for (const c of cells) mask[c] = 1;
  }
  return mask;
}

function traceRivers(
  f: HeightField,
  dir: Int32Array,
  flux: Float32Array,
  lakeMask: Uint8Array,
  threshold: number,
  seaLevel: number,
): River[] {
  const { w, h, data } = f;
  const isRiver = (i: number) =>
    flux[i] >= threshold && data[i] > seaLevel && !lakeMask[i];
  const upstream = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) if (isRiver(i) && dir[i] >= 0) upstream[dir[i]] = 1;
  // Sources: river cells with no river cell flowing into them, ordered by flux so the
  // trunk is traced first and tributaries stop where they join it.
  const sources: number[] = [];
  for (let i = 0; i < w * h; i++) if (isRiver(i) && !upstream[i]) sources.push(i);
  const seeds = Array.from(new Set(sources)).sort((a, b) => flux[a] - flux[b]);
  const claimed = new Int32Array(w * h).fill(-1),
    rivers: River[] = [];
  const widthAt = (i: number) =>
    Math.min(30, 3.5 + 1.1 * Math.sqrt(flux[i] / threshold) * 3);
  for (const source of seeds) {
    let i = source;
    const cells: number[] = [];
    while (i >= 0 && claimed[i] < 0 && data[i] > seaLevel && !lakeMask[i]) {
      cells.push(i);
      i = dir[i];
    }
    if (i >= 0) cells.push(i);
    if (cells.length < 10) continue;
    const id = rivers.length;
    for (const c of cells) if (claimed[c] < 0) claimed[c] = id;
    const points = cells.map((c) => {
      const x = c % w;
      return toWorld(f, x, (c - x) / w);
    });
    const widths = cells.map(widthAt);
    const length = cells.length * f.cell,
      peak = flux[cells[cells.length - 2] ?? cells[0]];
    rivers.push({
      points: smoothPolyline(points, 2),
      widths,
      order: peak > threshold * 12 ? "main" : length > 900 ? "river" : "stream",
    });
  }
  return rivers;
}

function smoothPolyline(points: Point[], passes: number) {
  let out = points;
  for (let p = 0; p < passes; p++) {
    const next: Point[] = [out[0]];
    for (let i = 1; i < out.length - 1; i++)
      next.push({
        x: out[i - 1].x * 0.25 + out[i].x * 0.5 + out[i + 1].x * 0.25,
        z: out[i - 1].z * 0.25 + out[i].z * 0.5 + out[i + 1].z * 0.25,
      });
    next.push(out[out.length - 1]);
    out = next;
  }
  return out;
}

/** Lower a parabolic channel along each river and force the bed to descend. */
function carveRivers(f: HeightField, rivers: River[], seaLevel: number, seed: number) {
  const { w, h, data } = f,
    noise = new Noise(derive(seed, "banks"));
  for (const river of rivers) {
    let bed = Infinity;
    for (let k = 0; k < river.points.length; k++) {
      const p = river.points[k],
        width = river.widths[k],
        depth = Math.min(6, 1 + width * 0.16);
      const cx = (p.x + f.size / 2) / f.cell,
        cz = (p.z + f.size / 2) / f.cell;
      const ix = Math.round(cx),
        iz = Math.round(cz);
      if (ix < 1 || iz < 1 || ix >= w - 1 || iz >= h - 1) continue;
      const here = data[iz * w + ix];
      bed = Math.min(bed - 0.03, here - depth);
      if (bed < seaLevel - 1.5) bed = seaLevel - 1.5;
      const halfWidth = width / 2 + f.cell * 0.6,
        bank = halfWidth + f.cell * 1.5,
        rc = Math.ceil(bank / f.cell);
      for (let dz = -rc; dz <= rc; dz++)
        for (let dx = -rc; dx <= rc; dx++) {
          const x = ix + dx,
            z = iz + dz;
          if (x < 1 || z < 1 || x >= w - 1 || z >= h - 1) continue;
          const d = Math.hypot(dx * f.cell, dz * f.cell),
            i = z * w + x;
          if (d <= halfWidth) {
            const t = d / halfWidth;
            data[i] = Math.min(data[i], bed + depth * t * t * 0.3);
          } else if (d <= bank) {
            const t = (d - halfWidth) / (bank - halfWidth),
              wobble = 0.3 * noise.at(x * 0.2, z * 0.2);
            const target =
              bed + depth * 0.3 + (data[i] - bed - depth * 0.3) * t + wobble;
            data[i] = Math.min(data[i], Math.max(target, bed + 0.2));
          }
        }
    }
  }
}

/**
 * Outlines of a cell mask as closed rings of cell-corner points, inside on the left.
 * Directed unit edges are keyed by their start corner; at saddle corners (two
 * diagonal inside cells touching) the right-hand turn is taken so rings stay simple.
 */
export function maskOutlines(f: HeightField, mask: Uint8Array): Point[][] {
  const { w, h } = f,
    W = w + 1;
  const at = (x: number, z: number) =>
    x < 0 || z < 0 || x >= w || z >= h ? 0 : mask[z * w + x];
  // Edge directions: 0 = +x, 1 = +z, 2 = -x, 3 = -z. Stored per start corner as a bitmask.
  const out = new Uint8Array(W * (h + 1));
  const step = [
    [1, 0],
    [0, 1],
    [-1, 0],
    [0, -1],
  ];
  for (let z = 0; z <= h; z++)
    for (let x = 0; x <= w; x++) {
      const inside = at(x, z),
        left = at(x - 1, z),
        up = at(x, z - 1);
      // Vertical edge between (x-1,z) and (x,z) along corner column x, rows z..z+1.
      if (inside !== left) {
        if (inside)
          out[(z + 1) * W + x] |= 1 << 3; // from (x,z+1) to (x,z): -z
        else out[z * W + x] |= 1 << 1; // from (x,z) to (x,z+1): +z
      }
      // Horizontal edge between (x,z-1) and (x,z) along corner row z, columns x..x+1.
      if (inside !== up) {
        if (inside)
          out[z * W + x] |= 1 << 0; // +x
        else out[z * W + x + 1] |= 1 << 2; // -x
      }
    }
  const rings: Point[][] = [];
  for (let start = 0; start < out.length; start++) {
    while (out[start]) {
      const ring: Point[] = [];
      let corner = start,
        dir = 31 - Math.clz32(out[start]); // any available direction
      let guard = 0;
      for (;;) {
        out[corner] &= ~(1 << dir);
        ring.push(toWorld(f, (corner % W) - 0.5, Math.floor(corner / W) - 0.5));
        const next = corner + step[dir][0] + step[dir][1] * W;
        if (next === start || guard++ > out.length) break;
        const available = out[next];
        if (!available) break;
        // Prefer turning right, then straight, then left, so saddles split cleanly.
        const order = [(dir + 3) & 3, dir, (dir + 1) & 3];
        const chosen = order.find((d) => available & (1 << d));
        if (chosen === undefined) break;
        corner = next;
        dir = chosen;
      }
      if (ring.length >= 4) rings.push(ring);
    }
  }
  return rings;
}

function lakeOutlines(f: HeightField, lakeMask: Uint8Array): Lake[] {
  return maskOutlines(f, lakeMask).map((outline) => {
    let level = -Infinity;
    for (const p of outline) {
      const x = Math.round((p.x + f.size / 2) / f.cell),
        z = Math.round((p.z + f.size / 2) / f.cell);
      if (x >= 0 && z >= 0 && x < f.w && z < f.h)
        level = Math.max(level, f.data[z * f.w + x]);
    }
    return { outline: smoothPolyline([...outline, outline[0]], 2).slice(0, -1), level };
  });
}
