import { mountCharacterMenu } from "./ui/character-menu.ts";
import { TUNING, VEHICLES, WEAPONS, isVehicleModel } from "../shared/catalog.ts";
import { availableSeat, occupiedSeats, seatCapacity } from "../shared/seats.ts";
import type { Pickup, PlayerPosition, PlayerSummary } from "../shared/protocol.ts";
import "./style.css";
import {
  mountDebugWindows,
  renderAdminPlaces,
  renderAdminPlayers,
  updateServerStats,
} from "./ui/debug-windows.ts";
import { adminPlaces } from "./debug/admin.ts";
import { inspectAtPointer } from "./ui/debug-inspector.ts";
import { mountUI } from "./ui/index.ts";
import { loadoutHTML } from "./ui/loadout.ts";
import { mapPlayers, swatch } from "./ui/map-players.ts";
import { CityMap } from "./ui/city-map.ts";
import { updateNetworkStats } from "./ui/network-stats.ts";
import { PlayerList } from "./ui/player-list.ts";
import { Nameplates } from "./ui/nameplates.ts";
import { GameNetwork } from "./network/index.ts";
import { Controls } from "./input/index.ts";
import { InputClock } from "./input/clock.ts";
import { GameAudio } from "./audio/index.ts";
import { prepareFirstFrame } from "./startup.ts";
import { meshGroupSchema } from "../shared/city-mesh.ts";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { CityScene } from "./scene";
import { FrameProfiler, profileNetwork } from "./performance/index.ts";
import { AgentInterface } from "./debug/index.ts";
import { CityStream, SCENERY_RADIUS } from "./world/stream.ts";
import { CityRenderer } from "./world/render.ts";
import {
  cityWaterSchema,
  mapManifestSchema,
  type ClientMap,
} from "../shared/city-stream.ts";
import { unpackHeights } from "../shared/city-pack.ts";
import { TERRAIN_SIDE } from "../shared/terrain.ts";
import type { CameraMode } from "./camera/debug.ts";
import { district, idle, LIMIT, type Entity } from "../shared/world";
import {
  WORLD_LIMIT,
  groundLevel,
  isWater,
  surfaceLevel,
  swimming,
  watercraft,
  WATER_LEVEL,
} from "../shared/water.ts";
mountUI();
mountDebugWindows();
const characterMenu = mountCharacterMenu();
const nameplates = new Nameplates();
let pickups: Pickup[] = [];
let loadoutShown = "";
let roster: PlayerSummary[] = [];
const farPlayers = new Map<string, PlayerPosition>();
const $ = <T extends HTMLElement = HTMLElement>(s: string) =>
  document.querySelector<T>(s)!;
const playerList = new PlayerList(
  $<HTMLUListElement>("#player-list"),
  $("#player-count"),
);
let network: GameNetwork | undefined,
  playerId: string | undefined,
  entities: Entity[] = [],
  joined = false,
  debugAllowed = false,
  scene: CityScene;
let automation: AgentInterface | undefined;
let cityStream: CityStream;
let cityMap: CityMap | undefined;
function setCamera(mode: CameraMode) {
  if (!debugAllowed || !scene) return;
  controls.clear();
  network?.input(idle());
  scene.debugCamera.setMode(mode, scene.camera.position, scene.target);
  $<HTMLSelectElement>("#camera-mode").value = mode;
  $("#camera-hint").classList.toggle("hidden", mode === "follow");
  $("#camera-hint").textContent =
    mode === "fly"
      ? "FLY CAMERA · WASD move · E/Q up/down · Shift / Space faster · Right-drag look · Wheel zoom · Escape to follow"
      : "FREE CAMERA · WASD pan · E/Q raise/lower · Shift / Space faster · Wheel zoom · Escape to follow";
  network?.send({ type: "debugView", center: null });
}
const controls = new Controls(),
  keys = controls.keys,
  audio = new GameAudio();
let toastTimer: ReturnType<typeof setTimeout>;
function toast(message: string) {
  $("#toast").textContent = message;
  $("#toast").classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("#toast").classList.add("hidden"), 4000);
}
function send(data: object) {
  network?.send(data);
}
function handleGamepadActions() {
  if (controls.gamepadPressed(8)) {
    audio.ui();
    cityMap?.setOpen(!cityMap.open);
  }
  if (controls.gamepadPressed(9)) {
    audio.ui();
    $("#help").classList.toggle("hidden");
  }
  if (cityMap?.open || scene.debugCamera.active) return;
  if (controls.gamepadPressed(3)) send({ type: "interact" });
  if (controls.gamepadPressed(1)) send({ type: "reload" });
  if (controls.gamepadPressed(10)) send({ type: "jetpack" });
  [12, 15, 13, 14].forEach((button, slot) => {
    if (controls.gamepadPressed(button)) send({ type: "equip", slot });
  });
}
function loading(text: string) {
  const status = document.querySelector("#boot-status") ?? $("#loading");
  status.textContent = text;
}
$("#join").addEventListener("submit", (event) => {
  event.preventDefault();
  if (!scene) return;
  audio.unlock();
  network?.close();
  $("#play").setAttribute("disabled", "");
  network = new GameNetwork(
    {
      welcome(m) {
        if (m.map.mapId !== cityStream.map.mapId) {
          location.reload();
          return;
        }
        playerId = m.id;
        debugAllowed = m.debug;
        if (!debugAllowed) $("#debug").classList.add("hidden");
        document.querySelector(".debug-hint")?.classList.toggle("hidden", !m.debug);
        if (debugAllowed && network) {
          automation = new AgentInterface(
            network,
            scene,
            setCamera,
            {
              places: async () =>
                adminPlaces(cityStream.map, await cityMap!.landmarks()),
              players: () => roster.filter((player) => player.id !== playerId),
            },
            () => cityStream.diagnostics,
          );
          Object.defineProperty(window, "afterhoursDebug", {
            configurable: true,
            value: automation,
          });
        } else {
          automation = undefined;
          delete (window as unknown as { afterhoursDebug?: AgentInterface })
            .afterhoursDebug;
        }
        characterMenu.dispose();
        joined = true;
        $("#entry").classList.add("hidden");
        $("#hud").classList.remove("hidden");
        toast("Welcome to Paloma. Mouse to aim, F to enter a vehicle.");
      },
      state(m) {
        entities = m.entities;
        pickups = m.pickups;
        // Ease toward server time so the swell never jumps; snap after a stall.
        scene.time +=
          (m.time - scene.time) * (Math.abs(m.time - scene.time) > 1 ? 1 : 0.2);
        scene.day = m.day;
        scene.dayRate = m.dayRate ?? 1 / 75;
        scene.updatePickups(m.pickups);
        scene.updateGrenades(m.grenades ?? []);
        scene.destruction.receive(m.debris ?? [], m.time);
        $("#population").textContent = String(m.players);
        const p = entities.find((e) => e.id === playerId);
        audio.snapshot(entities, p, m.debris);
        for (const e of m.events) {
          scene.effect(e);
          audio.event(e, p);
        }
      },
      chat(name, text) {
        const p = document.createElement("p"),
          b = document.createElement("b");
        b.textContent = name + ": ";
        p.append(b, document.createTextNode(text));
        $("#messages").append(p);
        while ($("#messages").children.length > 6) $("#messages").firstChild?.remove();
      },
      positions(players) {
        farPlayers.clear();
        for (const p of players) farPlayers.set(p.id, p);
      },
      roster(players) {
        roster = players;
        playerList.update(players, playerId);
        nameplates.roster(players);
        if (debugAllowed) renderAdmin();
      },
      destruction(ids) {
        scene.destruction.setBroken(ids);
      },
      status(state) {
        loading(state);
        if (state !== "connected") {
          audio.reset();
          nameplates.clear();
          playerList.clear(state === "reconnecting" ? "Reconnecting…" : "Connecting…");
          controls.clear();
          automation?.stop();
          automation = undefined;
          delete (window as unknown as { afterhoursDebug?: AgentInterface })
            .afterhoursDebug;
          scene.debugCamera.mode = "follow";
          $("#camera-hint").classList.add("hidden");
          $<HTMLSelectElement>("#camera-mode").value = "follow";
          if (joined)
            toast(state === "reconnecting" ? "Reconnecting to the city..." : state);
        }
      },
    },
    $<HTMLInputElement>("#name").value,
    characterMenu.selection.color,
    scene.city,
    characterMenu.selection.character,
  );
  network.worldReady = (point) => cityStream.ready(point);
  network.clock = inputClock;
  network.connect();
});
window.addEventListener("keydown", (event) => {
  const typing = ["INPUT", "SELECT", "TEXTAREA"].includes(
    document.activeElement?.tagName || "",
  );
  if (typing) {
    if (event.code === "Enter" && document.activeElement?.id === "chat") {
      event.preventDefault();
      const chat = $<HTMLInputElement>("#chat");
      if (chat.value.trim()) send({ type: "chat", text: chat.value });
      chat.value = "";
      chat.blur();
    }
    return;
  }
  if (!joined) return;
  if (
    ["Space", "F1", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(
      event.code,
    )
  )
    event.preventDefault();
  controls.press(event.code);
  if (event.repeat) return;
  if (event.code === "KeyM") {
    audio.ui();
    cityMap?.setOpen(!cityMap.open);
    return;
  }
  if (cityMap?.open) {
    if (event.code === "Escape") cityMap.setOpen(false);
    controls.clear();
    return;
  }
  if (event.code === "Escape" && scene.debugCamera.active) setCamera("follow");
  if (!scene.debugCamera.active && event.code === "KeyF") send({ type: "interact" });
  if (!scene.debugCamera.active && event.code === "KeyG") send({ type: "drop" });
  if (!scene.debugCamera.active && event.code === "KeyR") send({ type: "reload" });
  if (!scene.debugCamera.active && event.code === "KeyB") send({ type: "jetpack" });
  if (!scene.debugCamera.active && /^Digit[1-4]$/.test(event.code))
    send({ type: "equip", slot: Number(event.code.slice(-1)) - 1 });
  if (event.code === "KeyN") {
    audio.toggle();
    toast(audio.muted ? "Sound muted" : "Sound on");
  }
  if (event.code === "F1") {
    if (debugAllowed) $("#debug").classList.toggle("hidden");
    else toast("The development garage is disabled on this server.");
  }
  if (event.code === "KeyH") {
    audio.ui();
    $("#help").classList.toggle("hidden");
  }
  if (event.code === "Enter") {
    $<HTMLInputElement>("#chat").focus();
    controls.clear();
  }
  if (event.code === "Escape") {
    $("#debug").classList.add("hidden");
    $("#help").classList.add("hidden");
  }
});
window.addEventListener("keyup", (e) => keys.delete(e.code));
window.addEventListener("blur", () => {
  controls.clear();
  automation?.stop();
  network?.input(idle());
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    controls.clear();
    automation?.stop();
    network?.input(idle());
  }
});
$("#closehelp").onclick = () => $("#help").classList.add("hidden");
for (const button of document.querySelectorAll<HTMLButtonElement>("[data-spawn]"))
  button.onclick = () => {
    const kind = button.dataset.spawn;
    if (kind && isVehicleModel(kind))
      void automation
        ?.spawn(kind)
        .catch((error: unknown) =>
          toast(error instanceof Error ? error.message : "Vehicle spawn failed"),
        );
    else send({ type: "debug", kind });
    button.blur();
  };
$<HTMLSelectElement>("#camera-mode").onchange = (event) => {
  setCamera((event.target as HTMLSelectElement).value as CameraMode);
  (event.target as HTMLSelectElement).blur();
};
for (const button of document.querySelectorAll<HTMLButtonElement>("[data-hour]"))
  button.onclick = () =>
    void automation
      ?.time(Number(button.dataset.hour), 0)
      .catch((error) => toast(String(error)));
$("#time-resume").onclick = () =>
  void automation?.time(scene.day, 1 / 75).catch((error) => toast(String(error)));
$("#time-cycle").onclick = () =>
  void automation?.time(0, 0.8).catch((error) => toast(String(error)));
/** Admin teleports report progress and server rejections in the window itself. */
function adminRun(label: string, action: Promise<unknown> | undefined) {
  if (!action) return;
  const status = $("#admin-status");
  status.textContent = `${label}…`;
  action.then(
    () => (status.textContent = `${label}: done`),
    (error: unknown) =>
      (status.textContent = `${label}: ${String(error instanceof Error ? error.message : error).replace(/^Error: /, "")}`),
  );
}
function renderAdmin() {
  renderAdminPlayers(
    $("#admin-players"),
    roster,
    playerId,
    (player) => adminRun(`Going to ${player.name}`, automation?.gotoPlayer(player.id)),
    (player) => adminRun(`Bringing ${player.name}`, automation?.bringPlayer(player.id)),
  );
}
// The launcher toggles visibility first; refresh whenever the window opens.
$('[aria-controls="debug-admin"]').addEventListener("click", () => {
  if ($("#debug-admin").classList.contains("hidden")) return;
  renderAdmin();
  void automation?.places().then(
    (groups) =>
      renderAdminPlaces($("#admin-places"), groups, (place) =>
        adminRun(
          `Teleporting to ${place.name}`,
          automation?.teleportTo(place.x, place.z),
        ),
      ),
    () => ($("#admin-places").textContent = "Map unavailable. Reopen to retry."),
  );
});
const canvas = $<HTMLCanvasElement>("#world");
let inspectionPointer: { x: number; y: number } | undefined;
let inspectedId: string | undefined;
canvas.addEventListener("pointerleave", () => {
  inspectionPointer = undefined;
});
canvas.addEventListener("pointermove", (e) => {
  inspectionPointer = { x: e.clientX, y: e.clientY };
  if (scene?.debugCamera.active) {
    if (e.buttons & 2) scene.debugCamera.look(e.movementX, e.movementY);
    return;
  }
  controls.pointer = { x: e.clientX, y: e.clientY };
});
canvas.addEventListener("pointerdown", (event) => {
  if (joined) {
    audio.unlock();
    if (
      !cityMap?.open &&
      !scene.debugCamera.active &&
      !inspecting() &&
      event.button === 0
    )
      controls.click();
  }
});
canvas.addEventListener("contextmenu", (event) => {
  if (scene?.debugCamera.active) event.preventDefault();
});
canvas.addEventListener(
  "wheel",
  (event) => {
    if (scene?.debugCamera.active) {
      event.preventDefault();
      scene.debugCamera.zoom(event.deltaY);
    }
  },
  { passive: false },
);
window.addEventListener("pointerup", () => (controls.mouseDown = false));
const inputClock = new InputClock();
function pumpInput(now = performance.now()) {
  if (!joined || document.hidden) {
    inputClock.reset();
    return;
  }
  const pointer = controls.pointer;
  const p = network?.entities.get(network.playerId);
  const position = p && scene?.nodes.get(p.id)?.position;
  const point = pointer && scene?.aimPoint(pointer.x, pointer.y);
  controls.aim =
    point && position && !p?.vehicle
      ? Math.atan2(point.x - position.x, point.z - position.z)
      : undefined;
  inputClock.advance(now, (timestamp) => {
    const input = controls.sample();
    handleGamepadActions();
    network?.input(
      cityMap?.open ||
        scene.debugCamera.active ||
        ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName || "")
        ? idle()
        : automation?.input || input,
      timestamp,
    );
  });
}
setInterval(pumpInput, 1000 / 30);
setInterval(() => {
  if (debugAllowed && network && !$("#debug").classList.contains("hidden"))
    updateNetworkStats($("#network-stats"), network);
}, 250);
function debugPanelOpen(id: string) {
  const panel = $(`#debug-${id}`);
  return (
    debugAllowed &&
    !$("#debug").classList.contains("hidden") &&
    !panel.classList.contains("hidden") &&
    !panel.querySelector<HTMLElement>(".debug-body")!.hidden
  );
}
function inspecting() {
  return debugPanelOpen("inspector") && $<HTMLInputElement>("#inspect-enabled").checked;
}
let observing = false;
setInterval(async () => {
  const current = automation;
  if (
    !current ||
    observing ||
    document.hidden ||
    (!debugPanelOpen("server") && !inspecting())
  )
    return;
  if (inspecting() && inspectionPointer && scene) {
    const hit = inspectAtPointer(scene, inspectionPointer.x, inspectionPointer.y);
    const previousId = inspectedId;
    inspectedId = hit?.kind === "entity" ? hit.id : undefined;
    $("#inspect-target").textContent =
      hit?.kind === "entity" ? hit.id : hit?.name || "No object under pointer";
    if (!inspectedId || inspectedId !== previousId)
      $("#inspect-data").textContent =
        hit?.kind === "scenery"
          ? hit.data
          : inspectedId
            ? "Loading server state…"
            : "Hover a person, vehicle or scenery.";
  }
  observing = true;
  try {
    const state = await current.command({
      kind: "observe",
      id: inspecting() ? inspectedId : undefined,
    });
    if (automation !== current) return;
    if (state.server) {
      updateServerStats($("#server-stats"), state.server);
      $("#server-status").textContent = `Updated ${new Date().toLocaleTimeString()}`;
    }
    if (inspecting() && inspectedId) {
      $("#inspect-data").textContent =
        state.inspection?.data || "Object no longer exists on the server.";
    }
  } catch (error) {
    $("#server-status").textContent = `Unavailable: ${String(error)}`;
    if (inspecting() && inspectedId)
      $("#inspect-data").textContent = `Unavailable: ${String(error)}`;
  } finally {
    observing = false;
  }
}, 1000);
const map = $<HTMLCanvasElement>("#minimap").getContext("2d")!;
function drawMap(p: Entity) {
  const scale = 0.9;
  map.fillStyle = "#80917a";
  map.fillRect(0, 0, 220, 220);
  map.save();
  map.translate(110 - p.x * scale, 110 + p.z * scale);
  map.scale(scale, -scale);
  for (let x = Math.floor((p.x - 125) / 8) * 8; x <= p.x + 125; x += 8)
    for (let z = Math.floor((p.z - 125) / 8) * 8; z <= p.z + 125; z += 8)
      if (isWater(x, z, scene.city)) {
        map.fillStyle = "#478e9c";
        map.fillRect(x, z, 8, 8);
      }

  map.fillStyle = "#4e6060";
  for (const r of scene.city.roads) {
    map.strokeStyle = "#4e6060";
    map.lineWidth = r.width;
    map.lineCap = "round";
    map.beginPath();
    map.moveTo(r.ax, r.az);
    map.lineTo(r.bx, r.bz);
    map.stroke();
  }
  for (const park of scene.city.parks) {
    map.fillStyle = park.kind === "civic" ? "#b7b19a" : "#64845d";
    map.fillRect(
      park.x - (park.w ?? 38) / 2,
      park.z - (park.d ?? 38) / 2,
      park.w ?? 38,
      park.d ?? 38,
    );
  }
  map.fillStyle = "#c7c6b1";
  for (const b of scene.city.buildings)
    map.fillRect(b.x - b.w / 2, b.z - b.d / 2, b.w, b.d);
  for (const e of entities) {
    if (e.kind === "pedestrian") continue;
    const player = e.kind === "player";
    map.fillStyle = player
      ? swatch(roster.find((r) => r.id === e.id)?.color ?? "")
      : "#efbd66";
    map.beginPath();
    map.arc(e.x, e.z, player ? 3.5 : 2, 0, 7);
    map.fill();
    if (player) {
      map.strokeStyle = "#fff8de";
      map.lineWidth = 1.2;
      map.stroke();
    }
  }
  map.restore();
  map.save();
  map.translate(110, 110);
  map.rotate(p.angle);
  map.fillStyle = "#ffffff";
  map.strokeStyle = "#203435";
  map.lineWidth = 2;
  map.beginPath();
  map.moveTo(0, -8);
  map.lineTo(-5, 5);
  map.lineTo(5, 5);
  map.closePath();
  map.fill();
  map.stroke();
  map.restore();
  map.fillStyle = "#ffffff";
  map.font = "bold 12px sans-serif";
  map.fillText("N", 105, 16);
}
async function boot() {
  try {
    await new Promise((r) => setTimeout(r, 30));
    loading("Downloading the city map…");
    const response = await fetch("/city", {
      cache: "no-store",
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw Error("City download failed");
    const world: ClientMap = mapManifestSchema.parse(await response.json());
    if (world.hasTerrain) {
      loading("Downloading the terrain…");
      const terrain = await fetch(`/city/terrain/${world.mapId}`, {
        cache: "no-store",
        signal: AbortSignal.timeout(30000),
      });
      if (!terrain.ok) throw Error("Terrain download failed");
      const heights = unpackHeights(new Uint8Array(await terrain.arrayBuffer()));
      if (heights.length !== TERRAIN_SIDE * TERRAIN_SIDE)
        throw Error("Terrain download is incomplete");
      world.terrain = { heights };
    }
    if (world.hasWater) {
      const water = await fetch(`/city/water/${world.mapId}`, {
        cache: "no-store",
        signal: AbortSignal.timeout(30000),
      });
      if (!water.ok) throw Error("Water download failed");
      world.water = cityWaterSchema.parse(await water.json());
    }
    let cityRenderer: CityRenderer | undefined;
    cityStream = new CityStream(world, (chunks) => cityRenderer?.sync(chunks));
    const base = world.geometryVersion
      ? await fetch(`/city/geometry/${world.mapId}/base`, {
          cache: "no-store",
          signal: AbortSignal.timeout(30000),
        }).then(async (response) => {
          if (!response.ok) throw Error("Saved terrain mesh download failed");
          return meshGroupSchema.parse(await response.json());
        })
      : undefined;
    scene = new CityScene($<HTMLCanvasElement>("#world"), cityStream.city, true, base);
    cityMap = new CityMap(
      $("#city-map"),
      $<HTMLCanvasElement>("#city-map-canvas"),
      $("#map-status"),
      world,
      () => {
        controls.clear();
        automation?.stop();
        network?.input(idle());
      },
    );
    loading("Loading the spawn neighbourhood…");
    await cityStream.prepare();
    loading("Building the spawn scenery…");
    cityRenderer = new CityRenderer(scene, world);
    cityRenderer.sync([...cityStream.chunks.values()]);
    scene.lighting.selectLamps(scene.target);
    loading("Preparing the first frame…");
    await prepareFirstFrame(scene.engine, scene.scene, loading);
    void audio.preload();
    $("#play").textContent = "Enter the city";
    $("#play").removeAttribute("disabled");
    $("#app").removeAttribute("inert");
    document.querySelector("#boot")?.remove();
    characterMenu.ready();
    const profileEnabled =
      import.meta.env.DEV ||
      new URLSearchParams(location.search).get("profile") === "1";
    const profiler = profileEnabled ? new FrameProfiler() : undefined;
    if (profileEnabled)
      Object.defineProperty(window, "afterhours", {
        configurable: true,
        get: () => ({
          playerId,
          entities,
          predicted: network?.prediction?.body,
          pending: network?.prediction?.pending.length,
          corrections: network?.prediction?.corrections,
          latency: network?.latency,
          networking: network?.stats(),
          skids: scene.effects.skidMarks.length,
          particles: scene.effects.effects.length,
          gpu: scene.engine.getGlInfo(),
          fps: scene.engine.getFps(),
          frameP95Ms: profiler!.stats.frameP95Ms,
          frameMaxMs: profiler!.stats.frameMaxMs,
          frameStages: profiler!.stats.stagesP95Ms,
          trailUploads: scene.effects.trails.uploads,
          trailTiles: scene.effects.trails.residentTiles,
          cityStreaming: cityStream.diagnostics,
          trailUploadMs: scene.effects.trails.lastUploadMs,
          audio: audio.diagnostics,
          profile: async (seconds = 60) => {
            if (!joined) throw Error("Join the city before profiling");
            const viewport = [innerWidth, innerHeight];
            const result = await profileNetwork(
              () => profiler!.profile(seconds),
              () => network?.stats(),
            );
            return {
              ...result,
              gpu: scene.engine.getGlInfo(),
              viewport,
              browser: navigator.userAgent,
              pixelRatio: devicePixelRatio,
              audio: audio.muted ? "muted" : "enabled",
            };
          },
          meshes: scene.scene.meshes.length,
          destruction: scene.destruction.diagnostics,
        }),
      });
    let last = performance.now(),
      ui = 0,
      streamClock = 0;
    scene.engine.runRenderLoop(() => {
      const now = performance.now(),
        dt = Math.min(0.05, (now - last) / 1000);
      const interval = now - last;
      last = now;
      if (!joined) return;
      pumpInput(now);
      const cameraInput =
        cityMap?.open ||
        ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName || "")
          ? idle()
          : automation?.input || controls.read();
      const rendered =
        network?.renderEntities(now, scene.debugCamera.active ? idle() : cameraInput) ||
        entities;
      scene.destruction.setPredictedImpacts(
        network?.predictedImpacts ?? new Map(),
        network?.debrisClock,
      );
      scene.update(rendered, playerId, dt, cameraInput);
      cityRenderer?.fadeOccluders(scene.camera.position, scene.target, dt);
      streamClock += dt;
      if (joined && streamClock >= 0.1) {
        streamClock = 0;
        const p = network?.entities.get(network.playerId),
          body = p?.vehicle ? network?.entities.get(p.vehicle) : p,
          forward = scene.camera.getForwardRay().direction,
          groundDistance =
            Math.max(0, scene.camera.position.y) / Math.max(0.15, -forward.y),
          radius = Math.max(
            SCENERY_RADIUS,
            groundDistance *
              Math.tan(scene.camera.fov / 2) *
              Math.max(
                1,
                scene.engine.getRenderWidth() / scene.engine.getRenderHeight(),
              ) *
              2 +
              64,
          ),
          center =
            forward.y < -0.15
              ? {
                  x: scene.camera.position.x + forward.x * groundDistance,
                  z: scene.camera.position.z + forward.z * groundDistance,
                }
              : scene.target;
        cityStream.setView(body, center, radius);
      }
      const local = rendered.find((e) => e.id === playerId);
      const audioRight = scene.camera.getDirection(new Vector3(1, 0, 0));
      const audioRightLength = Math.hypot(audioRight.x, audioRight.z) || 1;
      audio.update(rendered, local, dt, scene.city, {
        rightX: audioRight.x / audioRightLength,
        rightZ: audioRight.z / audioRightLength,
        input: cameraInput,
      });
      const updated = profiler ? performance.now() : 0;
      scene.scene.render();
      nameplates.update(scene, rendered, playerId);
      const renderedAt = profiler ? performance.now() : 0;
      ui += dt;
      if (ui > 0.1 && joined) {
        ui = 0;
        const p = rendered.find((e) => e.id === playerId);
        if (!p) return;
        if (debugAllowed && scene.debugCamera.active)
          send({
            type: "debugView",
            center: {
              x: Math.max(-WORLD_LIMIT, Math.min(WORLD_LIMIT, scene.target.x)),
              z: Math.max(-WORLD_LIMIT, Math.min(WORLD_LIMIT, scene.target.z)),
            },
          });
        const v = rendered.find((e) => e.id === p.vehicle);
        $("#player-status").classList.toggle("on-foot", !v);
        $("#speed").textContent = String(
          Math.round(Math.hypot(v?.vx || 0, v?.vz || 0) * 3.6),
        );
        $("#unit").textContent = v
          ? "KM/H"
          : p.parachute
            ? "PARACHUTE"
            : swimming(p, scene.city)
              ? "SWIMMING"
              : "ON FOOT";
        $("#weapon").textContent = p.down
          ? "RECOVERING…"
          : (v?.kind || p.weapon || "fists").toUpperCase();
        const healthPercent = Math.max(
          0,
          ((v?.health ?? p.health) / (v?.maxHealth ?? p.maxHealth ?? 100)) * 100,
        );
        $("#health").style.width = `${healthPercent}%`;
        document
          .querySelector(".health")
          ?.setAttribute("aria-valuenow", String(Math.round(healthPercent)));
        const item = p.inventory?.[p.equipped || 0];
        if (!v && item)
          $("#weapon").textContent = p.reloadUntil
            ? "RELOADING"
            : WEAPONS[item.kind].name.toUpperCase();
        const slots =
          !v && !p.down ? loadoutHTML(p.inventory, p.equipped, !!p.reloadUntil) : "";
        if (slots !== loadoutShown) $("#loadout").innerHTML = loadoutShown = slots;
        $("#health").style.background =
          v?.burning !== undefined ? "#f47a44" : "#9fd3aa";
        if (v?.burning !== undefined)
          $("#weapon").textContent = `ON FIRE - EXIT! ${Math.ceil(v.burning)}s`;
        else if (v?.kind === "helicopter")
          $("#weapon").textContent =
            `${v.takeoffDelay ? `BOARDING ${Math.ceil(v.takeoffDelay)}s` : v.flight?.toUpperCase()} | ${Math.round(v.y)} M`;
        else if (p.parachute)
          $("#weapon").textContent = `PARACHUTE | ${Math.round(p.y)} M`;
        if (!v && p.jetpack)
          $("#weapon").textContent +=
            ` | JETPACK ${p.jetpack.active ? "ON" : "OFF"} ${Math.ceil(p.jetpack.fuel)}s · B toggle · E thrust`;
        if (v && v.burning === undefined)
          $("#weapon").textContent +=
            ` | ${v.driver === p.id ? "DRIVER" : "PASSENGER"} | ${occupiedSeats(v)}/${seatCapacity(v)} SEATS`;
        $("#district").textContent = district(p.x, p.z);
        $("#street").textContent =
          `${Math.abs(p.x) < 12 ? "Paloma Avenue" : "Island streets"} · ${v ? "Cruising" : "On foot"}`;
        $("#clock").textContent =
          `${String(Math.floor(scene.day)).padStart(2, "0")}:${String(Math.floor((scene.day % 1) * 60)).padStart(2, "0")}`;
        const nearVehicle = entities
          .filter(
            (e) =>
              e.kind !== "player" &&
              e.kind !== "pedestrian" &&
              availableSeat(e) >= 0 &&
              !e.wreck &&
              e.burning === undefined &&
              e.y - surfaceLevel(e.x, e.z, scene.city) < 0.5 &&
              Math.abs(e.y - p.y) < (watercraft(e.kind) ? 1.6 : 0.5) &&
              Math.hypot(e.x - p.x, e.z - p.z) < 6,
          )
          .sort(
            (a, b) =>
              Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z),
          )[0];
        const nearPickup = pickups
          .filter(
            (e) => Math.abs(e.y - p.y) < 1.2 && Math.hypot(e.x - p.x, e.z - p.z) < 2.5,
          )
          .sort(
            (a, b) =>
              Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z),
          )[0];
        const action =
          nearPickup &&
          Math.hypot(nearPickup.x - p.x, nearPickup.z - p.z) <
            (nearVehicle
              ? Math.hypot(nearVehicle.x - p.x, nearVehicle.z - p.z)
              : Infinity)
            ? `Pick up ${nearPickup.kind === "weapon" ? nearPickup.item.kind.toUpperCase() : nearPickup.kind === "ammo" ? `${nearPickup.ammoKind.toUpperCase()} AMMO` : "JETPACK"}`
            : nearVehicle
              ? `${availableSeat(nearVehicle) === 0 ? "Drive" : "Ride in"} ${nearVehicle.model ? VEHICLES[nearVehicle.model].name : nearVehicle.kind} (${occupiedSeats(nearVehicle)}/${seatCapacity(nearVehicle)} seats)`
              : "No nearby vehicle or weapon";
        $("#prompt").innerHTML = v
          ? v.y - surfaceLevel(v.x, v.z, scene.city) > 0.2 &&
            (v.kind === "helicopter" || v.kind === "plane")
            ? `<kbd>F</kbd> Exit and deploy parachute`
            : `<kbd>F</kbd> Exit ${v.kind}${v.kind === "plane" ? " · E / Q altitude" : ""}`
          : p.parachute
            ? `<kbd>W A S D</kbd> Steer parachute`
            : `<kbd>F</kbd> ${action}`;
        drawMap(p);
        cityMap?.update(
          p,
          rendered,
          mapPlayers(roster, rendered, farPlayers, playerId),
        );
      }
      profiler?.record({
        interval,
        update: updated - now,
        render: renderedAt - updated,
        ui: performance.now() - renderedAt,
      });
    });
  } catch (error) {
    scene?.engine.stopRenderLoop();
    document.querySelector("#boot")?.setAttribute("data-failed", "");
    loading(
      `Could not load the city. ${error instanceof Error ? error.message : "Check your connection and WebGL, then refresh."}`,
    );
    console.error(error);
  }
}
void boot();
