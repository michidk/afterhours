import { GameAudio } from "./index.ts";
import { SOUND_BANKS, type Sound } from "./banks.ts";
import {
  demoFrame,
  DEMO_DURATION,
  type VehicleDemo,
  type DemoScenario,
} from "./demo.ts";

const select = document.querySelector<HTMLSelectElement>("#sound"),
  inventory = document.querySelector<HTMLTableSectionElement>("#inventory"),
  play = document.querySelector<HTMLButtonElement>("#play"),
  stop = document.querySelector<HTMLButtonElement>("#stop"),
  selection = document.querySelector<HTMLParagraphElement>("#selection"),
  vehicle = document.querySelector<HTMLSelectElement>("#vehicle"),
  scenario = document.querySelector<HTMLSelectElement>("#scenario"),
  drive = document.querySelector<HTMLButtonElement>("#drive"),
  vehicleStatus = document.querySelector<HTMLParagraphElement>("#vehicle-status");
if (
  !select ||
  !inventory ||
  !play ||
  !stop ||
  !selection ||
  !vehicle ||
  !scenario ||
  !drive ||
  !vehicleStatus
)
  throw Error("Sound library controls are missing");
const audio = new GameAudio();
const soundNames = Object.keys(SOUND_BANKS);
function isSound(name: string): name is Sound {
  return Object.hasOwn(SOUND_BANKS, name);
}
for (const name of soundNames)
  if (isSound(name)) {
    const bank = SOUND_BANKS[name];
    select.add(new Option(name.replace(/([A-Z])/g, " $1"), name));
    const row = inventory.insertRow();
    for (const value of [
      name,
      String(bank.files.length),
      `±${bank.pitch} semitones`,
      bank.loop ? "Loop" : "One shot",
    ])
      row.insertCell().textContent = value;
    row.cells[1].className = row.cells[2].className = "number";
  }
let request = 0;
let animation: number | undefined;
function stopPlayback() {
  request++;
  if (animation !== undefined) cancelAnimationFrame(animation);
  animation = undefined;
  audio.reset();
}
drive.addEventListener("click", async () => {
  stopPlayback();
  const token = request;
  vehicleStatus.textContent = "Preparing your vehicle…";
  try {
    await audio.ready();
    if (token !== request) return;
    if (audio.diagnostics.state !== "running") {
      vehicleStatus.textContent = "Press Play vehicle again to enable sound.";
      return;
    }
    const vehicleName = vehicle!.value as VehicleDemo;
    const scenarioName = scenario!.value as DemoScenario;
    const started = performance.now();
    let last = started;
    const initial = demoFrame(vehicleName, scenarioName, 16);
    audio.snapshot([initial.entity], initial.listener);
    const tick = (now: number) => {
      if (token !== request) return;
      const time = (now - started) / 1000;
      if (time >= DEMO_DURATION) {
        stopPlayback();
        vehicleStatus!.textContent = "Demo complete. Play again to hear another take.";
        return;
      }
      const frame = demoFrame(vehicleName, scenarioName, time);
      audio.snapshot([frame.entity], frame.listener);
      audio.update(
        [frame.entity],
        frame.listener,
        Math.min(0.1, (now - last) / 1000),
        undefined,
        { rightX: 1, rightZ: 0, input: frame.input },
      );
      last = now;
      const engine = audio.diagnostics.vehicles[0];
      vehicleStatus!.textContent = `${frame.phase} · ${Math.round(Math.hypot(frame.entity.vx, frame.entity.vz) * 3.6)} km/h${engine ? ` · revs ${Math.round(engine.rpm * 100)}% · load ${Math.round(engine.load * 100)}%${frame.entity.kind === "car" ? ` · gear ${engine.gear}` : ""}` : ""} · ${audio.diagnostics.loops} layers${audio.diagnostics.failed.length ? ` · ${audio.diagnostics.failed.length} files unavailable` : ""}`;
      animation = requestAnimationFrame(tick);
    };
    animation = requestAnimationFrame(tick);
  } catch {
    vehicleStatus.textContent =
      "Could not start the demo. Press Play vehicle to retry.";
  }
});
play.addEventListener("click", async () => {
  const name = select.value;
  if (!isSound(name)) return;
  stopPlayback();
  const token = request;
  play.disabled = true;
  selection.textContent = "Loading audio…";
  try {
    await audio.ready();
    if (token !== request) return;
    await audio.audition(name);
    if (token !== request) {
      return;
    }
    const { lastSelection: take, failed } = audio.diagnostics;
    selection.textContent = take
      ? `${take.file}.wav · pitch ${take.rate.toFixed(3)}× · gain ${take.gain.toFixed(3)}×${failed.length ? ` · ${failed.length} files unavailable` : ""}`
      : "This sound could not be loaded.";
  } catch {
    selection.textContent = "Playback failed. Press Play to retry.";
  } finally {
    play.disabled = false;
  }
});
stop.addEventListener("click", () => {
  stopPlayback();
  selection.textContent = "Stopped.";
  vehicleStatus.textContent = "Stopped.";
});
select.addEventListener("change", () => {
  stopPlayback();
  selection.textContent = "Press Play to hear this sound.";
});
vehicle.addEventListener("change", stopPlayback);
scenario.addEventListener("change", stopPlayback);
window.addEventListener("pagehide", stopPlayback);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopPlayback();
});
