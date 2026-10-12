import { test } from "node:test";
import assert from "node:assert/strict";
import {
  vehicleAudioState,
  vehicleLayers,
  spatialPan,
  dopplerRate,
} from "../client/audio/vehicles.ts";
import { demoFrame } from "../client/audio/demo.ts";
import { GameAudio } from "../client/audio/index.ts";
import { idle, type Entity } from "../shared/world.ts";

const frame = () => demoFrame("sport", "drive", 4);
test("throttle and coast change the mix at the same road speed without mutating the vehicle", () => {
  const { entity } = frame();
  const saved = structuredClone(entity);
  let state = vehicleAudioState(entity, undefined, 1 / 30, { ...idle(), up: true });
  for (let i = 0; i < 60; i++)
    state = vehicleAudioState(entity, state, 1 / 30, { ...idle(), up: true });
  const loaded = vehicleLayers(entity, state, true);
  for (let i = 0; i < 60; i++) state = vehicleAudioState(entity, state, 1 / 30, idle());
  const coast = vehicleLayers(entity, state, true);
  assert.ok(
    coast.find((l) => l.key === "coast")!.gain >
      loaded.find((l) => l.key === "coast")!.gain,
  );
  assert.ok(state.load < 0.001);
  assert.deepEqual(entity, saved);
  for (const kind of ["boat", "jetski"] as const) {
    const layers = vehicleLayers({ ...entity, kind }, state, true);
    assert.ok(
      layers.some((l) => l.sound === (kind === "boat" ? "boatMotor" : "jetskiMotor")),
    );
    assert.ok(layers.some((l) => l.sound === "wake"));
  }
});

test("estimated shifts drop revs and do not hunt around a gear boundary", () => {
  const { entity } = frame();
  entity.vz = 12;
  let state = vehicleAudioState(entity, undefined, 1 / 30, { ...idle(), up: true });
  entity.vz = 14;
  // Begin in first gear to exercise the upshift threshold, not initialization.
  state = { ...state, gear: 0, rpm: 0.9 };
  const shifted = vehicleAudioState(entity, state, 1 / 30, { ...idle(), up: true });
  assert.equal(shifted.gear, 1);
  assert.ok(shifted.rpm < state.rpm);
  state = shifted;
  for (let i = 0; i < 60; i++) {
    entity.vz = i % 2 ? 11.7 : 12.3;
    state = vehicleAudioState(entity, state, 1 / 30);
    assert.equal(state.gear, 1);
  }
  assert.equal(state.shift, 0);
});

test("camera panning rotates and passing motors have bounded Doppler", () => {
  const { entity, listener } = frame();
  listener.vehicle = undefined;
  entity.x = -25;
  entity.vx = 20;
  assert.ok(spatialPan(entity, listener) < 0);
  assert.ok(spatialPan(entity, listener, { rightX: -1, rightZ: 0 }) > 0);
  assert.ok(dopplerRate(entity, listener) > 1);
  entity.x = 25;
  assert.ok(dopplerRate(entity, listener) < 1);
  listener.vehicle = entity.id;
  assert.equal(dopplerRate(entity, listener), 1);
});

function fakeAudio() {
  const audio = new GameAudio();
  const starts: string[] = [],
    stops: string[] = [];
  const parameter = { setTargetAtTime() {} };
  Object.assign(audio, {
    context: { currentTime: 10, state: "running" },
    voice: (sound: string) => ({
      sound,
      rate: 1,
      variation: 1,
      cutoff: 16000,
      filter: { frequency: parameter },
      gain: { gain: parameter },
      pan: { pan: parameter },
      source: {
        buffer: { duration: 4 },
        playbackRate: parameter,
        start() {
          starts.push(sound);
        },
        stop() {
          stops.push(sound);
        },
      },
    }),
  });
  return { audio, starts, stops };
}

test("full vehicle mix retains sources, respects mute, clears on view loss, and stays bounded in traffic", () => {
  const { audio, starts, stops } = fakeAudio();
  const { entity, listener } = demoFrame("sport", "drift", 8);
  const entities: Entity[] = Array.from({ length: 40 }, (_, i) => ({
    ...entity,
    id: i ? `car-${i}` : entity.id,
    x: i * 2,
  }));
  audio.update(entities, listener, 1 / 30);
  assert.ok(audio.diagnostics.loopSounds.includes("tyreSqueal"));
  assert.ok(audio.diagnostics.loopSounds.includes("skid"));
  assert.equal(audio.diagnostics.vehicles.length, 6);
  assert.ok(audio.diagnostics.loops <= 24);
  const initialStarts = starts.length;
  audio.update(entities, listener, 1 / 30);
  assert.equal(starts.length, initialStarts);
  audio.toggle();
  audio.update(entities, listener, 1 / 30);
  assert.equal(audio.diagnostics.loops, 0);
  assert.equal(stops.length, initialStarts);
  audio.toggle();
  audio.update(entities, listener, 1 / 30);
  assert.ok(audio.diagnostics.loops > 0);
  audio.update([], undefined, 1 / 30);
  assert.equal(audio.diagnostics.loops, 0);
  assert.equal(audio.diagnostics.vehicles.length, 0);
});

test("ignition cues use confirmed transitions and do not replay on initial visibility or reset", () => {
  const { audio, starts } = fakeAudio();
  const { entity, listener } = frame();
  audio.snapshot([entity], listener);
  assert.deepEqual(starts, []);
  entity.driver = undefined;
  audio.snapshot([entity], listener);
  assert.deepEqual(starts, ["engineStop"]);
  audio.snapshot([entity], listener);
  assert.equal(starts.length, 1);
  entity.driver = listener.id;
  audio.snapshot([entity], listener);
  assert.deepEqual(starts, ["engineStop", "engineStart"]);
  audio.reset();
  audio.snapshot([entity], listener);
  assert.equal(starts.length, 2);
});
