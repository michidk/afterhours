import { buildCharacter } from "../models/character.ts";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { ParticleSystem } from "@babylonjs/core/Particles/particleSystem";
import { createParticles } from "../effects/particles.ts";
import type { Destructible, DebrisState } from "../../shared/destruction.ts";
import { TUNING } from "../../shared/catalog.ts";
import type { CityScene } from "../scene.ts";

type Model = {
  root: TransformNode;
  meshes: Mesh[];
  lamp?: Vector3;
  light?: { mesh: Mesh; axis: "x" | "z" };
  lit: boolean;
};
type Frame = { time: number; states: Map<string, DebrisState> };
export class DestructionRenderer {
  private staticNodes = new Map<string, Model>();
  private debrisNodes = new Map<string, Model>();
  private broken = new Set<string>();
  private frames: Frame[] = [];
  private received = 0;
  private water = new Map<string, ParticleSystem[]>();
  constructor(private host: CityScene) {}
  syncStatic(fixtures: Destructible[]) {
    const wanted = new Set(fixtures.map((p) => p.id));
    for (const [id, model] of this.staticNodes)
      if (!wanted.has(id)) {
        this.disposeModel(model);
        this.staticNodes.delete(id);
        this.stopWater(id);
      }
    for (const p of fixtures)
      if (!this.staticNodes.has(p.id)) this.staticNodes.set(p.id, this.make(p, true));
    this.refresh();
  }
  setBroken(ids: string[]) {
    this.broken = new Set(ids);
    this.refresh();
  }
  receive(states: DebrisState[], time: number, now = performance.now()) {
    this.frames.push({ time, states: new Map(states.map((s) => [s.id, s])) });
    if (this.frames.length > 8) this.frames.shift();
    this.received = now;
  }
  update(now = performance.now()) {
    const latest = this.frames.at(-1);
    if (!latest) return;
    const time = latest.time + Math.max(0, now - this.received) / 1000,
      renderTime = time - 0.08;
    let previous = this.frames[0],
      next = latest;
    for (let i = 1; i < this.frames.length; i++)
      if (this.frames[i].time >= renderTime) {
        previous = this.frames[i - 1];
        next = this.frames[i];
        break;
      }
    for (const [id, model] of this.debrisNodes)
      if (!latest.states.has(id)) {
        this.disposeModel(model);
        this.debrisNodes.delete(id);
      }
    for (const [id, state] of latest.states) {
      let model = this.debrisNodes.get(id);
      if (!model) {
        model = this.make(state.source, false);
        this.debrisNodes.set(id, model);
      }
      const a = previous.states.get(id) ?? state,
        b = next.states.get(id) ?? state,
        t =
          next.time > previous.time
            ? Math.max(
                0,
                Math.min(1, (renderTime - previous.time) / (next.time - previous.time)),
              )
            : 1,
        extrapolate = Math.max(0, Math.min(0.08, renderTime - latest.time));
      model.root.position.set(
        a.position.x +
          (b.position.x - a.position.x) * t +
          state.velocity.x * extrapolate,
        a.position.y +
          (b.position.y - a.position.y) * t +
          state.velocity.y * extrapolate,
        a.position.z +
          (b.position.z - a.position.z) * t +
          state.velocity.z * extrapolate,
      );
      model.root.rotationQuaternion = Quaternion.Slerp(
        new Quaternion(a.rotation.x, a.rotation.y, a.rotation.z, a.rotation.w),
        new Quaternion(b.rotation.x, b.rotation.y, b.rotation.z, b.rotation.w),
        t,
      );
      const fade = Math.max(
        0,
        Math.min(1, (state.expiresAt - time) / TUNING.debrisFadeSeconds),
      );
      for (const mesh of model.meshes) mesh.visibility = fade;
      model.root.setEnabled(
        fade > 0 &&
          Math.hypot(
            model.root.position.x - this.host.target.x,
            model.root.position.z - this.host.target.z,
          ) < 160,
      );
    }
  }
  private refresh() {
    for (const [id, model] of this.staticNodes) {
      const broken = this.broken.has(id);
      model.root.setEnabled(!broken);
      this.light(model, !broken);
      if (broken && id.startsWith("hydrant:")) this.startWater(id, model.root.position);
      else this.stopWater(id);
    }
  }
  private light(model: Model, enabled: boolean) {
    if (enabled === model.lit) return;
    model.lit = enabled;
    if (model.lamp) {
      if (enabled) this.host.lighting.lamps.push(model.lamp);
      else
        this.host.lighting.lamps = this.host.lighting.lamps.filter(
          (p) => p !== model.lamp,
        );
    }
    if (model.light) {
      if (enabled) this.host.lights.push(model.light);
      else this.host.lights = this.host.lights.filter((p) => p !== model.light);
    }
  }
  private make(p: DebrisState["source"], live: boolean): Model {
    const h = this.host,
      root = new TransformNode(`${live ? "fixture" : "debris"}:${p.id}`, h.scene),
      meshStart = h.scene.meshes.length;
    let bulb: Mesh | undefined;
    if (p.kind === "palm") h.palm(0, 0, p.h);
    else if (p.kind === "tree") {
      h.cylinder("tree trunk", 0, p.h * 0.3, 0, p.h * 0.6, 0.5, "#80705a");
      h.box(
        "tree crown",
        0,
        p.h * 0.72,
        0,
        5.5,
        p.h * 0.4,
        5.5,
        "#617f55",
        undefined,
        true,
      );
      h.box(
        "tree crown top",
        0.5,
        p.h * 0.9,
        0,
        3.5,
        p.h * 0.2,
        3.8,
        "#80935f",
        undefined,
        true,
      );
    } else if (p.kind === "bench") {
      h.box("bench seat", 0, 0.7, 0, 1.1, 0.2, 2.8, "#97785a", undefined, true);
      h.box("bench back", 0.5, 1.05, 0, 0.15, 0.7, 2.8, "#97785a");
      for (const z of [-0.9, 0.9])
        h.box("bench leg", 0, 0.4, z, 0.75, 0.6, 0.15, "#46534e");
    } else if (p.kind === "hydrant") {
      h.cylinder("hydrant body", 0, 0.5, 0, 0.8, 0.46, "#b94932");
      h.cylinder("hydrant cap", 0, 0.94, 0, 0.18, 0.58, "#e0aa4d");
      h.box("hydrant outlets", 0, 0.6, 0, 0.9, 0.25, 0.3, "#b94932");
    } else if (p.kind === "lamp") {
      h.cylinder("lamp pole", 0, p.h / 2, 0, p.h, 0.16, "#46534e");
      h.box("lamp arm", 0.6, p.h, 0, 1.5, 0.15, 0.15, "#46534e");
      bulb = h.box(
        "lamp",
        1.3,
        p.h - 0.1,
        0,
        0.65,
        0.2,
        0.45,
        live ? "#ffe5a1" : "#3c4744",
      );
      if (live) bulb.material = h.streetGlow;
    } else if (p.kind === "signal") {
      h.cylinder("signal pole", 0, 2.1, 0, 4.2, 0.18, "#364747");
      h.box("signal housing", 0, 4, 0, 0.65, 1.5, 0.6, "#263739");
      bulb = h.box(
        "signal",
        0,
        4.2,
        -0.32,
        0.34,
        0.34,
        0.05,
        live ? "#88ca9e" : "#263739",
      );
    } else if (p.kind === "corpse") {
      const body = new TransformNode("corpse model", h.scene);
      buildCharacter(body, p.color, (color) => h.mat(color), p.character);
      for (const mesh of body.getChildMeshes()) mesh.setParent(null);
      body.dispose();
    }
    const created = h.scene.meshes.slice(meshStart) as Mesh[],
      groups = new Map<number, Mesh[]>();
    for (const mesh of created) {
      h.shadows.removeShadowCaster(mesh);
      if (mesh === bulb) continue;
      const key = mesh.material!.uniqueId,
        group = groups.get(key) ?? [];
      group.push(mesh);
      groups.set(key, group);
    }
    const meshes: Mesh[] = bulb ? [bulb] : [];
    for (const group of groups.values()) {
      const merged =
        group.length === 1 ? group[0] : Mesh.MergeMeshes(group, true, true)!;
      if (merged) meshes.push(merged);
    }
    for (const mesh of meshes) {
      mesh.receiveShadows = true;
      mesh.position.y -= p.h / 2;
      mesh.parent = root;
      h.shadows.addShadowCaster(mesh);
    }
    h.shadowCandidates.push(...meshes);
    root.position.set(p.x, h.groundAt(p.x, p.z) + p.h / 2, p.z);
    if (p.kind !== "corpse") root.rotation.y = p.angle ?? 0;
    const model: Model = { root, meshes, lit: false };
    if (live && p.kind === "lamp") {
      bulb!.computeWorldMatrix(true);
      model.lamp = bulb!.getAbsolutePosition().clone();
      // The fixture owns its pool so breaking, restoring and unloading also affect light.
      const pool = h.lighting.createLampPool();
      pool.parent = root;
      pool.position.set(1.3, 0.27 - p.h / 2, 0);
      meshes.push(pool);
    }
    if (live && p.kind === "signal") model.light = { mesh: bulb!, axis: p.axis ?? "z" };
    if (live) for (const mesh of meshes) h.culling.add(mesh);
    return model;
  }
  private startWater(id: string, position: Vector3) {
    if (this.water.has(id) || this.water.size >= 16) return;
    const origin = new Vector3(position.x, 0.25, position.z);
    const water = createParticles(this.host.scene, "spray", 180, origin);
    water.emitRate = 140;
    const mist = createParticles(this.host.scene, "mist", 48, origin.clone());
    mist.emitRate = 16;
    mist.direction1.set(-0.7, 1, -0.7);
    mist.direction2.set(0.7, 2, 0.7);
    water.start();
    mist.start();
    this.water.set(id, [water, mist]);
  }

  private stopWater(id: string) {
    const water = this.water.get(id);
    if (water) {
      for (const system of water) system.dispose(false, false);
      this.water.delete(id);
    }
  }
  private disposeModel(model: Model) {
    this.light(model, false);
    const meshes = new Set(model.meshes);
    for (const mesh of meshes) this.host.shadows.removeShadowCaster(mesh);
    this.host.shadowCandidates = this.host.shadowCandidates.filter(
      (m) => !meshes.has(m),
    );
    model.root.dispose();
  }
  get diagnostics() {
    return {
      fixtures: this.staticNodes.size,
      debris: this.debrisNodes.size,
      fountains: this.water.size,
    };
  }
  dispose() {
    for (const model of [...this.staticNodes.values(), ...this.debrisNodes.values()])
      this.disposeModel(model);
    for (const id of this.water.keys()) this.stopWater(id);
    this.staticNodes.clear();
    this.debrisNodes.clear();
    this.frames = [];
  }
}
