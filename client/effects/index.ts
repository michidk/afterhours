import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import type { Scene } from "@babylonjs/core/scene";
import type { WorldEvent, City } from "../../shared/world.ts";
import { SkidTrails } from "./skid-trails.ts";
export class Effects {
  effects: { mesh: Mesh; life: number; maxLife: number; rise: number }[] = [];
  trails: SkidTrails;
  get skidMarks() {
    return this.trails.marks;
  }

  constructor(
    private scene: Scene,
    private mat: (color: string, glow?: boolean) => StandardMaterial,
    city?: City,
  ) {
    this.trails = new SkidTrails(scene, city);
  }
  update(dt: number, focus?: { x: number; z: number }) {
    this.trails.update(dt, focus);
    for (let i = this.effects.length - 1; i >= 0; i--) {
      const fx = this.effects[i];
      fx.life -= dt;
      fx.mesh.position.y += dt * fx.rise;
      fx.mesh.scaling.scaleInPlace(1 + dt * (fx.rise > 2 ? 1.8 : 0.5));
      fx.mesh.visibility = Math.max(0, Math.min(1, fx.life / fx.maxLife));
      if (fx.life <= 0) {
        fx.mesh.dispose();
        this.effects.splice(i, 1);
      }
    }
  }
  effect(e: WorldEvent) {
    if (e.kind === "flame") {
      for (let i = 1; i <= 6; i++)
        this.effect({
          kind: "fire",
          x: e.x + (Math.sin(e.angle || 0) * i * (e.length || 9)) / 6,
          y: e.y,
          z: e.z + (Math.cos(e.angle || 0) * i * (e.length || 9)) / 6,
        });
      return;
    }
    if (e.kind === "swing") return;
    if (e.kind === "skid") {
      this.trails.add(e);
      return;
    }
    if (e.kind === "shot" && e.length && this.effects.length < 180) {
      const tracer = MeshBuilder.CreateBox(
        "tracer",
        { width: 0.035, height: 0.035, depth: e.length },
        this.scene,
      );
      tracer.position.set(
        e.x + (Math.sin(e.angle || 0) * e.length) / 2,
        e.y,
        e.z + (Math.cos(e.angle || 0) * e.length) / 2,
      );
      tracer.rotation.y = e.angle || 0;
      tracer.material = this.mat("#ffe3a0", true);
      this.effects.push({ mesh: tracer, life: 0.07, maxLife: 0.07, rise: 0 });
    }
    if (e.kind === "explosion") {
      for (let i = 0; i < 16; i++)
        this.effect({
          kind: i < 9 ? "fireball" : "blackSmoke",
          x: e.x + (Math.random() - 0.5) * 4,
          y: e.y + Math.random() * 2,
          z: e.z + (Math.random() - 0.5) * 4,
        });
      return;
    }
    if (this.effects.length >= 180) return;
    const smoke = e.kind === "smoke" || e.kind === "blackSmoke",
      fire = e.kind === "fire" || e.kind === "fireball";
    const m = MeshBuilder.CreateSphere(
      "particle",
      {
        diameter: e.kind === "fireball" ? 2.4 : smoke ? 1.2 : fire ? 0.85 : 0.35,
        segments: 4,
      },
      this.scene,
    );
    m.position.set(e.x, e.y + 0.5, e.z);
    m.material = this.mat(
      smoke
        ? e.kind === "blackSmoke"
          ? "#343634"
          : "#c3c4b3"
        : fire
          ? Math.random() > 0.5
            ? "#ff6a16"
            : "#ffd052"
          : "#ffce72",
      !smoke,
    );
    const life = smoke ? 2.5 : fire ? 0.7 : 0.25;
    this.effects.push({
      mesh: m,
      life,
      maxLife: life,
      rise: smoke ? 3 : fire ? 4 : 1,
    });
  }
}
