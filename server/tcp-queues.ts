import { readFile } from "node:fs/promises";
import { readSchedulerStats } from "./scheduler-stats.ts";

/** Linux proc addresses stay in their native hex encoding for offline correlation. */
export function parseTcpQueues(table: string, port: number) {
  return table.split("\n").flatMap((line) => {
    const fields = line.trim().split(/\s+/);
    const [, local, remote, state, queues, timer, retransmits] = fields;
    if (!local || !remote || state !== "01" || !queues || !timer || !retransmits)
      return [];
    const [localAddressHex, localPortHex] = local.split(":");
    const [remoteAddressHex, remotePortHex] = remote.split(":");
    const [tx, rx] = queues.split(":");
    const [activeTimer, expires] = timer.split(":");
    const numbers = [
      localPortHex,
      remotePortHex,
      tx,
      rx,
      activeTimer,
      expires,
      retransmits,
    ].map((value) =>
      value && /^[0-9a-f]+$/i.test(value) ? Number.parseInt(value, 16) : NaN,
    );
    if (numbers.some((value) => !Number.isSafeInteger(value)) || numbers[0] !== port)
      return [];
    return [
      {
        localAddressHex,
        localPort: numbers[0],
        remoteAddressHex,
        remotePort: numbers[1],
        sendQueueBytes: numbers[2],
        receiveQueueBytes: numbers[3],
        timer: numbers[4],
        timerExpiresJiffies: numbers[5],
        // This is the current timeout retry count, not cumulative TCP retransmissions.
        retransmitTimeouts: numbers[6],
      },
    ];
  });
}

export async function readTcpQueues(port: number) {
  const startedAt = Date.now();
  const schedulerPending = readSchedulerStats();
  const tables = await Promise.all(
    ["/proc/net/tcp", "/proc/net/tcp6"].map(async (path) => {
      try {
        return { path, sockets: parseTcpQueues(await readFile(path, "utf8"), port) };
      } catch (error) {
        return { path, error: error instanceof Error ? error.message : String(error) };
      }
    }),
  );
  const scheduler = await schedulerPending;
  return { startedAt, completedAt: Date.now(), tables, scheduler };
}
