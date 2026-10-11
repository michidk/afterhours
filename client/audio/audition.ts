import { GameAudio } from "./index.ts";
import { SOUND_BANKS, type Sound } from "./banks.ts";

const select = document.querySelector<HTMLSelectElement>("#sound"),
  inventory = document.querySelector<HTMLTableSectionElement>("#inventory"),
  play = document.querySelector<HTMLButtonElement>("#play"),
  stop = document.querySelector<HTMLButtonElement>("#stop"),
  selection = document.querySelector<HTMLParagraphElement>("#selection");
if (!select || !inventory || !play || !stop || !selection)
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
play.addEventListener("click", async () => {
  const name = select.value;
  if (!isSound(name)) return;
  const token = ++request;
  play.disabled = true;
  selection.textContent = "Loading audio…";
  try {
    await audio.audition(name);
    if (token !== request) {
      audio.reset();
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
  request++;
  audio.reset();
  selection.textContent = "Stopped.";
});
select.addEventListener("change", () => {
  request++;
  audio.reset();
  selection.textContent = "Press Play to hear this sound.";
});
window.addEventListener("pagehide", () => audio.reset());
