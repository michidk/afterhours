import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { ParticleSystem } from "@babylonjs/core/Particles/particleSystem";
import type { Scene } from "@babylonjs/core/scene";
import type { WorldEvent, City } from "../../shared/world.ts";
import { createParticles, particleTexture, type ParticleStyle } from "./particles.ts";
import { SkidTrails } from "./skid-trails.ts";

type Effect = { life: number; maxLife: number } & (
  | { kind: "particles"; system: ParticleSystem }
  | { kind: "mesh"; mesh: Mesh; growth: number }
);
const MAX_EFFECTS = 96;

export class Effects {
  effects: Effect[] = [];
  trails: SkidTrails;
  private wakeMaterial: StandardMaterial;
  get skidMarks() {
    return this.trails.marks;
  }

  constructor(
    private scene: Scene,
    private mat: (color: string, glow?: boolean) => StandardMaterial,
    city?: City,
  ) {
    this.trails = new SkidTrails(scene, city);
    this.wakeMaterial = new StandardMaterial("wake foam", scene);
    this.wakeMaterial.diffuseTexture = particleTexture(scene, "ring");
    this.wakeMaterial.useAlphaFromDiffuseTexture = true;
    this.wakeMaterial.diffuseColor = Color3.FromHexString("#c8e3df");
    this.wakeMaterial.emissiveColor.set(0.15, 0.2, 0.2);
    this.wakeMaterial.specularColor.setAll(0);
    this.wakeMaterial.backFaceCulling = false;
  }
  update(dt: number, focus?: { x: number; z: number }) {
    this.trails.update(dt, focus);
    for (let i = this.effects.length - 1; i >= 0; i--) {
      const fx = this.effects[i];
      fx.life -= dt;
      if (fx.kind === "mesh") {
        fx.mesh.scaling.x += dt * fx.growth;
        fx.mesh.scaling.z += dt * fx.growth;
        fx.mesh.visibility = Math.max(0, fx.life / fx.maxLife);
      }
      if (fx.life <= 0) {
        if (fx.kind === "mesh") fx.mesh.dispose();
        else fx.system.dispose(false, false);
        this.effects.splice(i, 1);
      }
    }
  }
  private burst(style: ParticleStyle, e: WorldEvent, count: number) {
    if (this.effects.length >= MAX_EFFECTS) return;
    const system = createParticles(
      this.scene,
      style,
      count,
      new Vector3(e.x, e.y, e.z),
    );
    system.manualEmitCount = count;
    system.start();
    const life = system.maxLifeTime + 0.15;
    this.effects.push({ kind: "particles", system, life, maxLife: life });
    return system;
  }
  private mesh(mesh: Mesh, life: number, growth = 0) {
    mesh.isPickable = false;
    this.effects.push({ kind: "mesh", mesh, life, maxLife: life, growth });
  }
  effect(e: WorldEvent) {
    if (e.kind === "horn") return;
    if (e.kind === "skid") {
      this.trails.add(e);
      return;
    }
    if (this.effects.length >= MAX_EFFECTS) return;
    switch (e.kind) {
      case "wake": {
        const ring = MeshBuilder.CreateGround(
          "water wake",
          { width: 1.8, height: 1.8 },
          this.scene,
        );
        ring.position.set(e.x, e.y + 0.14, e.z);
        ring.rotation.y = e.angle ?? 0;
        ring.material = this.wakeMaterial;
        this.mesh(ring, 1.4, 2.4);
        const spray = this.burst("spray", e, 5);
        if (spray) {
          spray.direction1.set(-1, 0.8, -1);
          spray.direction2.set(1, 1.8, 1);
        }
        break;
      }
      case "flame": {
        const flame = this.burst("fire", e, 24);
        if (flame) {
          const angle = e.angle ?? 0,
            speed = (e.length ?? 9) / flame.maxLifeTime;
          // Stagger travel ages so a network pulse forms a plume, not a ball.
          flame.startPositionFunction = (_world, position, particle) => {
            particle.age = Math.random() * particle.lifeTime * 0.85;
            const travel = speed * particle.age;
            position.set(
              e.x + Math.sin(angle) * travel + (Math.random() - 0.5) * 0.25,
              e.y + Math.random() * 0.25,
              e.z + Math.cos(angle) * travel + (Math.random() - 0.5) * 0.25,
            );
          };
          flame.direction1.set(
            Math.sin(angle) * speed - 0.5,
            0.1,
            Math.cos(angle) * speed - 0.5,
          );
          flame.direction2.set(
            Math.sin(angle) * speed + 0.5,
            0.5,
            Math.cos(angle) * speed + 0.5,
          );
        }
        this.burst("flash", e, 1);
        break;
      }
      case "shot": {
        if (e.length && e.length > 0) {
          const tracer = MeshBuilder.CreateBox(
            "tracer",
            { width: 0.025, height: 0.025, depth: e.length },
            this.scene,
          );
          const angle = e.angle ?? 0;
          tracer.position.set(
            e.x + (Math.sin(angle) * e.length) / 2,
            e.y,
            e.z + (Math.cos(angle) * e.length) / 2,
          );
          tracer.rotation.y = angle;
          tracer.material = this.mat("#ffe3a0", true);
          this.mesh(tracer, 0.055);
        }
        this.burst("flash", e, 2);
        this.burst("smoke", e, 2);
        break;
      }
      case "explosion": {
        const flash = this.burst("flash", e, 2);
        if (flash) {
          flash.minScaleX = flash.maxScaleX = 6;
          flash.minScaleY = flash.maxScaleY = 6;
        }
        const fire = this.burst("fire", e, 48);
        if (fire) {
          fire.direction1.set(-5, -1, -5);
          fire.direction2.set(5, 6, 5);
          fire.addVelocityGradient(0, 1).addVelocityGradient(1, 0.1);
          fire.minScaleX = fire.minScaleY = 1.5;
          fire.maxScaleX = fire.maxScaleY = 2.5;
        }
        this.burst("spark", e, 40);
        const smoke = this.burst("soot", e, 18);
        if (smoke) {
          smoke.minEmitBox.set(-1, -0.5, -1);
          smoke.maxEmitBox.set(1, 1, 1);
          smoke.direction1.set(-1.8, 1, -1.8);
          smoke.direction2.set(1.8, 3, 1.8);
        }
        break;
      }
      case "fire":
      case "fireball":
        this.burst("fire", e, e.kind === "fireball" ? 18 : 8);
        break;
      case "smoke":
      case "blackSmoke":
        this.burst(e.kind === "blackSmoke" ? "soot" : "smoke", e, 4);
        break;
      case "hit":
        this.burst("spark", e, 10);
        this.burst("smoke", e, 3);
        break;
      // Audio-only events must not spawn glowing particles.
      case "swing":
      case "dryFire":
      case "throw":
        break;
    }
  }
}
