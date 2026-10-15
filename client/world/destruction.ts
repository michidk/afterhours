import { buildCharacter } from "../models/character.ts";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { ParticleSystem } from "@babylonjs/core/Particles/particleSystem";
import { createParticles } from "../effects/particles.ts";
import {
  DEBRIS_LIFT,
  debrisRotation,
  debrisSpin,
  type Destructible,
  type DebrisState,
  type PredictedImpacts,
} from "../../shared/destruction.ts";
import { TUNING } from "../../shared/catalog.ts";
import type { CityScene } from "../scene.ts";
import { uploadMeshes } from "./mesh-buffers.ts";
import {
  advanceDebris,
  clonePose,
  correctionRate,
  type DebrisPose,
  type Extents,
} from "./debris-motion.ts";

type Model = {
  root: TransformNode;
  meshes: Mesh[];
  lamp?: Vector3;
  light?: { mesh: Mesh; axis: "x" | "z" };
  lit: boolean;
};
type Frame = { serial: number; time: number; states: Map<string, DebrisState> };
/**
 * Server times on screen: remote bodies are interpolated in the past, while the
 * predicted car runs ahead of the newest snapshot.
 */
export type DebrisClock = { remote: number; local: number };
type Shown = {
  model: Model;
  source: DebrisState["source"];
  /** Struck by this client's predicted car, so drawn in the car's time frame. */
  local: boolean;
  /** Cosmetic launch, flown until the server's debris arrives. */
  launch?: DebrisPose;
  launchedAt: number;
  /** Last target pose and the server frame it came from (-1 for the launch). */
  target?: DebrisPose;
  frame?: number;
  /** Visual error kept after a correction; it decays instead of snapping. */
  offset: Vector3;
  turn: Quaternion;
};
/** A predicted strike the server has not confirmed by then is withdrawn. */
const CONFIRM_MS = 700;
/** Corrections larger than this snap rather than slide. */
const SNAP_DISTANCE = 10;
const extents = (source: DebrisState["source"]): Extents => ({
  w: source.w,
  h: source.h,
  d: source.d,
});
const quaternion = (q: DebrisPose["rotation"]) => new Quaternion(q.x, q.y, q.z, q.w);
export class DestructionRenderer {
  private staticNodes = new Map<string, Model>();
  private fixtures = new Map<string, Destructible>();
  private debris = new Map<string, Shown>();
  private broken = new Set<string>();
  private hidden = new Set<string>();
  private frames: Frame[] = [];
  private serial = 0;
  private received = 0;
  private impacts: PredictedImpacts = new Map();
  private clock: DebrisClock | undefined;
  private remoteTime = -Infinity;
  private updated = 0;
  private water = new Map<string, ParticleSystem[]>();
  constructor(private host: CityScene) {}
  syncStatic(fixtures: Destructible[]) {
    const wanted = new Set(fixtures.map((p) => p.id));
    for (const [id, model] of this.staticNodes)
      if (!wanted.has(id)) {
        this.disposeModel(model);
        this.staticNodes.delete(id);
        this.fixtures.delete(id);
        this.hidden.delete(id);
        this.stopWater(id);
      }
    for (const p of fixtures) {
      this.fixtures.set(p.id, p);
      if (!this.staticNodes.has(p.id)) this.staticNodes.set(p.id, this.make(p, true));
    }
    this.refresh(this.staticNodes.keys(), true);
  }
  setBroken(ids: string[]) {
    this.broken = new Set(ids);
    this.refresh(this.staticNodes.keys(), true);
  }
  receive(states: DebrisState[], time: number, now = performance.now()) {
    this.frames.push({
      serial: ++this.serial,
      time,
      states: new Map(states.map((s) => [s.id, s])),
    });
    if (this.frames.length > 8) this.frames.shift();
    this.received = now;
  }
  /** Fixtures this client's car is predicted to break, and the clocks to draw them at. */
  setPredictedImpacts(impacts: PredictedImpacts, clock?: DebrisClock) {
    this.impacts = impacts;
    this.clock = clock;
  }
  update(now = performance.now()) {
    const dt = Math.max(0, Math.min(0.1, (now - this.updated) / 1000));
    this.updated = now;
    const latest = this.frames.at(-1),
      elapsed = Math.max(0, now - this.received) / 1000;
    // Without network clocks (tests, tools) debris plays 80 ms behind its newest sample.
    const remote = this.clock?.remote ?? (latest ? latest.time + elapsed - 0.08 : 0),
      local = this.clock?.local ?? remote;
    this.remoteTime = remote;
    const ground = (x: number, z: number) => this.host.groundAt(x, z);
    // Throw a fixture the moment this client's prediction breaks it, from the same
    // launch the server uses, instead of waiting a round trip for its debris.
    for (const [id, velocity] of this.impacts) {
      const shown = this.debris.get(id);
      if (shown) {
        shown.local = true;
        continue;
      }
      const p = this.fixtures.get(id);
      if (!p) continue;
      this.debris.set(id, {
        model: this.make(p, false),
        source: p,
        local: true,
        launch: {
          position: { x: p.x, y: ground(p.x, p.z) + p.h / 2 + DEBRIS_LIFT, z: p.z },
          rotation: debrisRotation(p.angle ?? 0),
          velocity: { ...velocity },
          angularVelocity: debrisSpin(velocity),
        },
        launchedAt: now,
        offset: Vector3.Zero(),
        turn: Quaternion.Identity(),
      });
    }
    if (latest)
      for (const [id, state] of latest.states)
        if (!this.debris.has(id))
          this.debris.set(id, {
            model: this.make(state.source, false),
            source: state.source,
            local: false,
            launchedAt: now,
            offset: Vector3.Zero(),
            turn: Quaternion.Identity(),
          });
    for (const [id, shown] of this.debris) {
      const state = latest?.states.get(id);
      const withdrawn =
        !state &&
        (!shown.launch ||
          (!this.impacts.has(id) &&
            now - shown.launchedAt > (this.broken.has(id) ? 2000 : CONFIRM_MS)));
      if (withdrawn) {
        // Expired debris, or a predicted strike the server did not make.
        this.disposeModel(shown.model);
        this.debris.delete(id);
        continue;
      }
      const shape = extents(shown.source);
      let target: DebrisPose, frame: number;
      if (state) {
        target = this.sample(id, shown.local ? local : remote, shape, ground);
        frame = latest!.serial;
        shown.launch = undefined;
      } else {
        advanceDebris(shown.launch!, dt, ground, shape);
        target = clonePose(shown.launch!);
        frame = -1;
      }
      if (shown.target && shown.frame !== frame) {
        // A new sample, or the server taking over from the launch, moved the target.
        // Keep the drawn pose where it would have been and let the difference decay.
        const expected = advanceDebris(clonePose(shown.target), dt, ground, shape);
        shown.offset.x += expected.position.x - target.position.x;
        shown.offset.y += expected.position.y - target.position.y;
        shown.offset.z += expected.position.z - target.position.z;
        shown.turn = shown.turn.multiply(
          quaternion(expected.rotation).multiply(
            Quaternion.Inverse(quaternion(target.rotation)),
          ),
        );
        if (shown.offset.length() > SNAP_DISTANCE) {
          shown.offset.setAll(0);
          shown.turn = Quaternion.Identity();
        }
      }
      shown.target = target;
      shown.frame = frame;
      shown.offset.scaleInPlace(Math.exp(-correctionRate(shown.offset.length()) * dt));
      shown.turn = Quaternion.Slerp(
        shown.turn,
        Quaternion.Identity(),
        1 - Math.exp(-6 * dt),
      );
      const model = shown.model;
      model.root.position.set(
        target.position.x + shown.offset.x,
        target.position.y + shown.offset.y,
        target.position.z + shown.offset.z,
      );
      model.root.rotationQuaternion = shown.turn.multiply(quaternion(target.rotation));
      const fade = state
        ? Math.max(
            0,
            Math.min(
              1,
              (state.expiresAt - (latest!.time + elapsed)) / TUNING.debrisFadeSeconds,
            ),
          )
        : 1;
      for (const mesh of model.meshes) mesh.visibility = fade;
      // Another driver's strike appears when its moment is on screen, not on arrival.
      const started = shown.local || !state || remote >= state.brokenAt;
      model.root.setEnabled(
        started &&
          fade > 0 &&
          Math.hypot(
            model.root.position.x - this.host.target.x,
            model.root.position.z - this.host.target.z,
          ) < 160,
      );
    }
    this.refresh(new Set([...this.broken, ...this.debris.keys(), ...this.hidden]));
  }
  /** Server debris at a display time: interpolated within the samples, flown beyond them. */
  private sample(
    id: string,
    time: number,
    shape: Extents,
    ground: (x: number, z: number) => number,
  ): DebrisPose {
    let a: DebrisState | undefined,
      b: DebrisState | undefined,
      at = 0,
      bt = 0;
    for (const frame of this.frames) {
      const state = frame.states.get(id);
      if (!state) continue;
      if (frame.time <= time || !a) {
        a = state;
        at = frame.time;
      }
      if (frame.time >= time) {
        b = state;
        bt = frame.time;
        break;
      }
    }
    // Beyond the newest sample (the predicted car's time frame): fly it forward.
    if (!b || bt <= at)
      return advanceDebris(
        clonePose(a!),
        Math.min(0.5, Math.max(0, time - at)),
        ground,
        shape,
      );
    const t = Math.max(0, Math.min(1, (time - at) / (bt - at))),
      mix = (p: number, q: number) => p + (q - p) * t,
      rotation = Quaternion.Slerp(quaternion(a!.rotation), quaternion(b.rotation), t);
    return {
      position: {
        x: mix(a!.position.x, b.position.x),
        y: mix(a!.position.y, b.position.y),
        z: mix(a!.position.z, b.position.z),
      },
      rotation: { x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w },
      velocity: {
        x: mix(a!.velocity.x, b.velocity.x),
        y: mix(a!.velocity.y, b.velocity.y),
        z: mix(a!.velocity.z, b.velocity.z),
      },
      angularVelocity: { ...b.angularVelocity },
    };
  }
  /** A fixture stands until its strike is on screen: predicted, or reached by the clock. */
  private isHidden(id: string) {
    const shown = this.debris.get(id);
    if (shown?.launch) return true;
    if (!this.broken.has(id)) return false;
    const state = this.frames.at(-1)?.states.get(id);
    return !state || !shown || shown.local || this.remoteTime >= state.brokenAt;
  }
  private refresh(ids: Iterable<string>, force = false) {
    for (const id of ids) {
      const model = this.staticNodes.get(id);
      if (!model) {
        this.hidden.delete(id);
        continue;
      }
      const hide = this.isHidden(id);
      if (!force && hide === this.hidden.has(id)) continue;
      if (hide) this.hidden.add(id);
      else this.hidden.delete(id);
      model.root.setEnabled(!hide);
      this.light(model, !hide);
      if (hide && this.broken.has(id) && id.startsWith("hydrant:"))
        this.startWater(id, model.root.position);
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
    // Lowest ground under the trunk, so a fixture on a slope never floats or sinks.
    const base = Math.min(
      ...[0, 1, 2, 3, 4].map((i) =>
        h.groundAt(
          p.x + (i ? Math.sin((i * Math.PI) / 2) * 0.4 : 0),
          p.z + (i ? Math.cos((i * Math.PI) / 2) * 0.4 : 0),
        ),
      ),
    );
    const saved = live && p.kind !== "corpse" ? h.staticFixtures?.get(p.id) : undefined;
    if (live && h.savedGeometry && !saved)
      throw Error(`Saved fixture mesh missing: ${p.id}`);
    if (saved) {
      const meshes = uploadMeshes(h, saved);
      for (const mesh of meshes) mesh.parent = root;
      root.position.set(p.x, base + p.h / 2, p.z);
      root.rotation.y = p.kind !== "corpse" ? (p.angle ?? 0) : 0;
      const model: Model = { root, meshes, lit: false };
      const bulb = meshes.find(
        (mesh) => mesh.name === (p.kind === "lamp" ? "lamp" : "signal"),
      );
      if (p.kind === "lamp" && bulb) {
        bulb.computeWorldMatrix(true);
        model.lamp = bulb.getAbsolutePosition().clone();
      }
      if (p.kind === "signal" && bulb)
        model.light = { mesh: bulb, axis: p.axis ?? "z" };
      for (const mesh of meshes) h.culling?.add(mesh);
      return model;
    }
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
    } else if (p.kind === "crate") {
      h.box("crate", 0, 0.45, 0, 0.9, 0.9, 0.9, "#a0703f", undefined, true);
      for (const y of [0.18, 0.72])
        h.box("crate band", 0, y, 0, 0.94, 0.1, 0.94, "#5b3d22");
      h.box("crate mark", 0, 0.45, 0, 0.3, 0.3, 0.95, "#d8b04a");
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
    root.position.set(p.x, base + p.h / 2, p.z);
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
    const origin = new Vector3(
      position.x,
      this.host.groundAt(position.x, position.z) + 0.25,
      position.z,
    );
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
      debris: this.debris.size,
      fountains: this.water.size,
    };
  }
  dispose() {
    for (const model of [
      ...this.staticNodes.values(),
      ...[...this.debris.values()].map((shown) => shown.model),
    ])
      this.disposeModel(model);
    for (const id of this.water.keys()) this.stopWater(id);
    this.staticNodes.clear();
    this.debris.clear();
    this.fixtures.clear();
    this.hidden.clear();
    this.frames = [];
  }
}
