import { z } from "zod";
import {
  characterSchema,
  DEFAULT_CHARACTER,
  PHYSIQUES,
  SHIRT_COLORS,
  randomCharacter,
} from "../../shared/character.ts";
import { CharacterPreview } from "./character-preview.ts";

export const characterMenuHTML = `<section class="overlay" id="entry" aria-labelledby="entry-title">
  <header class="entry-masthead"><a class="wordmark" href="/" aria-label="Afterhours home">AFTERHOURS<span>●</span></a><span>PALOMA ISLAND<br>ONLINE PLAYTEST / 01</span></header>
  <form id="join" class="character-sheet">
    <div class="character-heading"><span class="sheet-label">BEFORE YOU HEAD OUT</span><h1 id="entry-title">Who's going<br> out tonight?</h1><p>Make yourself at home. Then make some trouble.</p></div>
    <section class="portrait" aria-label="Character preview"><span class="portrait-label">PALOMA RESIDENT / <span id="physique-label">REGULAR</span></span><div class="portrait-number" aria-hidden="true">01</div><canvas id="character-preview" aria-label="3D preview of your chosen character"></canvas><div class="portrait-floor"></div><div class="portrait-caption"><span>YOUR CHARACTER</span><button type="button" id="randomize">↻ &nbsp; Randomize</button></div></section>
    <section class="character-options" aria-label="Customize character"><label class="field-label" for="name">01 / STREET NAME</label><input id="name" maxlength="18" placeholder="Your name" autocomplete="nickname" required value="Stranger">
    <fieldset class="physiques"><legend>02 / BUILD</legend><div class="physique-choices">${characterSchema.shape.physique.options.map((key) => `<button type="button" data-physique="${key}" aria-pressed="${key === "regular"}">${PHYSIQUES[key].name}</button>`).join("")}</div><p id="build-description"></p><div class="build-stats"><span>PACE <strong id="pace-stat"></strong></span><span>HEALTH <strong id="health-stat"></strong></span></div></fieldset>
    <fieldset class="appearance"><legend>03 / THE DETAILS</legend>${[
      ["hair", "Head", characterSchema.shape.hair.options],
      ["top", "Upper body", characterSchema.shape.top.options],
      ["legs", "Legs", characterSchema.shape.legs.options],
    ]
      .map(
        ([key, label, options]) =>
          `<div class="part-row"><label for="character-${key}">${label}</label><select id="character-${key}">${Array.isArray(options) ? options.map((value) => `<option value="${value}">${value === "tee" ? "T-shirt" : value.charAt(0).toUpperCase() + value.slice(1)}</option>`).join("") : ""}</select></div>`,
      )
      .join("")}
    <div class="part-row"><span>Skin tone</span><div class="swatches" role="group" aria-label="Skin tone">${characterSchema.shape.skin.options.map((color, index) => `<button type="button" class="swatch" data-skin="${color}" style="--swatch:${color}" aria-label="${["Light", "Warm", "Brown", "Deep"][index]} skin" aria-pressed="false"></button>`).join("")}</div></div>
    <div class="part-row"><span>Colour</span><div class="swatches" role="group" aria-label="Shirt colour">${SHIRT_COLORS.map((color, index) => `<button type="button" class="swatch" data-color="${color}" style="--swatch:${color}" aria-label="${["Ochre", "Rust", "Teal", "Lilac", "Olive", "Chalk"][index]} shirt" aria-pressed="false"></button>`).join("")}</div></div></fieldset>
    <button class="primary" id="play" disabled>Preparing the city…</button><div class="loading" id="loading" role="status" aria-live="polite">Your character is saved on this device.</div></section>
  </form><footer class="menu-footer"><span><i></i> ONE SHARED CITY. NO ACCOUNT REQUIRED.</span><span>DESKTOP · WASD MOVE · F ENTER VEHICLE</span></footer></section>`;

const savedSchema = z.object({
  character: characterSchema,
  color: z.enum(SHIRT_COLORS),
});
export function mountCharacterMenu() {
  let selection = {
    character: { ...DEFAULT_CHARACTER },
    color: String(SHIRT_COLORS[0]),
  };
  try {
    const saved = savedSchema.safeParse(
      JSON.parse(localStorage.getItem("afterhours-character") ?? "null"),
    );
    if (saved.success) selection = saved.data;
  } catch {
    /* Storage may be unavailable in private browsing. */
  }
  let preview: CharacterPreview | undefined;
  const element = <T extends HTMLElement>(selector: string) =>
    document.querySelector<T>(selector)!;
  function update() {
    const build = PHYSIQUES[selection.character.physique];
    element("#physique-label").textContent = build.name.toUpperCase();
    element("#build-description").textContent = build.description;
    element("#pace-stat").textContent = `${Math.round(build.speed * 100)}%`;
    element("#health-stat").textContent = String(build.health);
    for (const button of document.querySelectorAll<HTMLButtonElement>(
      "[data-physique], [data-skin], [data-color]",
    )) {
      const selected =
        button.dataset.physique === selection.character.physique ||
        button.dataset.skin === selection.character.skin ||
        button.dataset.color === selection.color;
      button.setAttribute("aria-pressed", String(selected));
    }
    for (const key of ["hair", "top", "legs"] as const)
      element<HTMLSelectElement>(`#character-${key}`).value = selection.character[key];
    preview?.update(selection.character, selection.color);
    try {
      localStorage.setItem("afterhours-character", JSON.stringify(selection));
    } catch {
      /* Selection still works without storage. */
    }
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>(
    "[data-physique], [data-skin], [data-color]",
  ))
    button.onclick = () => {
      selection.character = characterSchema.parse({
        ...selection.character,
        ...(button.dataset.physique ? { physique: button.dataset.physique } : {}),
        ...(button.dataset.skin ? { skin: button.dataset.skin } : {}),
      });
      if (button.dataset.color) selection.color = button.dataset.color;
      update();
    };
  for (const key of ["hair", "top", "legs"] as const)
    element<HTMLSelectElement>(`#character-${key}`).onchange = (event) => {
      if (event.target instanceof HTMLSelectElement)
        selection.character = characterSchema.parse({
          ...selection.character,
          [key]: event.target.value,
        });
      update();
    };
  element("#randomize").onclick = () => {
    selection = {
      character: randomCharacter(),
      color: SHIRT_COLORS[Math.floor(Math.random() * SHIRT_COLORS.length)],
    };
    update();
  };
  update();
  return {
    get selection() {
      return selection;
    },
    ready() {
      preview = new CharacterPreview(element<HTMLCanvasElement>("#character-preview"));
      update();
    },
    dispose() {
      preview?.dispose();
      preview = undefined;
    },
  };
}
