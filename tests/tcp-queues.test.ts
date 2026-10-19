import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, connect } from "node:net";
import { once } from "node:events";
import { parseTcpQueues, readTcpQueues } from "../server/tcp-queues.ts";

test("TCP queues decode bytes and timeout counts without including other ports", () => {
  const row =
    "0: 0100007F:1435 0100007F:C001 01 00000200:00000010 01:0000002A 00000002 1000 0 123";
  assert.deepEqual(parseTcpQueues(row, 5173), [
    {
      localAddressHex: "0100007F",
      localPort: 5173,
      remoteAddressHex: "0100007F",
      remotePort: 49153,
      sendQueueBytes: 512,
      receiveQueueBytes: 16,
      timer: 1,
      timerExpiresJiffies: 42,
      retransmitTimeouts: 2,
    },
  ]);
  assert.deepEqual(parseTcpQueues(row, 80), []);
  assert.deepEqual(parseTcpQueues(row.replace(" 01 ", " 0A "), 5173), []);
  assert.deepEqual(parseTcpQueues(row.replace("00000200", "invalid"), 5173), []);
});

test(
  "kernel sampling finds a real connected socket",
  { skip: process.platform !== "linux" },
  async (t) => {
    const server = createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const accepted = once(server, "connection");
    const client = connect(address.port, "127.0.0.1");
    const connected = once(client, "connect");
    const [peer] = await accepted;
    await connected;
    t.after(() => {
      client.destroy();
      peer.destroy();
      server.close();
    });
    const sample = await readTcpQueues(address.port);
    const sockets = sample.tables.flatMap((table) => table.sockets ?? []);
    assert.ok(sockets.some((socket) => socket.remotePort === client.localPort));
    assert.ok(sample.completedAt >= sample.startedAt);
  },
);
