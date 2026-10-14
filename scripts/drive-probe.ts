// Deterministic virtual-time probe: one driver at full speed over a jittered link,
// watched by an observer on a clean link. Counts server input speculation,
// mispredictions, catch-ups and drops, the rendered lurches, freezes and
// corrections the driver would see, and the stutter the observer would see.
// Virtual clocks make the result independent of machine speed, so it doubles as
// a regression fixture.
import { createServer } from "node:http";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import { GameNetwork } from "../client/network/index.ts";
import { InputClock } from "../client/input/clock.ts";
import { Simulation } from "../server/simulation.ts";
import { Sessions } from "../server/session.ts";
import { CityStore } from "../server/city-stream.ts";
import { generateCity } from "./city-generator.ts";
import { idle } from "../shared/world.ts";
import { TUNING, VEHICLES } from "../shared/catalog.ts";

export interface LinkProfile {
  /** Fixed one-way delay in milliseconds. */
  base: number;
  /** Uniform random delay added to every packet. */
  spread: number;
  /** Extra delay of an occasional late packet. */
  spike: number;
  /** Probability that a packet is a spike. */
  p: number;
}
export const LINK_PROFILES: Record<string, LinkProfile> = {
  none: { base: 0, spread: 0, spike: 0, p: 0 },
  lan: { base: 5, spread: 3, spike: 0, p: 0 },
  mild: { base: 25, spread: 15, spike: 0, p: 0 },
  moderate: { base: 40, spread: 40, spike: 0, p: 0 },
  spiky: { base: 40, spread: 20, spike: 120, p: 0.03 },
  wan: { base: 80, spread: 30, spike: 150, p: 0.02 },
};
export interface ProbeOptions {
  profile?: keyof typeof LINK_PROFILES | LinkProfile;
  model?: "sport" | "sedan";
  /** Simulated seconds of held throttle. */
  seconds?: number;
  /** Client wakeup period in milliseconds (16 approximates a 60 fps browser). */
  wakeup?: number;
  /** Milliseconds added to every server tick period: a slow or fast server clock. */
  serverSlow?: number;
  /** Attach the input clock to snapshot buffer reports. */
  regulate?: boolean;
  seed?: number;
}
interface Link {
  outgoing: { at: number; data: Parameters<WebSocket["send"]>[0] }[];
  incoming: { at: number; event: MessageEvent }[];
  send: WebSocket["send"];
  receive: NonNullable<WebSocket["onmessage"]>;
  socket: WebSocket;
  peer: import("ws").WebSocket;
  arrived?: () => void;
}
export async function probeDriving(options: ProbeOptions = {}) {
  const link =
    typeof options.profile === "object"
      ? options.profile
      : LINK_PROFILES[options.profile ?? "moderate"];
  if (!link) throw Error(`unknown link profile ${String(options.profile)}`);
  const model = options.model ?? "sport",
    seconds = options.seconds ?? 15,
    wakeup = options.wakeup ?? 16,
    serverSlow = options.serverSlow ?? 0,
    regulate = options.regulate ?? true;
  // Seeded LCG so runs are repeatable.
  let state = options.seed ?? 12345;
  const rand = () => (state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const delay = () =>
    link.base + rand() * link.spread + (rand() < link.p ? link.spike : 0);

  const city = generateCity();
  city.props = [];
  city.buildings = [];
  const sim = new Simulation(city);
  sim.entities.clear();
  const server = createServer();
  const sessions = new Sessions(server, sim, false, new CityStore(city).manifest);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw Error("no address");
  const location = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { protocol: "http:", host: `127.0.0.1:${address.port}` },
  });
  let now = 0;
  const epoch = Date.now();
  const realPerformanceNow = performance.now,
    realDateNow = Date.now;
  performance.now = () => now;
  Date.now = () => epoch + now;

  const join = async (name: string) => {
    let ready!: () => void;
    const welcome = new Promise<void>((resolve) => (ready = resolve));
    const network = new GameNetwork(
      { welcome: ready, state() {}, chat() {}, status() {} },
      name,
      "#ffffff",
      city,
    );
    network.connect();
    await welcome;
    return network;
  };
  const networks: GameNetwork[] = [];
  try {
    const driver = await join("Driver");
    networks.push(driver);
    const player = sim.entities.get(driver.playerId)!;
    player.x = player.z = 0;
    const car = sim.spawn("car", 0, 0, undefined, model);
    car.driver = player.id;
    player.vehicle = car.id;
    player.seat = 0;
    const observer = await join("Observer");
    networks.push(observer);
    const watcher = sim.entities.get(observer.playerId)!;
    watcher.x = 0;
    watcher.z = -40;
    // The observer is carried 40 m behind the car by authority so the car never
    // leaves its interest radius; it sends no commands of its own.
    const follow = () => {
      watcher.x = car.x;
      watcher.z = car.z - 40;
      watcher.vx = car.vx;
      watcher.vz = car.vz;
    };
    const peers = [...sessions.clients.keys()];
    const links: Link[] = networks.map((network, i) => {
      const socket = network.socket!;
      const entry: Link = {
        outgoing: [],
        incoming: [],
        send: socket.send.bind(socket),
        receive: socket.onmessage!,
        socket,
        peer: peers[i],
      };
      const impaired = i === 0;
      socket.send = (data) =>
        entry.outgoing.push({
          at: Math.max(entry.outgoing.at(-1)?.at ?? 0, now + (impaired ? delay() : 0)),
          data,
        });
      socket.onmessage = (event) => {
        entry.incoming.push({
          at: Math.max(entry.incoming.at(-1)?.at ?? 0, now + (impaired ? delay() : 0)),
          event,
        });
        if (event.data instanceof ArrayBuffer) entry.arrived?.();
      };
      return entry;
    });
    const session = sessions.clients.get(peers[0])!;
    const broadcast = async () => {
      const deliveries = links.map(
        (entry) =>
          new Promise<void>((resolve) => {
            entry.arrived = resolve;
          }),
      );
      sessions.broadcast();
      await Promise.all(deliveries);
      for (const entry of links) entry.arrived = undefined;
    };
    sim.tick(1 / 30);
    await broadcast();
    for (const entry of links)
      while (entry.incoming.length)
        entry.receive.call(entry.socket, entry.incoming.shift()!.event);
    const clock = new InputClock();
    if (regulate) driver.clock = clock;
    const tickMs = TUNING.tick * 1000 + serverSlow;
    let tick = 0,
      dryTicks = 0,
      queueDepthSum = 0,
      queueDepthMax = 0,
      ahead = 0,
      maxAhead = 0;
    const frames: { at: number; z: number; speed: number; seen: number | undefined }[] =
      [];
    const corrections: number[] = [];
    const trace: object[] = [];
    let lastCorrectionCount = 0;
    let maxOffset = 0;
    const limit = VEHICLES[model].speed;
    for (now = 0; now <= seconds * 1000; now++) {
      if (now % wakeup === 0)
        clock.advance(now, (timestamp) =>
          driver.input({ ...idle(), up: true }, timestamp),
        );
      for (const entry of links)
        while (entry.outgoing[0]?.at <= now) {
          const delivered = once(entry.peer, "message");
          entry.send(entry.outgoing.shift()!.data);
          await delivered;
        }
      if (now + 1e-6 >= tick * tickMs) {
        const depth = session.queue.length;
        queueDepthSum += depth;
        queueDepthMax = Math.max(queueDepthMax, depth);
        if (depth === 0) dryTicks++;
        follow();
        sessions.tick();
        ahead = session.speculative > 0 ? ahead + 1 : 0;
        maxAhead = Math.max(maxAhead, ahead);
        sim.tick(1 / 30);
        follow();
        if (tick % 2 === 0) await broadcast();
        tick++;
      }
      for (const entry of links)
        while (entry.incoming[0]?.at <= now)
          entry.receive.call(entry.socket, entry.incoming.shift()!.event);
      if (now % 16 === 0) {
        const pose = driver.renderEntities(now).find((e) => e.id === car.id)!;
        const seen = observer.renderEntities(now).find((e) => e.id === car.id);
        frames.push({
          at: now,
          z: pose.z,
          speed: Math.hypot(pose.vx, pose.vz),
          seen: seen?.z,
        });
        const p = driver.prediction!;
        if (p.corrections !== lastCorrectionCount) {
          corrections.push(p.lastCorrection.distance);
          lastCorrectionCount = p.corrections;
          trace.push({
            at: now,
            correction: +p.lastCorrection.distance.toFixed(3),
            ack: driver.ack,
            nextSeq: driver.seq,
            pending: p.pending.map((f) => f.seq),
            speculative: session.speculative,
            queued: session.queued,
            offset: +Math.hypot(p.offset.x, p.offset.z).toFixed(3),
          });
        }
        maxOffset = Math.max(maxOffset, Math.hypot(p.offset.x, p.offset.z));
      }
    }
    // Cruise analysis starts half a second after the car first reaches its limit.
    const cruiseStart = frames.find((f) => f.speed >= limit * 0.98)?.at ?? Infinity;
    const cruise = frames.filter((f) => f.at >= cruiseStart + 500);
    const expected = limit * 0.016;
    const steps = (key: "z" | "seen") => {
      let backward = 0,
        surges = 0,
        dips = 0,
        maxStep = 0,
        minStep = Infinity,
        count = 0;
      for (let i = 1; i < cruise.length; i++) {
        const a = cruise[i - 1][key],
          b = cruise[i][key];
        if (a === undefined || b === undefined) continue;
        const step = b - a;
        count++;
        maxStep = Math.max(maxStep, step);
        minStep = Math.min(minStep, step);
        if (step < -0.005) backward++;
        // Ignore floating-point noise exactly at a movement threshold.
        if (step > expected * 1.5 + 1e-9) surges++;
        if (step < expected * 0.5 - 1e-9) dips++;
      }
      return {
        frames: count,
        maxStep: +maxStep.toFixed(3),
        minStep: +(minStep === Infinity ? 0 : minStep).toFixed(3),
        backward,
        surges,
        dips,
      };
    };
    const local = steps("z"),
      remote = steps("seen");
    return {
      profile:
        typeof options.profile === "object"
          ? "custom"
          : (options.profile ?? "moderate"),
      model,
      wakeup,
      serverSlow,
      regulate,
      ticks: tick,
      inputsSent: driver.seq,
      /** Commands the authority acknowledged; never more than the client sent. */
      applied: session.ack + 1,
      server: {
        dryTicks,
        speculated: sessions.speculated,
        mispredicted: sessions.mispredicted,
        frozen: sessions.frozen,
        /** Longest run of consecutive ticks the server stayed ahead on held controls. */
        maxAhead,
        dropped: sessions.dropped,
        queueDepthMean: +(queueDepthSum / tick).toFixed(2),
        queueDepthMax,
      },
      client: {
        corrections: driver.prediction!.corrections,
        correctionsOver1m: corrections.filter((c) => c > 1).length,
        maxCorrection: +Math.max(0, ...corrections).toFixed(3),
        maxOffset: +maxOffset.toFixed(3),
      },
      cruise: {
        speed: +limit.toFixed(1),
        expectedStep: +expected.toFixed(3),
        ...local,
      },
      /** The observer's view of the car from a clean link: server-side stutter only. */
      remote,
      finalAuthorityZ: +car.z.toFixed(1),
      /** One entry per correction: what the client and server believed at that moment. */
      trace,
    };
  } finally {
    for (const network of networks) network.close();
    sessions.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    sim.destruction.dispose();
    performance.now = realPerformanceNow;
    Date.now = realDateNow;
    if (location) Object.defineProperty(globalThis, "location", location);
    else Reflect.deleteProperty(globalThis, "location");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (name: string, fallback: string) => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : fallback;
  };
  const report = await probeDriving({
    profile: arg("profile", "spiky") as keyof typeof LINK_PROFILES,
    model: arg("model", "sport") as "sport" | "sedan",
    seconds: Number(arg("seconds", "15")),
    wakeup: Number(arg("wakeup", "16")),
    serverSlow: Number(arg("server-slow", "0")),
    regulate: arg("regulate", "1") === "1",
  });
  console.log(JSON.stringify(report, null, 1));
}
