// Orthographic photos of the baked city meshes, for reviewing street geometry
// without a browser: tsx scripts/street-photos.ts meshes.msgpack sites.json outdir
// Each site is { name, x, z, size } in metres, with optional pitch (90 = straight
// down), yaw in degrees and px image width. Flat sun shading, no shadows or water.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { gunzipSync, deflateSync } from "node:zlib";
import { decode } from "@msgpack/msgpack";
const [file, sitesFile, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const pack = decode(readFileSync(file)) as any;
const base = JSON.parse(gunzipSync(pack.base).toString());
const chunkCache = new Map<string, any[]>();
const CHUNK = 128;
function chunkMeshes(key: string) {
  if (!chunkCache.has(key)) {
    const raw = pack.chunks[key];
    const meshes: any[] = [];
    if (raw) {
      const c = JSON.parse(gunzipSync(raw).toString()).geometry;
      for (const g of Object.values(c.features) as any[]) meshes.push(...g);
      if (c.airport) meshes.push(...c.airport);
    }
    chunkCache.set(key, meshes);
  }
  return chunkCache.get(key)!;
}
const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
function png(w: number, h: number, rgb: Uint8Array) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++)
    rgb
      .subarray(y * w * 3, (y + 1) * w * 3)
      .forEach((v, i) => (raw[y * (w * 3 + 1) + 1 + i] = v));
  const crcT = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = ~0;
    for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8);
    return ~c >>> 0;
  };
  const chunk = (t: string, d: Buffer) => {
    const l = Buffer.alloc(4);
    l.writeUInt32BE(d.length);
    const td = Buffer.concat([Buffer.from(t), d]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([l, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
type Site = {
  name: string;
  x: number;
  z: number;
  size: number;
  px?: number;
  pitch?: number;
  yaw?: number;
};
const sites: Site[] = JSON.parse(readFileSync(sitesFile, "utf8"));
for (const s of sites) {
  const W = s.px ?? 900,
    H = W,
    scale = W / s.size;
  const pitch = ((s.pitch ?? 90) * Math.PI) / 180,
    yaw = ((s.yaw ?? 0) * Math.PI) / 180;
  // view basis: right, up(screen), forward(into scene)
  const fwd = [
    Math.sin(yaw) * Math.cos(pitch),
    -Math.sin(pitch),
    Math.cos(yaw) * Math.cos(pitch),
  ];
  const right = [Math.cos(yaw), 0, -Math.sin(yaw)];
  const up = [
    right[1] * fwd[2] - right[2] * fwd[1],
    right[2] * fwd[0] - right[0] * fwd[2],
    right[0] * fwd[1] - right[1] * fwd[0],
  ].map((v) => -v);
  let ys = 0,
    yn = 0;
  for (const m of base)
    for (let i = 0; i < m.positions.length; i += 3)
      if (
        Math.abs(m.positions[i] - s.x) < s.size / 4 &&
        Math.abs(m.positions[i + 2] - s.z) < s.size / 4
      ) {
        ys += m.positions[i + 1];
        yn++;
      }
  const cy = yn ? ys / yn : 0;
  const proj = (x: number, y: number, z: number) => {
    const dx = x - s.x,
      dy = y - cy,
      dz = z - s.z;
    return [
      W / 2 + (dx * right[0] + dy * right[1] + dz * right[2]) * scale,
      H / 2 - (dx * up[0] + dy * up[1] + dz * up[2]) * scale,
      dx * fwd[0] + dy * fwd[1] + dz * fwd[2],
    ];
  };
  const depth = new Float32Array(W * H).fill(Infinity),
    rgb = new Uint8Array(W * H * 3).fill(40);
  const sun = [0.35, 0.85, 0.4];
  const sl = Math.hypot(...sun);
  const meshes = [...base];
  const r = s.size;
  for (
    let cx = Math.floor((s.x - r) / CHUNK);
    cx <= Math.floor((s.x + r) / CHUNK);
    cx++
  )
    for (
      let cz = Math.floor((s.z - r) / CHUNK);
      cz <= Math.floor((s.z + r) / CHUNK);
      cz++
    )
      meshes.push(...chunkMeshes(`${cx},${cz}`));
  for (const m of meshes) {
    if (m.material.role === "glow") continue;
    const P = m.positions,
      N = m.normals,
      C = m.colors,
      base = hex(m.material.color);
    const pv: number[][] = [];
    for (let i = 0; i < P.length; i += 3) pv.push(proj(P[i], P[i + 1], P[i + 2]));
    const I = m.indices;
    for (let t = 0; t < I.length; t += 3) {
      const [a, b, c] = [I[t], I[t + 1], I[t + 2]];
      const A = pv[a],
        B = pv[b],
        Cc = pv[c];
      const minX = Math.max(0, Math.floor(Math.min(A[0], B[0], Cc[0]))),
        maxX = Math.min(W - 1, Math.ceil(Math.max(A[0], B[0], Cc[0])));
      const minY = Math.max(0, Math.floor(Math.min(A[1], B[1], Cc[1]))),
        maxY = Math.min(H - 1, Math.ceil(Math.max(A[1], B[1], Cc[1])));
      if (minX > maxX || minY > maxY) continue;
      const area = (B[0] - A[0]) * (Cc[1] - A[1]) - (B[1] - A[1]) * (Cc[0] - A[0]);
      if (Math.abs(area) < 1e-9) continue;
      // flat normal from geometry so both faces shade
      const ux = P[b * 3] - P[a * 3],
        uy = P[b * 3 + 1] - P[a * 3 + 1],
        uz = P[b * 3 + 2] - P[a * 3 + 2];
      const vx = P[c * 3] - P[a * 3],
        vy = P[c * 3 + 1] - P[a * 3 + 1],
        vz = P[c * 3 + 2] - P[a * 3 + 2];
      let nx = uy * vz - uz * vy,
        ny = uz * vx - ux * vz,
        nz = ux * vy - uy * vx;
      const nl = Math.hypot(nx, ny, nz) || 1;
      if (nx * fwd[0] + ny * fwd[1] + nz * fwd[2] > 0) {
        nx = -nx;
        ny = -ny;
        nz = -nz;
      }
      const lit =
        0.45 + 0.55 * Math.max(0, (nx * sun[0] + ny * sun[1] + nz * sun[2]) / nl / sl);
      const col = C ? [C[a * 4], C[a * 4 + 1], C[a * 4 + 2]] : base;
      for (let y = minY; y <= maxY; y++)
        for (let x = minX; x <= maxX; x++) {
          const px = x + 0.5,
            py = y + 0.5;
          const w0 = ((B[0] - px) * (Cc[1] - py) - (B[1] - py) * (Cc[0] - px)) / area;
          const w1 = ((Cc[0] - px) * (A[1] - py) - (Cc[1] - py) * (A[0] - px)) / area;
          const w2 = 1 - w0 - w1;
          if (w0 < 0 || w1 < 0 || w2 < 0) continue;
          const d = w0 * A[2] + w1 * B[2] + w2 * Cc[2],
            k = y * W + x;
          if (d >= depth[k]) continue;
          depth[k] = d;
          for (let j = 0; j < 3; j++)
            rgb[k * 3 + j] = Math.min(255, col[j] * lit * 255);
        }
    }
  }
  writeFileSync(`${out}/${s.name}.png`, png(W, H, rgb));
  console.log("wrote", s.name);
}
