import { TERRAIN_SIDE, TERRAIN_STEP } from "../../shared/terrain.ts";
import {
  cityAtlasSchema,
  type CityAtlas,
  type ClientMap,
} from "../../shared/city-stream.ts";
import { district, type Entity } from "../../shared/world.ts";
import { swatch, type MapPlayer } from "./map-players.ts";

/** North-up coordinates shared by drawing, zoom anchoring and pointer panning. */
export class MapViewport {
  x = 0;
  z = 0;
  scale = 1;
  fit = 1;
  width = 1;
  height = 1;
  resize(width: number, height: number, limit: number) {
    const ratio = this.scale / this.fit;
    this.width = width;
    this.height = height;
    this.fit = Math.min(width, height) / (limit * 2 + 180);
    this.scale = this.fit * ratio;
  }
  screen(x: number, z: number) {
    return {
      x: this.width / 2 + (x - this.x) * this.scale,
      y: this.height / 2 - (z - this.z) * this.scale,
    };
  }
  world(x: number, y: number) {
    return {
      x: this.x + (x - this.width / 2) / this.scale,
      z: this.z - (y - this.height / 2) / this.scale,
    };
  }
  pan(dx: number, dy: number) {
    this.x -= dx / this.scale;
    this.z += dy / this.scale;
  }
  zoom(factor: number, x = this.width / 2, y = this.height / 2) {
    const before = this.world(x, y);
    this.scale = Math.max(this.fit / 2, Math.min(this.fit * 24, this.scale * factor));
    const after = this.world(x, y);
    this.x += before.x - after.x;
    this.z += before.z - after.z;
  }
}

export class CityMap {
  readonly view = new MapViewport();
  private atlas?: CityAtlas;
  private request?: Promise<void>;
  private player?: Entity;
  private entities: Entity[] = [];
  private players: MapPlayer[] = [];
  private listKey = "";
  private list: HTMLElement;
  private drag?: { id: number; x: number; y: number };
  private returnFocus?: HTMLElement;
  private observer: ResizeObserver;
  private context: CanvasRenderingContext2D;
  constructor(
    private root: HTMLElement,
    private canvas: HTMLCanvasElement,
    private status: HTMLElement,
    private manifest: ClientMap,
    private onToggle: (open: boolean) => void,
    private download: typeof fetch = (...args) => fetch(...args),
  ) {
    this.context = canvas.getContext("2d")!;
    this.list = root.querySelector<HTMLElement>("#map-players")!;
    this.list.addEventListener("click", (event) => {
      const id = (event.target as HTMLElement).closest<HTMLElement>("[data-map-player]")
        ?.dataset.mapPlayer;
      const target = this.players.find((p) => p.id === id);
      if (!target) return;
      this.view.x = target.x;
      this.view.z = target.z;
      this.draw();
    });
    root.querySelector<HTMLButtonElement>("[data-map-close]")!.onclick = () =>
      this.setOpen(false);
    root.querySelector<HTMLButtonElement>("[data-map-center]")!.onclick = () => {
      if (this.player) {
        this.view.x = this.player.x;
        this.view.z = this.player.z;
      }
      this.draw();
    };
    root.querySelector<HTMLButtonElement>("[data-map-island]")!.onclick = () => {
      this.view.x = 0;
      this.view.z = 0;
      this.view.scale = this.view.fit;
      this.draw();
    };
    for (const button of root.querySelectorAll<HTMLButtonElement>("[data-map-zoom]"))
      button.onclick = () => {
        this.view.zoom(Number(button.dataset.mapZoom));
        this.draw();
      };
    canvas.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        const rect = canvas.getBoundingClientRect();
        this.view.zoom(
          Math.exp(-event.deltaY * 0.0015),
          event.clientX - rect.left,
          event.clientY - rect.top,
        );
        this.draw();
      },
      { passive: false },
    );
    canvas.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      this.drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
      canvas.setPointerCapture(event.pointerId);
    });
    canvas.addEventListener("pointermove", (event) => {
      if (this.drag?.id !== event.pointerId) return;
      this.view.pan(event.clientX - this.drag.x, event.clientY - this.drag.y);
      this.drag.x = event.clientX;
      this.drag.y = event.clientY;
      this.draw();
    });
    canvas.addEventListener("lostpointercapture", () => {
      this.drag = undefined;
    });
    canvas.addEventListener("pointerup", (event) => {
      if (canvas.hasPointerCapture(event.pointerId))
        canvas.releasePointerCapture(event.pointerId);
    });
    root.addEventListener("keydown", (event) => {
      if (event.code !== "Tab") return;
      const items = [...root.querySelectorAll<HTMLElement>("button,canvas")];
      const first = items[0],
        last = items.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });
    this.observer = new ResizeObserver(() => {
      if (this.open) this.resize();
    });
    this.observer.observe(canvas);
  }
  get open() {
    return !this.root.classList.contains("hidden");
  }
  setOpen(open: boolean) {
    if (open === this.open) return;
    this.root.classList.toggle("hidden", !open);
    this.drag = undefined;
    this.onToggle(open);
    if (open) {
      this.returnFocus = document.activeElement as HTMLElement;
      this.resize();
      this.canvas.focus();
      void this.load();
    } else this.returnFocus?.focus();
  }
  async load() {
    if (this.atlas || this.request) return this.request;
    this.status.textContent = "Loading island map…";
    this.request = (async () => {
      try {
        const response = await this.download(`/city/atlas/${this.manifest.mapId}`, {
          cache: "no-store",
        });
        if (!response.ok) throw Error("Map download failed");
        const atlas = cityAtlasSchema.parse(await response.json());
        if (atlas.mapId !== this.manifest.mapId) throw Error("Map identity changed");
        this.atlas = atlas;
        this.status.textContent = "Drag to pan · Scroll to zoom · M / Escape to close";
        this.draw();
      } catch {
        this.status.textContent = "Map unavailable. Close and reopen to retry.";
      } finally {
        this.request = undefined;
      }
    })();
    return this.request;
  }
  update(player: Entity, entities: Entity[], players: MapPlayer[] = []) {
    this.player = player;
    this.entities = entities;
    this.players = players;
    this.renderList();
    if (this.open) this.draw();
  }
  /** The side list changes with membership, not with movement. */
  private renderList() {
    const key = this.players.map((p) => `${p.id}|${p.name}|${p.color}`).join("\n");
    if (key === this.listKey) return;
    this.listKey = key;
    this.list.replaceChildren(
      ...this.players.map((p) => {
        const item = document.createElement("li"),
          button = document.createElement("button"),
          dot = document.createElement("i");
        button.dataset.mapPlayer = p.id;
        button.title = p.self ? "Centre on yourself" : `Centre on ${p.name}`;
        dot.style.background = swatch(p.color);
        button.append(dot, p.name);
        if (p.self) {
          const you = document.createElement("small");
          you.textContent = "you";
          button.append(you);
        }
        item.append(button);
        return item;
      }),
    );
  }
  private resize() {
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dpr = Math.min(2, devicePixelRatio || 1);
    this.canvas.width = Math.round(rect.width * dpr);
    this.canvas.height = Math.round(rect.height * dpr);
    this.context.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.view.resize(rect.width, rect.height, this.manifest.limit);
    this.draw();
  }
  private terrainCanvas?: HTMLCanvasElement;
  /** Terrain cells rasterised once; the view transform scales the image. */
  private terrainImage() {
    if (this.terrainCanvas) return this.terrainCanvas;
    const side = TERRAIN_SIDE - 1,
      canvas = document.createElement("canvas");
    canvas.width = canvas.height = side;
    const context = canvas.getContext("2d")!,
      image = context.createImageData(side, side),
      heights = this.manifest.terrain!.heights;
    for (let z = 0; z < side; z++)
      for (let x = 0; x < side; x++) {
        const h = heights[z * TERRAIN_SIDE + x],
          i = (z * side + x) * 4;
        let r: number, g: number, b: number;
        if (h < -1.1) {
          // Shallows fade into the deep colour behind the island.
          const t = Math.min(1, (-1.1 - h) / 9);
          [r, g, b] = [0.24 - 0.17 * t, 0.5 - 0.33 * t, 0.56 - 0.35 * t];
        } else {
          // Light from the north-west: slopes facing it brighten, the others darken.
          const at = (cx: number, cz: number) =>
            heights[
              Math.min(side, Math.max(0, cz)) * TERRAIN_SIDE +
                Math.min(side, Math.max(0, cx))
            ];
          const gx = (at(x + 1, z) - at(x - 1, z)) / (2 * TERRAIN_STEP),
            gz = (at(x, z + 1) - at(x, z - 1)) / (2 * TERRAIN_STEP),
            relief = (0.5 * gx - 0.5 * gz) / Math.hypot(gx, gz, 1);
          const shade = Math.max(0.55, Math.min(1.6, 1 + relief * 1.6));
          // hsl(105, 18%, light) without formatting a string per cell.
          const light = Math.max(0, Math.min(1, ((32 + h / 6) / 100) * shade)),
            chroma = (1 - Math.abs(2 * light - 1)) * 0.18,
            m = light - chroma / 2;
          [r, g, b] =
            h < -0.1
              ? [0.655 * shade, 0.596 * shade, 0.439 * shade]
              : [m + chroma * 0.25, m + chroma, m];
        }
        image.data[i] = Math.min(255, r * 255);
        image.data[i + 1] = Math.min(255, g * 255);
        image.data[i + 2] = Math.min(255, b * 255);
        image.data[i + 3] = 255;
      }
    context.putImageData(image, 0, 0);
    this.terrainCanvas = canvas;
    return canvas;
  }
  private draw() {
    const c = this.context,
      v = this.view,
      limit = this.manifest.limit;
    c.fillStyle = "#102c36";
    c.fillRect(0, 0, v.width, v.height);
    c.save();
    c.translate(v.width / 2 - v.x * v.scale, v.height / 2 + v.z * v.scale);
    c.scale(v.scale, -v.scale);
    c.fillStyle = "#425752";
    if (this.manifest.terrain) {
      // The 8 m grid has ~150k cells; rasterise it once and blit it per frame.
      c.imageSmoothingEnabled = true;
      c.imageSmoothingQuality = "high";
      c.drawImage(this.terrainImage(), -limit, -limit, limit * 2, limit * 2);
    } else c.fillRect(-limit, -limit, limit * 2, limit * 2);
    c.strokeStyle = "#ebd5ac55";
    c.lineWidth = 2 / v.scale;
    c.strokeRect(-limit - 256, -limit - 256, (limit + 256) * 2, (limit + 256) * 2);
    for (const park of this.atlas?.parks ?? []) {
      c.fillStyle = park.kind === "civic" ? "#797c67" : "#547958";
      c.fillRect(
        park.x - (park.w ?? 38) / 2,
        park.z - (park.d ?? 38) / 2,
        park.w ?? 38,
        park.d ?? 38,
      );
    }
    // Lakes and rivers sit on the terrain, under the streets that cross them.
    c.fillStyle = c.strokeStyle = "#3d8493";
    c.lineCap = c.lineJoin = "round";
    for (const lake of this.manifest.water?.lakes ?? []) {
      c.beginPath();
      lake.outline.forEach((n, i) => {
        if (i % 2 === 0) (i ? c.lineTo : c.moveTo).call(c, n, lake.outline[i + 1]);
      });
      c.closePath();
      c.fill();
    }
    for (const river of this.manifest.water?.rivers ?? [])
      for (let i = 4; i < river.points.length; i += 4) {
        c.lineWidth = Math.max(river.points[i + 3], 1.5 / v.scale);
        c.beginPath();
        c.moveTo(river.points[i - 4], river.points[i - 3]);
        c.lineTo(river.points[i], river.points[i + 1]);
        c.stroke();
      }
    // Streets get a dark outline, drawn first so junctions merge, and stay visible
    // when the whole island is in view.
    const roads = this.atlas?.roads ?? [];
    for (const [width, colour] of [
      [3, "#2c3b38"],
      [0, undefined],
    ] as const)
      for (const road of roads) {
        c.strokeStyle = colour ?? (road.width >= 12 ? "#f0e6c4" : "#c8ccb9");
        c.lineWidth = Math.max(road.width, 1.8 / v.scale) + width;
        c.lineCap = "round";
        c.beginPath();
        c.moveTo(road.ax, road.az);
        c.lineTo(road.bx, road.bz);
        c.stroke();
      }
    const airport = this.manifest.airport;
    c.fillStyle = "#263e41";
    c.fillRect(
      airport.x - airport.w / 2,
      airport.z - airport.d / 2,
      airport.w,
      airport.d,
    );
    c.strokeStyle = "#d9c49d";
    c.lineWidth = 2 / v.scale;
    c.setLineDash([6 / v.scale, 4 / v.scale]);
    c.beginPath();
    c.moveTo(airport.x, airport.z - airport.d / 2 + 10);
    c.lineTo(airport.x, airport.z + airport.d / 2 - 10);
    c.stroke();
    c.setLineDash([]);
    c.restore();
    // Labels and markers keep their screen size when zooming.
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.font = "600 10px 'DM Sans', sans-serif";
    const labels: { x: number; y: number; w: number }[] = [];
    const label = (text: string, x: number, y: number, color: string) => {
      const w = c.measureText(text).width / 2 + 4;
      if (
        x - w < 0 ||
        x + w > v.width ||
        y < 8 ||
        y > v.height - 8 ||
        labels.some((p) => Math.abs(p.x - x) < p.w + w && Math.abs(p.y - y) < 15)
      )
        return;
      labels.push({ x, y, w });
      c.lineWidth = 4;
      c.strokeStyle = "#233d38";
      c.fillStyle = color;
      c.strokeText(text, x, y);
      c.fillText(text, x, y);
    };
    for (const [x, z] of [
      [-200, 0],
      [25, 25],
      [220, 70],
      [0, 250],
      [-600, 0],
      [350, -480],
      [480, -100],
      [640, -640],
      [420, 340],
      [0, 560],
    ]) {
      const p = v.screen(x, z);
      label(district(x, z), p.x, p.y, "#edf1d5");
    }
    for (const landmark of this.atlas?.landmarks ?? []) {
      const p = v.screen(landmark.x, landmark.z);
      c.fillStyle = "#f4be65";
      c.fillRect(p.x - 3, p.y - 3, 6, 6);
      if (v.scale > v.fit * 1.5) {
        label(landmark.name, p.x, p.y + 14, "#f4be65");
      }
    }
    for (const ramp of this.atlas?.ramps ?? []) {
      const p = v.screen(ramp.x, ramp.z);
      c.fillStyle = "#ee8767";
      c.beginPath();
      c.moveTo(p.x, p.y - 4);
      c.lineTo(p.x - 4, p.y + 3);
      c.lineTo(p.x + 4, p.y + 3);
      c.fill();
    }
    // Name tags nudge down rather than cover each other; the player's own claims its spot first.
    const tags: { x: number; y: number; w: number }[] = [];
    const place = (text: string, x: number, y: number) => {
      c.font = "600 11px 'DM Sans', sans-serif";
      const w = c.measureText(text).width + 14;
      let ty = y;
      for (
        let k = 0;
        k < 8 &&
        tags.some((t) => Math.abs(t.x - x) < (t.w + w) / 2 && Math.abs(t.y - ty) < 18);
        k++
      )
        ty += 19;
      tags.push({ x, y: ty, w });
      return { text, x, y: ty, w };
    };
    const paint = (
      tag: { text: string; x: number; y: number; w: number },
      you: boolean,
    ) => {
      c.font = "600 11px 'DM Sans', sans-serif";
      c.fillStyle = you ? "#f0bc6d" : "#102127e0";
      c.beginPath();
      c.roundRect(tag.x - tag.w / 2, tag.y - 9, tag.w, 18, 9);
      c.fill();
      c.fillStyle = you ? "#1b2a2c" : "#fff6de";
      c.fillText(tag.text, tag.x, tag.y + 0.5);
    };
    const me = this.players.find((q) => q.self);
    const here = this.player && v.screen(this.player.x, this.player.z);
    const mine = here && place(me ? `${me.name} · you` : "You", here.x, here.y + 22);
    for (const other of this.players) {
      if (other.self) continue;
      const p = v.screen(other.x, other.z);
      if (p.x < -40 || p.x > v.width + 40 || p.y < -40 || p.y > v.height + 40) continue;
      c.fillStyle = swatch(other.color);
      c.strokeStyle = "#fff6d8";
      c.lineWidth = 2.5;
      c.beginPath();
      c.arc(p.x, p.y, 6, 0, Math.PI * 2);
      c.stroke();
      c.fill();
      paint(place(other.name, p.x, p.y + 17), false);
    }
    if (this.player && here && mine) {
      c.save();
      c.translate(here.x, here.y);
      c.rotate(this.player.angle);
      c.fillStyle = "#fff6d8";
      c.strokeStyle = "#132d32";
      c.lineWidth = 2;
      c.beginPath();
      c.moveTo(0, -10);
      c.lineTo(-7, 7);
      c.lineTo(0, 4);
      c.lineTo(7, 7);
      c.closePath();
      c.fill();
      c.stroke();
      c.restore();
      paint(mine, true);
    }
    c.fillStyle = "#f2d49b";
    c.font = "bold 14px sans-serif";
    c.fillText("N ↑", v.width - 32, 28);
    c.textAlign = "left";
    c.font = "11px sans-serif";
    const metres = v.scale > 1 ? 50 : 200,
      length = metres * v.scale;
    c.fillRect(24, v.height - 27, length, 2);
    c.fillText(`${metres} m`, 24, v.height - 38);
  }
}
