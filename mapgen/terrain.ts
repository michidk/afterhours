import { blur, createField, distanceTransform } from "./field.ts";
import { Noise, derive, smoothstep, lerp, clamp, type Rng } from "./random.ts";
import type { HeightField } from "./types.ts";

export interface TerrainTuning {
  /** Fraction of the square map that should be land. */
  landFraction: number;
  maxHill: number;
  plateau: [number, number];
  droplets: number;
  thermalIterations: number;
}
export const TERRAIN_DEFAULTS: TerrainTuning = {
  landFraction: 0.44,
  maxHill: 170,
  plateau: [6, 26],
  droplets: 0.8,
  thermalIterations: 12,
};

/**
 * Stage 1a: raw island heightmap. Low-frequency "continentalness" through a warped
 * island mask, an "erosion" field that decides flat (urban) versus hilly land, and a
 * ridged peaks/valleys field only where the land is hilly. Sea level is the height
 * quantile that gives the requested land fraction, then shifted to zero.
 */
export function generateHeightmap(
  seed: number,
  size: number,
  cell: number,
  tuning = TERRAIN_DEFAULTS,
) {
  const f = createField(size, cell),
    warp = new Noise(derive(seed, "warp")),
    shape = new Noise(derive(seed, "shape")),
    erosionField = new Noise(derive(seed, "erosion")),
    ridges = new Noise(derive(seed, "ridges")),
    detail = new Noise(derive(seed, "detail")),
    rng = derive(seed, "island");
  const spin = rng() * Math.PI * 2,
    stretch = 0.8 + rng() * 0.45,
    lobes = 2 + Math.floor(rng() * 3),
    lobePhase = rng() * Math.PI * 2;
  const flatness = new Float32Array(f.w * f.h);
  // Low-frequency fields are evaluated on a coarse lattice and interpolated; only
  // the fine detail octaves need every cell.
  const stride = 4,
    cw = Math.ceil((f.w - 1) / stride) + 1;
  const cMask = new Float32Array(cw * cw),
    cFlat = new Float32Array(cw * cw),
    cBase = new Float32Array(cw * cw),
    cSeabed = new Float32Array(cw * cw);
  for (let cz = 0; cz < cw; cz++)
    for (let cx = 0; cx < cw; cx++) {
      const nx = ((cx * stride) / (f.w - 1)) * 2 - 1,
        nz = ((cz * stride) / (f.h - 1)) * 2 - 1;
      // Domain-warp the mask input so bays and headlands are not concentric.
      const wx = nx + 0.28 * warp.fbm(nx * 1.4 + 11.3, nz * 1.4 + 3.7, 3);
      const wz = nz + 0.28 * warp.fbm(nx * 1.4 - 7.1, nz * 1.4 + 19.2, 3);
      const rx = wx * Math.cos(spin) - wz * Math.sin(spin),
        rz = (wx * Math.sin(spin) + wz * Math.cos(spin)) * stretch;
      const angle = Math.atan2(rz, rx),
        radius = Math.hypot(rx, rz) * (1 + 0.14 * Math.sin(angle * lobes + lobePhase));
      const coastNoise = 0.1 * shape.fbm(nx * 3.1 + 5, nz * 3.1 - 2, 4);
      const mask = smoothstep(0.98, 0.42, radius + coastNoise);
      // Erosion/flatness: high values are flat lowland suited to the city. A coastal
      // plain keeps the shore mostly flat while the interior rises into hills.
      const e = clamp(
        0.5 + 0.9 * erosionField.fbm(nx * 1.3 + 2.2, nz * 1.3 - 4.4, 3),
        0,
        1,
      );
      const plain = smoothstep(0.5, 0.78, radius + coastNoise * 0.5);
      const flat = Math.max(smoothstep(0.28, 0.58, e), plain * 0.92);
      const pv = ridges.ridged(nx * 2.4 - 1.1, nz * 2.4 + 6.5, 5);
      const broad = 0.5 + 0.5 * shape.fbm(nx * 1.1 - 9, nz * 1.1 + 4, 3);
      const lowland = lerp(tuning.plateau[0], tuning.plateau[1], broad);
      const hills = (1 - flat) * tuning.maxHill * (0.3 * broad + 0.7 * pv * pv);
      const i = cz * cw + cx;
      cMask[i] = mask;
      cFlat[i] = flat;
      cBase[i] = lowland + hills;
      cSeabed[i] = -4 - 32 * smoothstep(0.4, 0.9, radius);
    }
  const bilinear = (grid: Float32Array, u: number, v: number) => {
    const x0 = Math.min(cw - 2, Math.floor(u)),
      z0 = Math.min(cw - 2, Math.floor(v)),
      tu = u - x0,
      tv = v - z0,
      i = z0 * cw + x0;
    const top = grid[i] + (grid[i + 1] - grid[i]) * tu,
      bottom = grid[i + cw] + (grid[i + cw + 1] - grid[i + cw]) * tu;
    return top + (bottom - top) * tv;
  };
  for (let z = 0; z < f.h; z++)
    for (let x = 0; x < f.w; x++) {
      const nx = (x / (f.w - 1)) * 2 - 1,
        nz = (z / (f.h - 1)) * 2 - 1,
        u = x / stride,
        v = z / stride;
      const mask = bilinear(cMask, u, v),
        flat = bilinear(cFlat, u, v);
      flatness[z * f.w + x] = flat;
      const fine = detail.fbm(nx * 9 + 1, nz * 9 - 3, 5) * (1.2 + 9 * (1 - flat));
      // Land height blends with the mask; seabed continues to a shelf then deep water.
      const land = bilinear(cBase, u, v) + fine;
      f.data[z * f.w + x] = lerp(bilinear(cSeabed, u, v), land, mask);
    }
  // Sea level as a quantile keeps the land fraction stable across seeds.
  const sorted = Float32Array.from(f.data).sort();
  const sea = sorted[Math.floor(sorted.length * (1 - tuning.landFraction))];
  for (let i = 0; i < f.data.length; i++) f.data[i] -= sea;
  return { field: f, flatness };
}

/** Thermal erosion: material above the talus angle slides to the lowest neighbour. */
export function thermalErosion(f: HeightField, iterations: number, talusAngle = 0.6) {
  const { w, h, data } = f,
    talus = talusAngle * f.cell;
  for (let it = 0; it < iterations; it++)
    for (let z = 1; z < h - 1; z++)
      for (let x = 1; x < w - 1; x++) {
        const i = z * w + x;
        if (data[i] <= 0) continue;
        let lowest = i,
          lowestH = data[i];
        for (const n of [i - 1, i + 1, i - w, i + w]) {
          if (data[n] < lowestH) {
            lowestH = data[n];
            lowest = n;
          }
        }
        const diff = data[i] - lowestH;
        if (diff > talus) {
          const move = (diff - talus) * 0.25;
          data[i] -= move;
          data[lowest] += move;
        }
      }
}

/**
 * Particle hydraulic erosion after Beyer/Lague. Droplets stop at the sea and never
 * erode below the sea floor shelf, so valleys drain toward the coast.
 */
export function dropletErosion(f: HeightField, rng: Rng, count: number) {
  const { w, h, data } = f;
  const inertia = 0.06,
    capacityFactor = 6,
    minCapacity = 0.01,
    erodeSpeed = 0.3,
    depositSpeed = 0.3,
    evaporate = 0.012,
    gravity = 4,
    maxLife = 32,
    radius = 2;
  const brush: { dx: number; dz: number; weight: number }[] = [];
  let total = 0;
  for (let dz = -radius; dz <= radius; dz++)
    for (let dx = -radius; dx <= radius; dx++) {
      const d = Math.hypot(dx, dz);
      if (d <= radius) {
        const weight = 1 - d / radius;
        brush.push({ dx, dz, weight });
        total += weight;
      }
    }
  for (const b of brush) b.weight /= total;
  const heightAndGradient = (px: number, pz: number) => {
    const ix = Math.floor(px),
      iz = Math.floor(pz),
      u = px - ix,
      v = pz - iz,
      i = iz * w + ix;
    const nw = data[i],
      ne = data[i + 1],
      sw = data[i + w],
      se = data[i + w + 1];
    return {
      height: nw * (1 - u) * (1 - v) + ne * u * (1 - v) + sw * (1 - u) * v + se * u * v,
      gx: (ne - nw) * (1 - v) + (se - sw) * v,
      gz: (sw - nw) * (1 - u) + (se - ne) * u,
    };
  };
  for (let n = 0; n < count; n++) {
    let px = 1 + rng() * (w - 3),
      pz = 1 + rng() * (h - 3);
    if (data[Math.floor(pz) * w + Math.floor(px)] <= 0) continue;
    let dx = 0,
      dz = 0,
      speed = 1,
      water = 1,
      sediment = 0;
    for (let life = 0; life < maxLife; life++) {
      const ix = Math.floor(px),
        iz = Math.floor(pz);
      const u = px - ix,
        v = pz - iz;
      const here = heightAndGradient(px, pz);
      dx = dx * inertia - here.gx * (1 - inertia);
      dz = dz * inertia - here.gz * (1 - inertia);
      const l = Math.hypot(dx, dz);
      if (l < 1e-6) {
        const a = rng() * Math.PI * 2;
        dx = Math.cos(a);
        dz = Math.sin(a);
      } else {
        dx /= l;
        dz /= l;
      }
      const nx = px + dx,
        nz = pz + dz;
      if (nx < 1 || nz < 1 || nx >= w - 2 || nz >= h - 2) break;
      const next = heightAndGradient(nx, nz).height;
      if (next <= 0) break;
      const dh = next - here.height;
      const capacity = Math.max(-dh * speed * water * capacityFactor, minCapacity);
      if (sediment > capacity || dh > 0) {
        const amount =
          dh > 0 ? Math.min(dh, sediment) : (sediment - capacity) * depositSpeed;
        sediment -= amount;
        const i = iz * w + ix;
        data[i] += amount * (1 - u) * (1 - v);
        data[i + 1] += amount * u * (1 - v);
        data[i + w] += amount * (1 - u) * v;
        data[i + w + 1] += amount * u * v;
      } else {
        const amount = Math.min((capacity - sediment) * erodeSpeed, -dh);
        for (const b of brush) {
          const bx = ix + b.dx,
            bz = iz + b.dz;
          if (bx < 0 || bz < 0 || bx >= w || bz >= h) continue;
          const j = bz * w + bx,
            take = Math.min(data[j] - 0.2, amount * b.weight);
          if (take > 0) {
            data[j] -= take;
            sediment += take;
          }
        }
      }
      speed = Math.sqrt(Math.max(0, speed * speed + dh * gravity));
      water *= 1 - evaporate;
      px = nx;
      pz = nz;
    }
  }
}

/** Settle droplet spikes and pits with a small blur that leaves the sea floor alone. */
export function settle(f: HeightField, radius = 1) {
  const smoothed = blur(f.data, f.w, f.h, radius, 1);
  for (let i = 0; i < f.data.length; i++) if (f.data[i] > -0.5) f.data[i] = smoothed[i];
}

/** Keep the largest landmass; islets and sea-locked puddles become shallow water. */
export function keepMainIsland(f: HeightField, seaLevel = 0) {
  const { w, h, data } = f,
    label = new Int32Array(w * h).fill(-1),
    sizes: number[] = [];
  const stack: number[] = [];
  for (let i = 0; i < w * h; i++) {
    if (data[i] <= seaLevel || label[i] >= 0) continue;
    const id = sizes.length;
    sizes.push(0);
    stack.push(i);
    label[i] = id;
    while (stack.length) {
      const c = stack.pop()!;
      sizes[id]++;
      const x = c % w,
        z = (c - x) / w;
      for (const [dx, dz] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const nx = x + dx,
          nz = z + dz;
        if (nx < 0 || nz < 0 || nx >= w || nz >= h) continue;
        const n = nz * w + nx;
        if (data[n] > seaLevel && label[n] < 0) {
          label[n] = id;
          stack.push(n);
        }
      }
    }
  }
  let main = 0;
  for (let i = 1; i < sizes.length; i++) if (sizes[i] > sizes[main]) main = i;
  for (let i = 0; i < w * h; i++)
    if (label[i] >= 0 && label[i] !== main)
      data[i] = seaLevel - 0.6 - (data[i] - seaLevel) * 0.1;
}

/** Beach slope above the waterline, and the shelf below it, as rise per metre. */
const BEACH = 0.06,
  SHELF = 0.1;
/** The beach profile holds out to this distance (m) from the coast, then eases back into the land. */
const COAST_HOLD = 20,
  COAST_REACH = 60;
/**
 * A smooth coastline with one beach profile along all of it. A plateau of near-level
 * cells otherwise ends in a cell-aligned cliff, and the waterline traces the
 * staircase. Instead, the signed distance to the coast (positive on land) is
 * blurred, which turns the contour into a clean curve while the field stays a true
 * distance everywhere. That distance sets a beach ramp on the land side and a
 * shelf on the sea side, blended into the original terrain beyond COAST_REACH. The
 * contour itself sits exactly at sea level.
 */
export function shapeCoast(f: HeightField, seaLevel = 0) {
  const { w, h, data, cell } = f,
    sea = new Uint8Array(w * h),
    land = new Uint8Array(w * h);
  for (let i = 0; i < data.length; i++) (data[i] > seaLevel ? land : sea)[i] = 1;
  // Distances run between cell centres, so the coast lies half a cell closer.
  const toSea = distanceTransform(sea, w, h),
    toLand = distanceTransform(land, w, h),
    signed = new Float32Array(w * h);
  for (let i = 0; i < signed.length; i++)
    signed[i] = (land[i] ? toSea[i] - 0.5 : -(toLand[i] - 0.5)) * cell;
  const smooth = blur(signed, w, h, 2, 2);
  for (let i = 0; i < data.length; i++) {
    const metres = smooth[i],
      weight = 1 - smoothstep(COAST_HOLD, COAST_REACH, Math.abs(metres));
    if (weight <= 0) continue;
    const profile = seaLevel + (metres > 0 ? BEACH : SHELF) * metres;
    data[i] = lerp(data[i], profile, weight);
  }
}
