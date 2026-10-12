import { test } from "node:test";
import assert from "node:assert/strict";
import { prepareFirstFrame } from "../client/startup.ts";

function fixture() {
  let callback: (() => void) | undefined;
  let stops = 0;
  const engine = {
    runRenderLoop(render: () => void) {
      callback = render;
    },
    stopRenderLoop(render: () => void) {
      assert.equal(render, callback);
      stops++;
    },
  };
  let ready = false;
  let pending = 0;
  const scene = {
    render() {},
    getWaitingItemsCount() {
      return pending;
    },
    getActiveMeshes() {
      return {
        data: [
          {
            isReady() {
              return ready;
            },
          },
        ],
        length: 1,
      };
    },
  };
  return {
    engine,
    scene,
    tick() {
      callback!();
    },
    ready() {
      ready = true;
    },
    pending(value: number) {
      pending = value;
    },
    stops: () => stops,
  };
}

test("startup waits for visible shaders and pending resources, then a fully drawn frame", async () => {
  const f = fixture();
  const promise = prepareFirstFrame(f.engine, f.scene, () => {});
  f.tick();
  assert.equal(f.stops(), 0);
  f.ready();
  f.pending(1);
  f.tick();
  f.tick();
  assert.equal(f.stops(), 0);
  f.pending(0);
  f.tick();
  assert.equal(f.stops(), 0);
  f.tick();
  await promise;
  assert.equal(f.stops(), 1);
});

test("startup does not wait for offscreen scene readiness", async () => {
  const f = fixture();
  const scene = {
    ...f.scene,
    isReady() {
      throw Error("Whole neighbourhood must not be checked");
    },
  };
  const promise = prepareFirstFrame(f.engine, scene, () => {});
  f.ready();
  f.tick();
  f.tick();
  await promise;
  assert.equal(f.stops(), 1);
});

test("render errors reject startup immediately and remove its render callback", async () => {
  const f = fixture();
  f.scene.render = () => {
    throw Error("WebGL context lost");
  };
  const promise = prepareFirstFrame(f.engine, f.scene, () => {});
  f.tick();
  await assert.rejects(promise, /WebGL context lost/);
  assert.equal(f.stops(), 1);
});

test("stalled compilation times out with progress and stops the startup renderer", async () => {
  const f = fixture();
  const promise = prepareFirstFrame(f.engine, f.scene, () => {}, 5);
  f.tick();
  await assert.rejects(promise, /0\/1 visible objects ready/);
  assert.equal(f.stops(), 1);
});
