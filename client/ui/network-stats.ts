import type { GameNetwork } from "../network/index.ts";

export function updateNetworkStats(element: HTMLElement, network: GameNetwork) {
  const s = network.stats();
  const ms = (value: number | undefined) =>
    value === undefined ? "—" : `${Math.round(value)} ms`;
  const rows = [
    ["Connection", s.connected ? "Connected" : "Disconnected"],
    ["Last disconnect", s.lastDisconnect ?? "None"],
    ["Server ping (RTT)", ms(s.rtt)],
    ["Ping variation", ms(s.jitter)],
    ["Snapshot age / gap", `${ms(s.snapshotAge)} / ${ms(s.snapshotInterval)}`],
    ["Snapshots / inputs", `${s.snapshotsPerSecond} / ${s.inputsPerSecond} per second`],
    ["Sent / applied input", `${s.seq} / ${s.ack}`],
    ["Applied input age", ms(s.ackAge)],
    ["Pending replay", `${s.pending} inputs`],
    [
      "Server input buffer",
      s.queued === undefined
        ? "—"
        : s.queued < 0
          ? `${-s.queued} ticks ahead on held controls`
          : `${s.queued} commands`,
    ],
    ["Prediction", s.prediction],
    ["Last correction", `${s.correction.toFixed(3)} m / ${s.angle.toFixed(1)}°`],
    ["Visual offset", `${s.offset.toFixed(3)} m`],
    ["Corrections > 0.3 m", String(s.corrections)],
    ["Send buffer", `${s.buffered} bytes`],
    ["Resync requests", String(s.resyncs)],
    ["Server simulation", `${s.serverTime.toFixed(2)} s`],
  ];
  if (!element.childElementCount) {
    for (const [label] of rows) {
      const term = document.createElement("dt"),
        value = document.createElement("dd");
      term.textContent = label;
      element.append(term, value);
    }
  }
  rows.forEach(([, value], i) => {
    element.children[i * 2 + 1].textContent = value;
  });
}
