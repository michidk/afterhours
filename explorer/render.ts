import type { GeneratedMap, HeightField, Point } from "../mapgen/types.ts";

export const LAYERS = [
  { id: "terrain", name: "Terrain & hillshade", on: true },
  { id: "contours", name: "Contours (10 m)", on: true },
  { id: "flow", name: "Flow accumulation", on: false },
  { id: "desirability", name: "Settlement desirability", on: false },
  { id: "water", name: "Rivers & lakes", on: true },
  { id: "blocks", name: "Blocks & zoning", on: true },
  { id: "lots", name: "Lots", on: false },
  { id: "parks", name: "Parks", on: true },
  { id: "roads", name: "Roads", on: true },
  { id: "graph", name: "Road graph (debug)", on: false },
  { id: "buildings", name: "Buildings", on: true },
  { id: "trees", name: "Trees", on: true },
  { id: "lamps", name: "Lamps", on: false },
] as const;
export type LayerId = (typeof LAYERS)[number]["id"];

const ZONE_FILL: Record<string, string> = {
  core: "rgba(214,110,70,0.35)",
  commercial: "rgba(224,170,80,0.32)",
  residential: "rgba(205,190,120,0.30)",
  suburb: "rgba(160,190,110,0.26)",
  industrial: "rgba(120,140,160,0.36)",
  park: "rgba(90,160,90,0.30)",
  rural: "rgba(150,170,110,0.12)",
};
const BUILDING_FILL: Record<string, string> = {
  tower: "#f1e6cf",
  office: "#dfd5c0",
  apartments: "#d9c7a8",
  shop: "#e3b985",
  townhouse: "#d5b094",
  house: "#dcc8a2",
  warehouse: "#b7bfc6",
  civic: "#f0dca8",
};

/** Canvas top-down view with pan/zoom and cached raster layers. */
export class MapView {
  private ctx: CanvasRenderingContext2D;
  private map?: GeneratedMap;
  private enabled = new Set<LayerId>(LAYERS.filter((l) => l.on).map((l) => l.id));
  private scale = 0.25;
  private cx = 0;
  private cz = 0;
  private raster = new Map<string, HTMLCanvasElement>();
  private contourPath?: Path2D;
  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d")!;
    const resize = () => {
      const dpr = devicePixelRatio || 1,
        r = canvas.getBoundingClientRect();
      canvas.width = Math.round(r.width * dpr);
      canvas.height = Math.round(r.height * dpr);
      this.draw();
    };
    new ResizeObserver(resize).observe(canvas);
    let drag: { x: number; y: number; cx: number; cz: number } | undefined;
    canvas.onpointerdown = (e) => {
      drag = { x: e.clientX, y: e.clientY, cx: this.cx, cz: this.cz };
      canvas.setPointerCapture(e.pointerId);
    };
    canvas.onpointermove = (e) => {
      if (!drag || !e.buttons) return;
      this.cx = drag.cx - (e.clientX - drag.x) / this.scale;
      this.cz = drag.cz + (e.clientY - drag.y) / this.scale;
      this.draw();
    };
    canvas.onpointerup = () => (drag = undefined);
    canvas.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const before = this.toWorld(e.clientX, e.clientY);
        this.scale = Math.max(
          0.03,
          Math.min(40, this.scale * (e.deltaY > 0 ? 1 / 1.2 : 1.2)),
        );
        const after = this.toWorld(e.clientX, e.clientY);
        this.cx += before.x - after.x;
        this.cz += before.z - after.z;
        this.draw();
      },
      { passive: false },
    );
  }
  toggle(id: LayerId, on: boolean) {
    if (on) this.enabled.add(id);
    else this.enabled.delete(id);
  }
  setMap(map: GeneratedMap) {
    const first = !this.map;
    this.map = map;
    this.raster.clear();
    this.contourPath = undefined;
    if (first) this.fit();
  }
  centre(): Point {
    return { x: this.cx, z: this.cz };
  }
  /** Programmatic camera, used by scripted screenshots. */
  look(cx: number, cz: number, scale: number) {
    this.cx = cx;
    this.cz = cz;
    this.scale = scale;
    this.draw();
  }
  fit() {
    if (!this.map) return;
    const r = this.canvas.getBoundingClientRect();
    this.scale = (Math.min(r.width, r.height) / this.map.options.size) * 0.95;
    this.cx = this.cz = 0;
  }
  /** CSS pixel → world metres. World +z points up on screen (north). */
  toWorld(clientX: number, clientY: number): Point {
    const r = this.canvas.getBoundingClientRect();
    return {
      x: this.cx + (clientX - r.left - r.width / 2) / this.scale,
      z: this.cz - (clientY - r.top - r.height / 2) / this.scale,
    };
  }
  draw() {
    const { ctx, canvas, map } = this;
    const dpr = devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#1b3844";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (!map) return;
    const w = canvas.width / dpr,
      h = canvas.height / dpr;
    // World → screen: scale, flip z, translate so (cx, cz) is centred.
    ctx.setTransform(
      dpr * this.scale,
      0,
      0,
      -dpr * this.scale,
      dpr * (w / 2 - this.cx * this.scale),
      dpr * (h / 2 + this.cz * this.scale),
    );
    const on = (id: LayerId) => this.enabled.has(id);
    const half = map.options.size / 2;
    const drawRaster = (key: string, make: () => HTMLCanvasElement) => {
      let img = this.raster.get(key);
      if (!img) this.raster.set(key, (img = make()));
      ctx.imageSmoothingEnabled = this.scale < 1.5;
      // Image row 0 is the cell at z = -half; the view transform already flips z,
      // so drawing without an extra flip keeps the raster aligned with vectors.
      ctx.drawImage(img, -half, -half, map.options.size, map.options.size);
    };
    if (on("terrain")) drawRaster("terrain", () => terrainRaster(map));
    if (on("flow"))
      drawRaster("flow", () => scalarRaster(map.terrain, map.flow, [40, 120, 220]));
    if (on("desirability"))
      drawRaster("desirability", () =>
        scalarRaster(map.terrain, map.desirability, [240, 170, 40]),
      );
    if (on("contours")) {
      if (!this.contourPath) this.contourPath = contours(map.shaped, map.seaLevel, 10);
      ctx.strokeStyle = "rgba(40,30,10,0.28)";
      ctx.lineWidth = 1 / this.scale;
      ctx.stroke(this.contourPath);
    }
    const poly = (points: Point[]) => {
      ctx.beginPath();
      points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.z) : ctx.moveTo(p.x, p.z)));
      ctx.closePath();
    };
    if (on("blocks"))
      for (const b of map.blocks) {
        poly(b.interior);
        ctx.fillStyle = ZONE_FILL[b.zone] ?? "rgba(255,255,255,0.1)";
        ctx.fill();
      }
    if (on("parks"))
      for (const p of map.parks) {
        poly(p.polygon);
        ctx.fillStyle =
          p.kind === "woodland" ? "rgba(60,120,60,0.55)" : "rgba(110,170,80,0.55)";
        ctx.fill();
      }
    if (on("lots")) {
      ctx.strokeStyle = "rgba(255,255,255,0.35)";
      ctx.lineWidth = 0.6 / this.scale;
      for (const b of map.blocks)
        for (const lot of b.lots) {
          poly(lot.polygon);
          ctx.stroke();
        }
    }
    if (on("water")) {
      for (const lake of map.lakes) {
        poly(lake.outline);
        ctx.fillStyle = "#3f7f9a";
        ctx.fill();
      }
      ctx.lineCap = ctx.lineJoin = "round";
      for (const river of map.rivers)
        for (let i = 1; i < river.points.length; i++) {
          ctx.beginPath();
          ctx.moveTo(river.points[i - 1].x, river.points[i - 1].z);
          ctx.lineTo(river.points[i].x, river.points[i].z);
          ctx.strokeStyle = "#3f7f9a";
          ctx.lineWidth = Math.max(river.widths[i], 1.5 / this.scale);
          ctx.stroke();
        }
    }
    if (on("roads")) {
      // Sidewalk pieces, then asphalt (bands and junction rings), then markings:
      // exactly the polygons the 3D view extrudes.
      ctx.fillStyle = "#c9c2ac";
      for (const s of map.geometry.sidewalks) {
        poly(s.polygon);
        ctx.fill();
      }
      for (const band of map.geometry.bands) {
        poly(band.polygon);
        ctx.fillStyle = map.roads.edges[band.edge].bridge ? "#6f6a63" : "#575c5d";
        ctx.fill();
      }
      ctx.fillStyle = "#575c5d";
      for (const j of map.geometry.junctions) {
        poly(j.polygon);
        ctx.fill();
      }
      if (this.scale > 0.8)
        for (const m of map.geometry.markings) {
          poly(m.polygon);
          ctx.fillStyle = m.color === "yellow" ? "#e2c14a" : "#e8e4d6";
          ctx.fill();
        }
      for (const b of map.bridges) {
        poly(b.polygon);
        ctx.strokeStyle = "#8a8378";
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }
    }
    if (on("graph")) {
      ctx.lineWidth = 1 / this.scale;
      for (const e of map.roads.edges) {
        ctx.beginPath();
        e.points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.z) : ctx.moveTo(p.x, p.z)));
        ctx.strokeStyle = {
          highway: "#ff5d5d",
          avenue: "#ffb347",
          street: "#ffffff",
          lane: "#9ad0ff",
        }[e.kind];
        ctx.stroke();
      }
      for (const n of map.roads.nodes) {
        ctx.beginPath();
        ctx.arc(n.x, n.z, 2.2 / this.scale, 0, Math.PI * 2);
        ctx.fillStyle = n.edges.length >= 3 ? "#ff5d5d" : "#ffffff";
        ctx.fill();
      }
    }
    if (on("buildings"))
      for (const b of map.buildings) {
        if (b.footprint) {
          poly(b.footprint);
          ctx.fillStyle = BUILDING_FILL[b.kind] ?? "#ddd";
          ctx.fill();
          ctx.strokeStyle = "rgba(40,30,20,0.6)";
          ctx.lineWidth = Math.min(0.8, 1 / this.scale);
          ctx.stroke();
          continue;
        }
        ctx.save();
        ctx.translate(b.x, b.z);
        ctx.rotate(b.angle);
        ctx.fillStyle = BUILDING_FILL[b.kind] ?? "#ddd";
        ctx.fillRect(-b.w / 2, -b.d / 2, b.w, b.d);
        ctx.strokeStyle = "rgba(40,30,20,0.6)";
        ctx.lineWidth = Math.min(0.8, 1 / this.scale);
        ctx.strokeRect(-b.w / 2, -b.d / 2, b.w, b.d);
        if (this.scale > 2.5 && b.h > 30) {
          ctx.fillStyle = "rgba(0,0,0,0.5)";
          ctx.font = `${3 / Math.max(1, this.scale / 4)}px sans-serif`;
          ctx.scale(1, -1);
          ctx.fillText(`${Math.round(b.h)}m`, -b.w / 2 + 1, 2.5);
        }
        ctx.restore();
      }
    if (on("trees")) {
      for (const t of map.trees) {
        ctx.beginPath();
        ctx.arc(t.x, t.z, Math.max(t.h * 0.3, 1.2 / this.scale), 0, Math.PI * 2);
        ctx.fillStyle =
          t.kind === "pine"
            ? "rgba(35,95,55,0.85)"
            : t.kind === "palm"
              ? "rgba(110,170,70,0.85)"
              : t.kind === "shrub"
                ? "rgba(90,140,60,0.7)"
                : "rgba(55,125,55,0.85)";
        ctx.fill();
      }
    }
    if (on("lamps") && this.scale > 0.8)
      for (const l of map.lamps) {
        ctx.beginPath();
        ctx.arc(l.x, l.z, 0.6, 0, Math.PI * 2);
        ctx.fillStyle = "#ffe9a0";
        ctx.fill();
      }
    // City centre marker.
    ctx.beginPath();
    ctx.arc(map.centre.x, map.centre.z, 6 / this.scale, 0, Math.PI * 2);
    ctx.strokeStyle = "#ff5d5d";
    ctx.lineWidth = 2 / this.scale;
    ctx.stroke();
  }
}

function terrainRaster(map: GeneratedMap) {
  const f = map.shaped,
    img = new ImageData(f.w, f.h),
    d = img.data;
  const sun = [-0.6, 0.5, 0.62];
  for (let z = 0; z < f.h; z++)
    for (let x = 0; x < f.w; x++) {
      const i = z * f.w + x,
        hgt = f.data[i];
      const hx =
        f.data[z * f.w + Math.min(f.w - 1, x + 1)] -
        f.data[z * f.w + Math.max(0, x - 1)];
      const hz =
        f.data[Math.min(f.h - 1, z + 1) * f.w + x] -
        f.data[Math.max(0, z - 1) * f.w + x];
      let nx = -hx / (2 * f.cell),
        nz = -hz / (2 * f.cell),
        ny = 1;
      const len = Math.hypot(nx, ny, nz);
      nx /= len;
      ny /= len;
      nz /= len;
      const shade = Math.max(0, nx * sun[0] + ny * sun[2] + nz * sun[1]) * 0.7 + 0.3;
      let r: number, g: number, b: number;
      if (hgt <= map.seaLevel) {
        const depth = Math.min(1, (map.seaLevel - hgt) / 25);
        r = 36 - depth * 10;
        g = 92 - depth * 30;
        b = 118 - depth * 30;
      } else {
        const t = Math.min(1, (hgt - map.seaLevel) / 200);
        if (hgt - map.seaLevel < 1.6) [r, g, b] = [205, 190, 150];
        else if (t < 0.5) {
          const u = t / 0.5;
          [r, g, b] = [120 + u * 60, 160 - u * 30, 90 - u * 20];
        } else {
          const u = (t - 0.5) / 0.5;
          [r, g, b] = [180 - u * 50, 130 + u * 10, 70 + u * 60];
        }
        r *= shade;
        g *= shade;
        b *= shade;
      }
      d[i * 4] = r;
      d[i * 4 + 1] = g;
      d[i * 4 + 2] = b;
      d[i * 4 + 3] = 255;
    }
  return toCanvas(img);
}
function scalarRaster(f: HeightField, values: Float32Array, tint: number[]) {
  const img = new ImageData(f.w, f.h),
    d = img.data;
  for (let i = 0; i < f.w * f.h; i++) {
    const v = Math.max(0, Math.min(1, values[i]));
    d[i * 4] = tint[0];
    d[i * 4 + 1] = tint[1];
    d[i * 4 + 2] = tint[2];
    d[i * 4 + 3] = v * 230;
  }
  return toCanvas(img);
}
function toCanvas(img: ImageData) {
  const c = document.createElement("canvas");
  c.width = img.width;
  c.height = img.height;
  c.getContext("2d")!.putImageData(img, 0, 0);
  return c;
}
/** Marching squares, one Path2D for all levels; z is flipped by the view transform. */
function contours(f: HeightField, seaLevel: number, step: number) {
  const path = new Path2D(),
    half = f.size / 2;
  let max = -Infinity;
  for (const h of f.data) if (h > max) max = h;
  const wx = (x: number) => x * f.cell - half,
    wz = (z: number) => z * f.cell - half;
  for (let level = seaLevel + step; level < max; level += step)
    for (let z = 0; z < f.h - 1; z++)
      for (let x = 0; x < f.w - 1; x++) {
        const a = f.data[z * f.w + x],
          b = f.data[z * f.w + x + 1],
          c = f.data[(z + 1) * f.w + x + 1],
          d = f.data[(z + 1) * f.w + x];
        const code =
          (a > level ? 8 : 0) |
          (b > level ? 4 : 0) |
          (c > level ? 2 : 0) |
          (d > level ? 1 : 0);
        if (code === 0 || code === 15) continue;
        const t = (p: number, q: number) => (level - p) / (q - p);
        const top = { x: wx(x + t(a, b)), z: wz(z) },
          right = { x: wx(x + 1), z: wz(z + t(b, c)) },
          bottom = { x: wx(x + t(d, c)), z: wz(z + 1) },
          left = { x: wx(x), z: wz(z + t(a, d)) };
        const seg = (p: Point, q: Point) => {
          path.moveTo(p.x, p.z);
          path.lineTo(q.x, q.z);
        };
        switch (code) {
          case 1:
          case 14:
            seg(left, bottom);
            break;
          case 2:
          case 13:
            seg(bottom, right);
            break;
          case 3:
          case 12:
            seg(left, right);
            break;
          case 4:
          case 11:
            seg(top, right);
            break;
          case 5:
            seg(left, top);
            seg(bottom, right);
            break;
          case 6:
          case 9:
            seg(top, bottom);
            break;
          case 7:
          case 8:
            seg(left, top);
            break;
          case 10:
            seg(top, right);
            seg(left, bottom);
            break;
        }
      }
  return path;
}
