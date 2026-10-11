import {
  cityAtlasSchema,
  type CityAtlas,
  type MapManifest,
} from "../../shared/city-stream.ts";
import { district, type Entity } from "../../shared/world.ts";

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
  private drag?: { id: number; x: number; y: number };
  private returnFocus?: HTMLElement;
  private observer: ResizeObserver;
  private context: CanvasRenderingContext2D;
  constructor(
    private root: HTMLElement,
    private canvas: HTMLCanvasElement,
    private status: HTMLElement,
    private manifest: MapManifest,
    private onToggle: (open: boolean) => void,
    private download: typeof fetch = (...args) => fetch(...args),
  ) {
    this.context = canvas.getContext("2d")!;
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
  update(player: Entity, entities: Entity[]) {
    this.player = player;
    this.entities = entities;
    if (this.open) this.draw();
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
    c.fillRect(-limit, -limit, limit * 2, limit * 2);
    c.strokeStyle = "#ebd5ac55";
    c.lineWidth = 2 / v.scale;
    c.strokeRect(-limit, -limit, limit * 2, limit * 2);
    for (const park of this.atlas?.parks ?? []) {
      c.fillStyle = park.kind === "civic" ? "#797c67" : "#547958";
      c.fillRect(
        park.x - (park.w ?? 38) / 2,
        park.z - (park.d ?? 38) / 2,
        park.w ?? 38,
        park.d ?? 38,
      );
    }
    for (const road of this.atlas?.roads ?? []) {
      c.strokeStyle = "#adb4a0";
      c.lineWidth = road.width;
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
    for (const e of this.entities) {
      if (e.kind !== "player" || e.id === this.player?.id) continue;
      const p = v.screen(e.x, e.z);
      c.fillStyle = "#7dcada";
      c.beginPath();
      c.arc(p.x, p.y, 4, 0, Math.PI * 2);
      c.fill();
    }
    if (this.player) {
      const p = v.screen(this.player.x, this.player.z);
      c.save();
      c.translate(p.x, p.y);
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
