import { test } from "node:test";
import assert from "node:assert/strict";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Nameplates } from "../client/ui/nameplates.ts";
import { CityScene } from "../client/scene.ts";
import type { Entity } from "../shared/world.ts";

class Element {
  children: Element[] = [];
  parent?: Element;
  textContent = "";
  className = "";
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  setAttribute() {}
  append(child: Element) {
    child.parent = this;
    this.children.push(child);
  }
  replaceChildren() {
    this.children = [];
  }
  remove() {
    if (this.parent)
      this.parent.children = this.parent.children.filter((c) => c !== this);
  }
}

test("overhead names follow connected players and passengers, and disappear on leave/view loss", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  const body = new Element();
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { body, createElement: () => new Element() },
  });
  const engine = new NullEngine({
    renderWidth: 800,
    renderHeight: 600,
    textureSize: 512,
    deterministicLockstep: false,
    lockstepMaxSteps: 4,
  });
  const scene = new Scene(engine),
    camera = new FreeCamera("camera", new Vector3(0, 12, -20), scene);
  camera.setTarget(Vector3.Zero());
  scene.activeCamera = camera;
  scene.updateTransformMatrix(true);
  const host: CityScene = Object.create(CityScene.prototype);
  Object.assign(host, { engine, scene, camera, target: Vector3.Zero() });
  const player: Entity = {
    id: "p",
    kind: "player",
    x: 0,
    y: 0,
    z: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    angle: 0,
    color: "#ffffff",
    health: 100,
  };
  const vehicle: Entity = { ...player, id: "v", kind: "car" };
  try {
    const names = new Nameplates();
    names.roster([{ id: "p", name: "<unsafe>", color: "#ffffff" }]);
    names.update(host, [player]);
    assert.equal(body.children[0].children[0].textContent, "<unsafe>");
    names.update(host, [{ ...player, vehicle: "v", seat: 1 }, vehicle]);
    assert.equal(
      body.children[0].children.length,
      1,
      "hidden seated actor retains its name",
    );
    assert.equal(body.children[0].children[0].style.marginTop, "-19px");
    names.update(host, [{ ...player, x: 200 }]);
    assert.equal(body.children[0].children.length, 0);
    names.update(host, [player]);
    assert.equal(body.children[0].children.length, 1);
    names.roster([]);
    names.update(host, [player]);
    assert.equal(
      body.children[0].children.length,
      0,
      "detached characters do not retain labels",
    );
    names.roster([{ id: "p", name: "Returned", color: "#ffffff" }]);
    names.update(host, [player]);
    assert.equal(body.children[0].children[0].textContent, "Returned");
    names.clear();
    assert.equal(body.children[0].children.length, 0);
    names.update(host, [player]);
    assert.equal(body.children[0].children.length, 0);
    names.roster([{ id: "p", name: "Returned", color: "#ffffff" }]);
    names.update(host, [player], player.id);
    assert.equal(body.children[0].children.length, 0, "no duplicate local name");
  } finally {
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else Reflect.deleteProperty(globalThis, "document");
    scene.dispose();
    engine.dispose();
  }
});
