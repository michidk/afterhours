import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Entity } from "../shared/world.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import {
  characterSchema,
  DEFAULT_CHARACTER,
  randomCharacter,
} from "../shared/character.ts";
import { messageSchema, VERSION } from "../shared/protocol.ts";
import { Simulation } from "../server/simulation.ts";
import { loadCity } from "../server/city-loader.ts";
import { idle } from "../shared/world.ts";
import { predictStep } from "../shared/physics/movement.ts";
import { buildCharacter, poseCharacter } from "../client/models/character.ts";

test("join validates character choices and never accepts client stats", () => {
  const join = {
    type: "join",
    version: VERSION,
    name: "Resident",
    color: "#e8b63f",
    character: DEFAULT_CHARACTER,
  };
  assert.ok(messageSchema.safeParse(join).success);
  for (const invalid of [
    { physique: "god" },
    { skin: "red" },
    { hair: "unknown" },
    { top: "unknown" },
    { legs: "unknown" },
  ])
    assert.equal(
      messageSchema.safeParse({
        ...join,
        character: { ...DEFAULT_CHARACTER, ...invalid },
      }).success,
      false,
    );
  const parsed = messageSchema.parse({
    ...join,
    character: { ...DEFAULT_CHARACTER, health: 999, speed: 99 },
  });
  assert.equal(parsed.type, "join");
  if (parsed.type === "join") assert.deepEqual(parsed.character, DEFAULT_CHARACTER);
  for (let i = 0; i < 100; i++)
    assert.ok(characterSchema.safeParse(randomCharacter()).success);
});

test("builds have distinct authoritative speed and health, predict identically and retain stats after recovery", async () => {
  const city = await loadCity();
  city.buildings = [];
  city.props = [];
  city.ramps = [];
  for (const [physique, health, speed] of [
    ["runner", 80, 9.6],
    ["regular", 100, 8],
    ["tank", 150, 6.4],
  ] as const) {
    const sim = new Simulation(city);
    sim.entities.clear();
    const character = { ...DEFAULT_CHARACTER, physique };
    const player = sim.join("Resident", "#e8b63f", character);
    player.x = player.z = 0;
    assert.equal(player.health, health);
    assert.equal(player.maxHealth, health);
    const predicted = structuredClone(player);
    const input = { ...idle(), right: true, sprint: true };
    sim.inputs.set(player.id, input);
    for (let i = 0; i < 60; i++) {
      sim.tick(1 / 30);
      predictStep(predicted, input, city, [], 1 / 30);
      assert.ok(Math.abs(player.x - predicted.x) < 1e-8);
    }
    assert.ok(Math.abs(player.vx - speed) < 1e-8, `${physique}: ${player.vx}`);
    sim.damage(player, 999);
    const corpse = sim.destruction
      .snapshot(player, 100)
      .find((body) => body.source.kind === "corpse");
    assert.ok(corpse);
    if (corpse.source.kind === "corpse")
      assert.deepEqual(corpse.source.character, character);
    sim.inputs.set(player.id, idle());
    for (let i = 0; i < 100; i++) sim.tick(1 / 30);
    assert.equal(player.health, health);
    assert.deepEqual(player.character, character);
    player.health = 1;
    sim.repair(player);
    assert.equal(player.health, health);
  }
});

test("all body parts render using the same model as the menu, with distinct physiques", () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const material = new StandardMaterial("test", scene);
  try {
    for (const physique of characterSchema.shape.physique.options) {
      for (const hair of characterSchema.shape.hair.options)
        for (const top of characterSchema.shape.top.options)
          for (const legs of characterSchema.shape.legs.options) {
            const root = new TransformNode("character", scene);
            buildCharacter(root, "#e8b63f", () => material, {
              ...DEFAULT_CHARACTER,
              physique,
              hair,
              top,
              legs,
            });
            const meshes = root.getChildMeshes();
            assert.equal(meshes.filter((m) => m.name === "leg").length, 2);
            assert.equal(meshes.filter((m) => m.name === "shoe").length, 2);
            assert.equal(
              meshes.filter((m) => m.name === "cap brim").length,
              hair === "cap" ? 1 : 0,
            );
            assert.equal(
              meshes.filter((m) => m.name === "shorts").length,
              legs === "shorts" ? 2 : 0,
            );
            const body = meshes.find((m) => m.name === "body")!;
            const width = body.getBoundingInfo().boundingBox.extendSize.x * 2;
            assert.ok(
              Math.abs(
                width - { runner: 0.5084, regular: 0.62, tank: 0.7936 }[physique],
              ) < 1e-6,
            );
            root.dispose();
          }
    }
    assert.equal(scene.meshes.length, 0);
  } finally {
    scene.dispose();
    engine.dispose();
  }
});

test("walking yaw and mouse aim stay independent in authority and prediction", async () => {
  const city = await loadCity();
  city.buildings = [];
  city.props = [];
  city.ramps = [];
  const sim = new Simulation(city);
  sim.entities.clear();
  const player = sim.join("Strafe", "#fff");
  player.x = player.z = 0;
  const predicted = structuredClone(player);
  try {
    for (const aim of [Math.PI / 2, Math.PI, undefined]) {
      const input = { ...idle(), up: true, aim };
      sim.inputs.set(player.id, input);
      for (let tick = 0; tick < 30; tick++) {
        sim.tick(1 / 30);
        predictStep(predicted, input, city, [], 1 / 30);
        assert.equal(player.aim, aim);
        assert.equal(predicted.aim, aim);
        assert.ok(Math.abs(player.angle) < 1e-8);
        assert.ok(Math.abs(predicted.angle) < 1e-8);
        assert.ok(Math.abs(player.z - predicted.z) < 1e-8);
        assert.ok(Math.abs(player.x) < 1e-8);
      }
    }
    assert.ok(player.z > 12);
  } finally {
    sim.destruction.dispose();
  }
});

test("upper body and raised arms face aim while legs keep walking direction", () => {
  const engine = new NullEngine(),
    scene = new Scene(engine);
  const root = new TransformNode("character", scene);
  const mat = new StandardMaterial("test", scene);
  const upper = buildCharacter(root, "#fff", () => mat);
  const entity: Entity = {
    id: "p",
    kind: "player",
    x: 0,
    y: 0,
    z: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    angle: -Math.PI / 2,
    aim: Math.PI / 2,
    health: 100,
    color: "#fff",
  };
  try {
    root.rotation.y = entity.angle;
    poseCharacter(root, entity);
    const yaw = (node: TransformNode) => {
      node.computeWorldMatrix(true);
      const forward = node.getDirection(Vector3.Forward());
      return Math.atan2(forward.x, forward.z);
    };
    assert.ok(Math.abs(yaw(upper) - Math.PI / 2) < 1e-6);
    for (const leg of root.getChildMeshes().filter((m) => m.name === "leg"))
      assert.ok(Math.abs(yaw(leg) + Math.PI / 2) < 1e-6);
    for (const hand of root.getChildMeshes().filter((m) => m.name === "hand")) {
      hand.computeWorldMatrix(true);
      assert.ok(Math.abs(hand.absolutePosition.y - 1.38) < 1e-6);
      assert.ok(hand.absolutePosition.x > 0.5);
    }
    poseCharacter(root, { ...entity, aim: undefined });
    assert.equal(upper.rotation.y, 0);
    for (const arm of upper
      .getChildTransformNodes(true)
      .filter((n) => n.name === "arm pivot"))
      assert.equal(arm.rotation.x, 0);
  } finally {
    scene.dispose();
    engine.dispose();
  }
});
