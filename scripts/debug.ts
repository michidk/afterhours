import { writeFile } from "node:fs/promises";
import { AgentClient, pause } from "./agent-client.ts";
import { debugCommandSchema } from "../shared/debug.ts";
import { environmentAt } from "../client/lighting/environment.ts";
const [operation = "state", ...args] = process.argv.slice(2);
const client = await AgentClient.connect(process.env.DEBUG_URL);
try {
  if (operation === "day-cycle") {
    const original = await client.command({ kind: "state" });
    const samples = [];
    try {
      for (const hour of [0, 5.5, 6.5, 12, 17.5, 18.5, 23.99]) {
        const state = await client.command({ kind: "time", hour, rate: 0 });
        if (Math.abs(state.day - hour) > 0.001 || state.dayRate !== 0)
          throw Error("Server did not hold fixed time");
        samples.push({
          hour,
          serverDay: state.day,
          environment: environmentAt(state.day),
        });
      }
      const start = await client.command({ kind: "time", hour: 0, rate: 2.4 });
      const cycle = [];
      while (true) {
        await pause(500);
        const state = await client.command({ kind: "state" });
        cycle.push({ time: state.time, hour: state.day });
        const elapsed = state.time - start.time;
        const expected = (elapsed * 2.4) % 24;
        if (Math.abs(state.day - expected) > 0.001) throw Error("Cycle clock drifted");
        if (elapsed > 10.1) break;
      }
      const report = {
        date: new Date().toISOString(),
        passed: true,
        samples,
        cycle,
        scope:
          "Authoritative fixed times and complete cycle; screenshots recorded separately",
      };
      await writeFile(
        "docs/day-night-test.json",
        JSON.stringify(report, null, 2) + "\n",
      );
      console.log(JSON.stringify(report, null, 2));
    } finally {
      await client.command({
        kind: "time",
        hour: original.day,
        rate: original.dayRate,
      });
    }
  } else if (operation === "move") {
    const directions: Record<string, object> = {
      forward: { up: true },
      back: { down: true },
      left: { left: true },
      right: { right: true },
    };
    if (!directions[args[0]]) throw Error("Use move forward|back|left|right seconds");
    await client.move(directions[args[0]], Number(args[1] || 1));
    console.log(JSON.stringify(await client.command({ kind: "state" }), null, 2));
  } else if (["interact", "drop", "reload"].includes(operation)) {
    client.send({ type: operation });
    await pause(150);
    console.log(JSON.stringify(await client.command({ kind: "state" }), null, 2));
  } else {
    const command = debugCommandSchema.parse(
      operation === "time"
        ? {
            kind: "time",
            hour: Number(args[0]),
            rate: args[1] === undefined ? 0 : Number(args[1]),
          }
        : operation === "teleport"
          ? { kind: "teleport", x: Number(args[0]), z: Number(args[1]) }
          : operation === "spawn"
            ? { kind: "spawn", model: args[0] }
            : { kind: operation },
    );
    console.log(JSON.stringify(await client.command(command), null, 2));
  }
} finally {
  client.close();
}
