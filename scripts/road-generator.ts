import { random, type Road } from "../shared/world.ts";
type P = [number, number];
/** Authored district structure, seeded local variation, then planar intersection splitting. */
export function generateRoads(seed: number): Road[] {
  const raw: Road[] = [],
    r = random(seed ^ 0x51a7);
  const round = (n: number) => Math.round(n * 100) / 100;
  const segment = (a: P, b: P, kind: Road["kind"]) => {
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1) return;
    raw.push({
      x: (a[0] + b[0]) / 2,
      z: (a[1] + b[1]) / 2,
      ax: a[0],
      az: a[1],
      bx: b[0],
      bz: b[1],
      width: kind === "avenue" || kind === "coast" ? 18 : 14,
      kind,
    });
  };
  const line = (points: P[], kind: Road["kind"] = "street", curve = false) => {
    if (!curve) {
      for (let i = 1; i < points.length; i++) segment(points[i - 1], points[i], kind);
      return;
    }
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[Math.max(0, i - 1)],
        b = points[i],
        c = points[i + 1],
        d = points[Math.min(points.length - 1, i + 2)];
      const steps = Math.max(2, Math.ceil(Math.hypot(c[0] - b[0], c[1] - b[1]) / 32));
      let previous = b;
      for (let j = 1; j <= steps; j++) {
        const t = j / steps,
          t2 = t * t,
          t3 = t2 * t;
        const next = b.map((_, k) =>
          round(
            0.5 *
              (2 * b[k] +
                (-a[k] + c[k]) * t +
                (2 * a[k] - 5 * b[k] + 4 * c[k] - d[k]) * t2 +
                (-a[k] + 3 * b[k] - 3 * c[k] + d[k]) * t3),
          ),
        ) as P;
        segment(previous, next, kind);
        previous = next;
      }
    }
  };
  // Only the old downtown has compact orthogonal blocks. Streets end at district edges.
  for (const x of [-256, -192, -128, -64, 0, 64])
    line(
      [[-192, -128, -64, 0, 64, 128, 192].map((z) => [x, z] as P)][0],
      x === 0 ? "avenue" : "street",
    );
  for (const z of [-192, -128, -64, 0, 64, 128, 192])
    line(
      [
        [-256, z],
        [64, z],
      ],
      z === 0 ? "avenue" : "street",
    );
  const ring: P[] = Array.from({ length: 24 }, (_, i) => {
    const a = (i * Math.PI) / 12;
    return [
      round(Math.cos(a) * (716 + 22 * Math.sin(a * 3))),
      round(Math.sin(a) * (690 + 24 * Math.cos(a * 2))),
    ] as P;
  });
  line([...ring, ring[0]], "coast", true);
  // Radial avenues join districts at different angles, not island-wide parallels.
  line([[64, 0], [210, 35], [370, -20], [530, 70], ring[0]], "avenue", true);
  line([[-256, 0], [-370, -35], [-500, 30], ring[12]], "avenue", true);
  line([[0, 192], [45, 300], [-20, 460], [35, 580], ring[6]], "avenue", true);
  line([[0, -192], [-30, -320], [70, -440], [15, -575], ring[18]], "avenue", true);
  // Sunset promenade and back streets, with curved connections to the coast road.
  line([ring[10], [-590, 250], [-570, 70], [-610, -130], ring[14]], "street", true);
  line(
    [
      [-256, 128],
      [-375, 205],
      [-480, 170],
      [-590, 250],
    ],
    "street",
    true,
  );
  line(
    [
      [-256, -128],
      [-360, -195],
      [-485, -175],
      [-610, -130],
    ],
    "street",
    true,
  );
  line([ring[11], [-570, 70], [-500, 30]], "street", true);
  line([ring[13], [-610, -130], [-550, -315], ring[15]], "street", true);
  // Industrial spines, angled service streets, and a loop around the airport approaches.
  line(
    [[370, -20], [410, -170], [350, -325], [420, -470], [365, -605], ring[20]],
    "avenue",
    true,
  );
  line(
    [
      [70, -440],
      [240, -485],
      [420, -470],
      [565, -470],
      [755, -495],
      [765, -690],
    ],
    "avenue",
    true,
  );
  line(
    [
      [15, -575],
      [170, -670],
      [365, -605],
    ],
    "street",
    true,
  );
  line(
    [
      [210, 35],
      [235, -150],
      [170, -270],
      [-30, -320],
    ],
    "street",
    true,
  );
  for (const [x, z] of [
    [410, -170],
    [350, -325],
    [420, -470],
    [365, -605],
  ]) {
    line(
      [
        [x, z],
        [x + 120, z + 35],
        [x + 215, z + 95],
      ],
      "service",
    );
  }
  line(
    [
      [565, -470],
      [500, -570],
      [495, -730],
      [640, -765],
      [765, -690],
    ],
    "street",
    true,
  );
  // University crescent and the northern residential loops.
  line(
    [
      [64, 128],
      [190, 175],
      [290, 295],
      [420, 270],
      [520, 365],
      [425, 455],
      [290, 415],
      [290, 295],
    ],
    "street",
    true,
  );
  line(
    [
      [45, 300],
      [190, 335],
      [290, 295],
    ],
    "avenue",
    true,
  );
  line([[520, 365], ring[2]], "street", true);
  line([[425, 455], [410, 560], ring[4]], "street", true);
  line(
    [
      [-192, 192],
      [-280, 320],
      [-260, 460],
      [-130, 505],
      [-20, 460],
    ],
    "street",
    true,
  );
  line([[-280, 320], [-420, 405], ring[9]], "street", true);
  line([[-260, 460], [-325, 570], ring[8]], "street", true);
  for (const [x, z] of [
    [-260, 460],
    [-130, 505],
    [35, 580],
    [410, 560],
  ]) {
    const bend = (r() - 0.5) * 22;
    line(
      [
        [x, z],
        [x + 65, z + 45 + bend],
        [x + 85, z + 105],
      ],
      "street",
      true,
    );
  }
  // Split every crossing and T-junction into shared endpoints, including intersections on curves.
  const cuts = raw.map(() => [0, 1]);
  for (let i = 0; i < raw.length; i++)
    for (let j = i + 1; j < raw.length; j++) {
      const a = raw[i],
        b = raw[j],
        ux = a.bx - a.ax,
        uz = a.bz - a.az,
        vx = b.bx - b.ax,
        vz = b.bz - b.az;
      const cross = ux * vz - uz * vx;
      if (Math.abs(cross) < 1e-8) continue;
      const wx = b.ax - a.ax,
        wz = b.az - a.az,
        t = (wx * vz - wz * vx) / cross,
        u = (wx * uz - wz * ux) / cross;
      if (t >= -1e-7 && t <= 1 + 1e-7 && u >= -1e-7 && u <= 1 + 1e-7) {
        cuts[i].push(Math.max(0, Math.min(1, t)));
        cuts[j].push(Math.max(0, Math.min(1, u)));
      }
    }
  const roads: Road[] = [],
    seen = new Set<string>();
  raw.forEach((road, i) => {
    const ts = [...new Set(cuts[i])].sort((a, b) => a - b);
    for (let j = 1; j < ts.length; j++) {
      const ax = round(road.ax + (road.bx - road.ax) * ts[j - 1]),
        az = round(road.az + (road.bz - road.az) * ts[j - 1]);
      const bx = round(road.ax + (road.bx - road.ax) * ts[j]),
        bz = round(road.az + (road.bz - road.az) * ts[j]);
      if (Math.hypot(bx - ax, bz - az) < 0.05) continue;
      const key = [`${ax},${az}`, `${bx},${bz}`].sort().join(":");
      if (seen.has(key)) continue;
      seen.add(key);
      roads.push({
        ...road,
        ax,
        az,
        bx,
        bz,
        x: round((ax + bx) / 2),
        z: round((az + bz) / 2),
      });
    }
  });
  const degrees = new Map<string, number>();
  for (const p of roads)
    for (const key of [`${p.ax},${p.az}`, `${p.bx},${p.bz}`])
      degrees.set(key, (degrees.get(key) || 0) + 1);
  for (const p of roads) {
    p.signalA = (degrees.get(`${p.ax},${p.az}`) || 0) >= 3;
    p.signalB = (degrees.get(`${p.bx},${p.bz}`) || 0) >= 3;
  }
  return roads;
}
