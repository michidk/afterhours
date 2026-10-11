import "./style.css";
import { CityScene } from "./scene";
import { district, idle, LIMIT, ROADS, type Entity } from "../shared/world";
const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `<section class="overlay" id="entry"><div class="intro"><div class="eyebrow">ONE CITY. ENDLESS POSSIBILITIES.</div><h1 class="brand">AFTER<span>HOURS</span></h1><p class="tagline">Nowhere to be.<br>Everything to get into.</p><p class="muted">A living city. A stolen car. A story worth sharing.<br>Find your people. Take the long way home.</p><form class="entry" id="join"><label for="name">WHAT DO THEY CALL YOU?</label><input id="name" maxlength="18" placeholder="Your street name" autocomplete="nickname" required value="Stranger"><label style="margin-top:20px">PICK YOUR COLOUR</label><div class="swatches" role="group" aria-label="Character colour">${["#e8b63f", "#e86551", "#55a9b8", "#a995c9", "#80a177"].map((c, i) => `<button type="button" class="swatch ${i === 0 ? "selected" : ""}" style="background:${c}" data-color="${c}" aria-label="${["Gold", "Coral", "Teal", "Lavender", "Sage"][i]}" aria-pressed="${i === 0}"></button>`).join("")}</div><button class="primary" id="play" disabled>Warming up the city…</button><div class="entry-footer"><span class="online">● SHARED CITY</span><span>NO ACCOUNT. JUST A NAME.</span></div><div class="loading" id="loading">Building neighbourhoods…<div class="progress"><i style="width:15%"></i></div></div></form><p class="muted" style="font-size:10px;letter-spacing:1px">DESKTOP PLAYTEST · WASD TO MOVE · F TO ENTER A VEHICLE</p></div><div class="corner"><strong>PALOMA ISLAND</strong><small>EVERY NIGHT HAS A STORY / EARLY BUILD 0.1</small></div></section>
<section class="hud hidden" id="hud"><div class="topbar"><div class="logo">AFTER<span>HOURS</span></div><div class="stats"><div class="panel"><span class="dot"></span><span id="population">1</span> IN THE CITY</div><div class="panel" id="clock">16:30</div></div></div><div class="chat panel"><div class="messages" id="messages"><p><b>Paloma Radio</b> Welcome to the neighbourhood.</p></div><input id="chat" placeholder="Enter to chat…" maxlength="160" aria-label="Chat message"></div><div class="location"><canvas id="minimap" width="220" height="220"></canvas><div class="district panel"><small>PALOMA ISLAND</small><strong id="district">LITTLE HAVANA</strong><p id="street">Paloma Avenue</p></div></div><div class="controls"><div class="panel"><div class="speed"><span id="speed">0</span> <small id="unit">KM/H</small></div><div id="weapon">FISTS</div><div class="health"><i id="health" style="width:100%"></i></div><br></div><div class="panel" id="prompt"><kbd>F</kbd> Enter vehicle / pick up weapon</div><div class="panel"><kbd>W A S D</kbd> Move &nbsp; <kbd>SPACE</kbd> Sprint / handbrake<br><br><kbd>J</kbd> Attack &nbsp; <kbd>H</kbd> Help &nbsp; <kbd>F1</kbd> Debug</div></div><div class="debug panel hidden" id="debug"><h3>DEVELOPER GARAGE</h3><p>Server-authorized sandbox tools</p>${["car", "helicopter", "plane", "pistol", "bat", "heal", "day", "night"].map((kind) => `<button data-spawn="${kind}">${kind.toUpperCase()}</button>`).join("")}</div><div class="help panel hidden" id="help"><h3>YOUR CITY. YOUR RULES.</h3><p><kbd>W A S D</kbd> Walk / throttle and steer<br><kbd>SPACE</kbd> Sprint / handbrake<br><kbd>F</kbd> Enter / exit / pick up<br><kbd>J</kbd> Punch / fire in facing direction<br><kbd>E</kbd> Climb in aircraft<br><kbd>Q</kbd> Descend in aircraft<br><kbd>ENTER</kbd> Chat<br><kbd>F1</kbd> Development garage</p><p>Planes need speed before climbing. Land before exiting. Golden pads contain weapons. Ramps launch fast cars.</p><button id="closehelp">BACK TO THE STREETS</button></div><div class="toast panel hidden" id="toast"></div></section>`;
const $ = <T extends HTMLElement = HTMLElement>(s: string) =>
  document.querySelector<T>(s)!;
let selected = "#e8b63f",
  socket: WebSocket | undefined,
  playerId: string | undefined,
  entities: Entity[] = [],
  joined = false,
  debugAllowed = false,
  scene: CityScene;
const keys = new Set<string>();
let toastTimer: ReturnType<typeof setTimeout>;
document.querySelector("#boot")?.remove();
function toast(message: string) {
  $("#toast").textContent = message;
  $("#toast").classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("#toast").classList.add("hidden"), 4000);
}
function send(data: unknown) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(data));
}
for (const swatch of document.querySelectorAll<HTMLButtonElement>(".swatch"))
  swatch.onclick = () => {
    selected = swatch.dataset.color!;
    for (const s of document.querySelectorAll(".swatch")) {
      s.classList.remove("selected");
      s.setAttribute("aria-pressed", "false");
    }
    swatch.classList.add("selected");
    swatch.setAttribute("aria-pressed", "true");
  };
function loading(text: string, progress: number) {
  $("#loading").innerHTML =
    `${text}<div class="progress"><i style="width:${progress}%"></i></div>`;
}
$("#join").addEventListener("submit", (event) => {
  event.preventDefault();
  if (!scene) return;
  $("#play").setAttribute("disabled", "");
  loading("Connecting to Paloma Island…", 80);
  socket = new WebSocket(
    `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`,
  );
  let welcome = false;
  const timeout = setTimeout(() => {
    if (!welcome) socket?.close();
  }, 10000);
  socket.onopen = () =>
    send({
      type: "join",
      name: $<HTMLInputElement>("#name").value,
      color: selected,
    });
  socket.onmessage = (event) => {
    const m = JSON.parse(event.data);
    if (m.type === "welcome") {
      clearTimeout(timeout);
      welcome = true;
      playerId = m.id;
      debugAllowed = m.debug;
      joined = true;
      $("#entry").classList.add("hidden");
      $("#hud").classList.remove("hidden");
      toast("Welcome to Paloma. There’s a car just across the street.");
    }
    if (m.type === "state") {
      entities = m.entities;
      scene.time = m.time;
      scene.day = m.day;
      $("#population").textContent = m.players;
      for (const e of m.events) scene.effect(e);
    }
    if (m.type === "chat") {
      const p = document.createElement("p"),
        b = document.createElement("b");
      b.textContent = m.name + ": ";
      p.append(b, document.createTextNode(m.text));
      $("#messages").append(p);
      while ($("#messages").children.length > 6)
        $("#messages").firstChild?.remove();
    }
  };
  socket.onclose = () => {
    clearTimeout(timeout);
    joined = false;
    keys.clear();
    $("#entry").classList.remove("hidden");
    $("#hud").classList.add("hidden");
    $("#play").removeAttribute("disabled");
    $("#play").textContent = "Rejoin the city →";
    loading("Connection closed. Your city is one click away.", 100);
  };
  socket.onerror = () =>
    loading("Unable to connect. Check that the game server is running.", 100);
});
window.addEventListener("keydown", (event) => {
  const typing = document.activeElement?.tagName === "INPUT";
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
  keys.add(event.code);
  if (event.repeat) return;
  if (event.code === "KeyF") send({ type: "interact" });
  if (event.code === "F1") {
    if (debugAllowed) $("#debug").classList.toggle("hidden");
    else toast("The development garage is disabled on this server.");
  }
  if (event.code === "KeyH") $("#help").classList.toggle("hidden");
  if (event.code === "Enter") {
    $<HTMLInputElement>("#chat").focus();
    keys.clear();
  }
  if (event.code === "Escape") {
    $("#debug").classList.add("hidden");
    $("#help").classList.add("hidden");
  }
});
window.addEventListener("keyup", (e) => keys.delete(e.code));
window.addEventListener("blur", () => {
  keys.clear();
  send({ type: "input", ...idle() });
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    keys.clear();
    send({ type: "input", ...idle() });
  }
});
$("#closehelp").onclick = () => $("#help").classList.add("hidden");
for (const button of document.querySelectorAll<HTMLButtonElement>(
  "[data-spawn]",
))
  button.onclick = () => send({ type: "debug", kind: button.dataset.spawn });
setInterval(() => {
  if (joined)
    send({
      type: "input",
      up: keys.has("KeyW") || keys.has("ArrowUp"),
      down: keys.has("KeyS") || keys.has("ArrowDown"),
      left: keys.has("KeyA") || keys.has("ArrowLeft"),
      right: keys.has("KeyD") || keys.has("ArrowRight"),
      brake: keys.has("Space"),
      ascend: keys.has("KeyE"),
      descend: keys.has("KeyQ"),
      attack: keys.has("KeyJ"),
    });
}, 1000 / 30);
const map = $<HTMLCanvasElement>("#minimap").getContext("2d")!;
function drawMap(p: Entity) {
  const scale = 0.9;
  map.fillStyle = "#80917a";
  map.fillRect(0, 0, 220, 220);
  map.save();
  map.translate(110 - p.x * scale, 110 + p.z * scale);
  map.scale(scale, -scale);
  map.fillStyle = "#4e6060";
  for (const r of ROADS) {
    map.fillRect(r - 9, -LIMIT, 18, LIMIT * 2);
    map.fillRect(-LIMIT, r - 9, LIMIT * 2, 18);
  }
  map.fillStyle = "#c7c6b1";
  for (const b of scene.city.buildings)
    map.fillRect(b.x - b.w / 2, b.z - b.d / 2, b.w, b.d);
  for (const e of entities) {
    if (e.kind === "pedestrian") continue;
    map.fillStyle = e.kind === "player" ? "#fff8de" : "#efbd66";
    map.beginPath();
    map.arc(e.x, e.z, e.kind === "player" ? 3 : 2, 0, 7);
    map.fill();
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
    scene = new CityScene($<HTMLCanvasElement>("#world"));
    loading("Painting storefronts and planting palms…", 55);
    await scene.scene.whenReadyAsync();
    loading("City ready. Your story starts here.", 100);
    $("#play").textContent = "Enter the city →";
    $("#play").removeAttribute("disabled");
    let last = performance.now(),
      ui = 0;
    scene.engine.runRenderLoop(() => {
      const now = performance.now(),
        dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (!joined) scene.time += dt;
      scene.update(entities, playerId, dt);
      scene.scene.render();
      ui += dt;
      if (ui > 0.1 && joined) {
        ui = 0;
        const p = entities.find((e) => e.id === playerId);
        if (!p) return;
        const v = entities.find((e) => e.id === p.vehicle);
        $("#speed").textContent = String(
          Math.round(Math.hypot(v?.vx || 0, v?.vz || 0) * 3.6),
        );
        $("#unit").textContent = v ? "KM/H" : "ON FOOT";
        $("#weapon").textContent = p.down
          ? "RECOVERING…"
          : (v?.kind || p.weapon || "fists").toUpperCase();
        $("#health").style.width = `${p.health}%`;
        $("#district").textContent = district(p.x, p.z);
        $("#street").textContent =
          `${Math.abs(p.x) < 12 ? "Paloma Avenue" : "Island streets"} · ${v ? "Cruising" : "On foot"}`;
        $("#clock").textContent =
          `${String(Math.floor(scene.day)).padStart(2, "0")}:${String(Math.floor((scene.day % 1) * 60)).padStart(2, "0")}`;
        $("#prompt").innerHTML = v
          ? `<kbd>F</kbd> Exit ${v.kind}${v.kind !== "car" ? " · E / Q altitude" : ""}`
          : "<kbd>F</kbd> Enter vehicle / pick up weapon";
        drawMap(p);
      }
    });
  } catch (error) {
    loading(
      "Could not start 3D rendering. Try a browser with WebGL enabled.",
      0,
    );
    console.error(error);
  }
}
void boot();
