import { VEHICLES, WEAPONS } from "../../shared/catalog.ts";
import type { ServerDiagnostics } from "../../shared/debug.ts";
import type { PlayerSummary } from "../../shared/protocol.ts";
import type { AdminPlace, AdminPlaceGroup } from "../debug/admin.ts";

const spawnButtons = (names: string[]) =>
  names
    .map((name) => `<button data-spawn="${name}">${name.toUpperCase()}</button>`)
    .join("");
const panels = [
  [
    "vehicles",
    "Vehicles",
    spawnButtons(Object.keys(VEHICLES)) +
      `<details><summary>Player & equipment</summary>${spawnButtons([...Object.keys(WEAPONS).filter((k) => k !== "fists"), "jetpack", "heal", "respawn", "damage"])}</details>`,
  ],
  [
    "time",
    "Day / night",
    `<div class="time-tools">${[
      [0, "Midnight"],
      [6.5, "Dawn"],
      [12, "Noon"],
      [18.5, "Dusk"],
    ]
      .map(([hour, label]) => `<button data-hour="${hour}">${label}</button>`)
      .join(
        "",
      )}<button id="time-resume">Resume time</button><button id="time-cycle">30s cycle</button></div><p>Presets freeze the clock for inspection.</p>`,
  ],
  [
    "camera",
    "Camera",
    `<label for="camera-mode">Mode</label><select id="camera-mode"><option value="follow">Player follow</option><option value="free">Free camera</option><option value="fly">First-person fly camera</option></select><p>WASD moves · E/Q raises/lowers · Right-drag looks · Wheel zooms · Escape follows player</p>`,
  ],
  [
    "network",
    "Networking",
    `<dl id="network-stats"></dl><p>RTT is round-trip time. Input age includes travel, queueing and snapshot delivery.</p>`,
  ],
  [
    "server",
    "Server stats",
    `<p id="server-status" role="status">Waiting for server…</p><dl id="server-stats"></dl><p>CPU is simulation-thread time per tick (p95 over up to 600 ticks). RSS includes native physics memory. Available memory respects process constraints; heap limit is the JavaScript ceiling. Catch-up and dropped time are totals since startup.</p>`,
  ],
  [
    "inspector",
    "Object inspector",
    `<label><input type="checkbox" id="inspect-enabled"> Inspect objects under the pointer</label><p>Hover a person or vehicle. Move into this window to keep reading. Data refreshes once per second.</p><strong id="inspect-target">No object selected</strong><pre id="inspect-data">AI reactions, routes and entity state appear here.</pre>`,
  ],
  [
    "admin",
    "Admin",
    `<h4>Places</h4><div id="admin-places"><p>Landmarks load when this window opens.</p></div><h4>Players</h4><ul id="admin-players" class="admin-players"></ul><p id="admin-status" role="status">Teleports are server commands; a driver brings the vehicle and its passengers.</p>`,
  ],
];
export const debugWindowsHTML = `<div class="debug hidden" id="debug"><nav class="debug-launcher panel" aria-label="Debug windows"><strong>DEBUG</strong>${panels.map(([id, title]) => `<button data-debug-open="${id}" aria-controls="debug-${id}" aria-expanded="false">${title}</button>`).join("")}<button id="debug-reset">Reset layout</button><button id="debug-close" aria-label="Hide debug tools">×</button></nav>${panels.map(([id, title, content], i) => `<section class="debug-window panel hidden" id="debug-${id}" style="left:${24 + i * 34}px;top:${140 + i * 28}px" aria-label="${title}"><header tabindex="0" aria-label="Move ${title} window with arrow keys"><h3>${title}</h3><button data-debug-collapse aria-expanded="true" aria-label="Collapse ${title}">−</button><button data-debug-hide aria-label="Close ${title}">×</button></header><div class="debug-body">${content}</div></section>`).join("")}</div>`;

export function mountDebugWindows() {
  const root = document.querySelector<HTMLElement>("#debug")!;
  let front = 10;
  const windows = [...root.querySelectorAll<HTMLElement>(".debug-window")];
  const clamp = (panel: HTMLElement, x: number, y: number) => {
    panel.style.left = `${Math.max(0, Math.min(x, innerWidth - Math.min(360, innerWidth - 16)))}px`;
    const top = Math.max(0, Math.min(y, innerHeight - 44));
    panel.style.top = `${top}px`;
    panel.style.maxHeight = `${innerHeight - top}px`;
  };
  for (const panel of windows) {
    const header = panel.querySelector<HTMLElement>("header")!;
    const body = panel.querySelector<HTMLElement>(".debug-body")!;
    const launcher = root.querySelector<HTMLButtonElement>(
      `[aria-controls="${panel.id}"]`,
    )!;
    let drag: { id: number; x: number; y: number } | undefined;
    panel.addEventListener("pointerdown", () => (panel.style.zIndex = String(++front)));
    launcher.onclick = () => {
      panel.classList.toggle("hidden");
      launcher.setAttribute(
        "aria-expanded",
        String(!panel.classList.contains("hidden")),
      );
      panel.style.zIndex = String(++front);
      if (!panel.classList.contains("hidden"))
        clamp(panel, panel.offsetLeft, panel.offsetTop);
      launcher.blur();
    };
    panel.querySelector<HTMLButtonElement>("[data-debug-hide]")!.onclick = () => {
      panel.classList.add("hidden");
      launcher.setAttribute("aria-expanded", "false");
      launcher.focus();
    };
    const collapse = panel.querySelector<HTMLButtonElement>("[data-debug-collapse]")!;
    collapse.onclick = () => {
      body.hidden = !body.hidden;
      collapse.textContent = body.hidden ? "+" : "−";
      collapse.setAttribute("aria-expanded", String(!body.hidden));
      collapse.setAttribute(
        "aria-label",
        `${body.hidden ? "Expand" : "Collapse"} ${panel.getAttribute("aria-label")}`,
      );
    };
    header.onpointerdown = (event) => {
      if (
        event.button !== 0 ||
        (event.target instanceof Element && event.target.closest("button"))
      )
        return;
      drag = {
        id: event.pointerId,
        x: event.clientX - panel.offsetLeft,
        y: event.clientY - panel.offsetTop,
      };
      header.setPointerCapture(event.pointerId);
      event.preventDefault();
    };
    header.onpointermove = (event) => {
      if (drag?.id === event.pointerId)
        clamp(panel, event.clientX - drag.x, event.clientY - drag.y);
    };
    header.onpointerup =
      header.onpointercancel =
      header.onlostpointercapture =
        () => {
          drag = undefined;
        };
    header.onkeydown = (event) => {
      if (event.target !== header || !event.key.startsWith("Arrow")) return;
      event.preventDefault();
      clamp(
        panel,
        panel.offsetLeft +
          (event.key === "ArrowRight" ? 16 : event.key === "ArrowLeft" ? -16 : 0),
        panel.offsetTop +
          (event.key === "ArrowDown" ? 16 : event.key === "ArrowUp" ? -16 : 0),
      );
    };
  }
  root.addEventListener("keydown", (event) => {
    if (event.key === "Escape" || event.key === "F1") {
      event.preventDefault();
      root.classList.add("hidden");
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    }
    event.stopPropagation();
  });
  root.querySelector<HTMLButtonElement>("#debug-close")!.onclick = () =>
    root.classList.add("hidden");
  root.querySelector<HTMLButtonElement>("#debug-reset")!.onclick = () =>
    windows.forEach((panel, i) => clamp(panel, 24 + i * 34, 140 + i * 28));
  window.addEventListener("resize", () =>
    windows
      .filter((panel) => !panel.classList.contains("hidden"))
      .forEach((panel) =>
        clamp(
          panel,
          Number.parseFloat(panel.style.left),
          Number.parseFloat(panel.style.top),
        ),
      ),
  );
}

export function updateServerStats(element: HTMLElement, stats: ServerDiagnostics) {
  const rows = [
    ["Tick budget", `${stats.tickBudgetMs.toFixed(1)} ms`],
    [
      "Tick CPU p95 / budget",
      `${stats.tickCpuP95Ms.toFixed(1)} ms / ${((100 * stats.tickCpuP95Ms) / stats.tickBudgetMs).toFixed(0)}%`,
    ],
    [
      "Tick wall p95 / max",
      `${stats.tickP95Ms.toFixed(1)} / ${stats.tickMaxMs.toFixed(1)} ms`,
    ],
    [
      "Simulation backlog",
      `${stats.backlogMs.toFixed(1)} ms (${(stats.backlogMs / stats.tickBudgetMs).toFixed(1)} ticks)`,
    ],
    ["Catch-up ticks", String(stats.catchUpTicks)],
    ["Dropped time / overloads", `${stats.droppedMs.toFixed(0)} ms / ${stats.late}`],
    ["Process RSS", `${stats.memoryMB} MiB`],
    [
      "JS heap / limit",
      `${stats.heapUsedMB.toFixed(0)} / ${stats.heapLimitMB.toFixed(0)} MiB`,
    ],
    ["Available memory", `${stats.availableMemoryMB.toFixed(0)} MiB`],
    ["Players / entities", `${stats.players} / ${stats.entities}`],
  ];
  element.replaceChildren(
    ...rows.flatMap(([name, value]) => {
      const dt = document.createElement("dt"),
        dd = document.createElement("dd");
      dt.textContent = name;
      dd.textContent = value;
      return [dt, dd];
    }),
  );
}

/** One collapsible group of teleport buttons per landmark kind; the first is open. */
export function renderAdminPlaces(
  element: HTMLElement,
  groups: AdminPlaceGroup[],
  go: (place: AdminPlace) => void,
) {
  element.replaceChildren(
    ...groups.map((group, i) => {
      const details = document.createElement("details"),
        summary = document.createElement("summary");
      details.open = i === 0;
      summary.textContent = `${group.label} (${group.places.length})`;
      details.append(
        summary,
        ...group.places.map((place) => {
          const button = document.createElement("button");
          button.textContent = place.name;
          button.title = `${group.label} · ${Math.round(place.x)}, ${Math.round(place.z)}`;
          button.onclick = () => {
            go(place);
            button.blur();
          };
          return button;
        }),
      );
      return details;
    }),
  );
  if (!groups.length) element.textContent = "This city has no named places.";
}

/** Other connected players with "Go to" and "Bring here" actions. */
export function renderAdminPlayers(
  element: HTMLElement,
  players: PlayerSummary[],
  self: string | undefined,
  go: (player: PlayerSummary) => void,
  bring: (player: PlayerSummary) => void,
) {
  const others = players.filter((player) => player.id !== self);
  element.replaceChildren(
    ...others.map((player) => {
      const item = document.createElement("li"),
        name = document.createElement("span");
      name.textContent = player.name;
      name.style.borderLeftColor = player.color;
      item.append(
        name,
        ...(
          [
            ["Go to", go],
            ["Bring here", bring],
          ] as const
        ).map(([label, action]) => {
          const button = document.createElement("button");
          button.textContent = label;
          button.setAttribute("aria-label", `${label}: ${player.name}`);
          button.onclick = () => {
            action(player);
            button.blur();
          };
          return button;
        }),
      );
      return item;
    }),
  );
  if (!others.length) {
    const item = document.createElement("li");
    item.textContent = "No other players connected.";
    element.append(item);
  }
}
