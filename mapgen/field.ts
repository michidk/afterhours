import type { HeightField, Point } from "./types.ts";

export function createField(size: number, cell: number): HeightField {
  const w = Math.round(size / cell) + 1;
  return { w, h: w, cell, size, data: new Float32Array(w * w) };
}
export const cloneField = (f: HeightField): HeightField => ({
  ...f,
  data: new Float32Array(f.data),
});
/** World metres → fractional cell coordinates. */
export const toCell = (f: HeightField, x: number, z: number) => ({
  u: (x + f.size / 2) / f.cell,
  v: (z + f.size / 2) / f.cell,
});
export const toWorld = (f: HeightField, cx: number, cz: number): Point => ({
  x: cx * f.cell - f.size / 2,
  z: cz * f.cell - f.size / 2,
});
export function sample(f: HeightField, x: number, z: number) {
  const { u, v } = toCell(f, x, z);
  const ix = Math.max(0, Math.min(f.w - 2, Math.floor(u))),
    iz = Math.max(0, Math.min(f.h - 2, Math.floor(v)));
  const tu = Math.max(0, Math.min(1, u - ix)),
    tv = Math.max(0, Math.min(1, v - iz)),
    i = iz * f.w + ix,
    d = f.data;
  const top = d[i] + (d[i + 1] - d[i]) * tu,
    bottom = d[i + f.w] + (d[i + f.w + 1] - d[i + f.w]) * tu;
  return top + (bottom - top) * tv;
}
/** Gradient in metres per metre using central differences on the grid. */
export function gradient(f: HeightField, x: number, z: number) {
  const e = f.cell;
  return {
    gx: (sample(f, x + e, z) - sample(f, x - e, z)) / (2 * e),
    gz: (sample(f, x, z + e) - sample(f, x, z - e)) / (2 * e),
  };
}
export function slope(f: HeightField, x: number, z: number) {
  const { gx, gz } = gradient(f, x, z);
  return Math.hypot(gx, gz);
}
/** Cell-space slope magnitude for inner cells; edge cells reuse their neighbour. */
export function cellSlope(f: HeightField, ix: number, iz: number) {
  const x0 = Math.max(0, ix - 1),
    x1 = Math.min(f.w - 1, ix + 1),
    z0 = Math.max(0, iz - 1),
    z1 = Math.min(f.h - 1, iz + 1);
  const gx = (f.data[iz * f.w + x1] - f.data[iz * f.w + x0]) / ((x1 - x0) * f.cell);
  const gz = (f.data[z1 * f.w + ix] - f.data[z0 * f.w + ix]) / ((z1 - z0) * f.cell);
  return Math.hypot(gx, gz);
}
/** Separable box blur with a given radius in cells, repeated for a Gaussian-like result. */
export function blur(
  src: Float32Array,
  w: number,
  h: number,
  radius: number,
  passes = 2,
) {
  let a = new Float32Array(src),
    b = new Float32Array(src.length);
  for (let pass = 0; pass < passes; pass++) {
    for (let z = 0; z < h; z++) {
      let sum = 0,
        count = 0;
      for (let x = -radius; x <= radius; x++) {
        if (x >= 0 && x < w) {
          sum += a[z * w + x];
          count++;
        }
      }
      for (let x = 0; x < w; x++) {
        b[z * w + x] = sum / count;
        const out = x - radius,
          inn = x + radius + 1;
        if (out >= 0) {
          sum -= a[z * w + out];
          count--;
        }
        if (inn < w) {
          sum += a[z * w + inn];
          count++;
        }
      }
    }
    for (let x = 0; x < w; x++) {
      let sum = 0,
        count = 0;
      for (let z = -radius; z <= radius; z++)
        if (z >= 0 && z < h) {
          sum += b[z * w + x];
          count++;
        }
      for (let z = 0; z < h; z++) {
        a[z * w + x] = sum / count;
        const out = z - radius,
          inn = z + radius + 1;
        if (out >= 0) {
          sum -= b[out * w + x];
          count--;
        }
        if (inn < h) {
          sum += b[inn * w + x];
          count++;
        }
      }
    }
  }
  return a;
}
/**
 * Exact Euclidean distance transform (Felzenszwalb & Huttenlocher) from the cells
 * where `inside` is true, in cell units. Used for coast, river and road distances.
 */
export function distanceTransform(inside: Uint8Array, w: number, h: number) {
  const INF = 1e20,
    f = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) f[i] = inside[i] ? 0 : INF;
  const edt1d = (src: Float64Array, n: number, out: Float64Array) => {
    const v = new Int32Array(n),
      z = new Float64Array(n + 1);
    let k = 0;
    v[0] = 0;
    z[0] = -INF;
    z[1] = INF;
    for (let q = 1; q < n; q++) {
      let s = (src[q] + q * q - (src[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) {
        k--;
        s = (src[q] + q * q - (src[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < n; q++) {
      while (z[k + 1] < q) k++;
      out[q] = (q - v[k]) * (q - v[k]) + src[v[k]];
    }
  };
  const col = new Float64Array(h),
    colOut = new Float64Array(h);
  for (let x = 0; x < w; x++) {
    for (let z = 0; z < h; z++) col[z] = f[z * w + x];
    edt1d(col, h, colOut);
    for (let z = 0; z < h; z++) f[z * w + x] = colOut[z];
  }
  const row = new Float64Array(w),
    rowOut = new Float64Array(w);
  for (let z = 0; z < h; z++) {
    for (let x = 0; x < w; x++) row[x] = f[z * w + x];
    edt1d(row, w, rowOut);
    for (let x = 0; x < w; x++) f[z * w + x] = Math.sqrt(rowOut[x]);
  }
  return f;
}
