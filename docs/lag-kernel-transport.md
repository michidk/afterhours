# Server TCP queue capture

With `ALLOW_DEBUG=1`, `/health` includes `kernelTransport`. Production without
debug enabled omits it. Sampling reads only `/proc/net/tcp` and `/proc/net/tcp6`
asynchronously, on request, and filters established connections to the listening
game port. Errors remain in the result rather than looking like empty queues.

Each sample records its start and completion timestamps. Socket entries report
the send and receive queue sizes in bytes, the active kernel timer, its expiry
in jiffies, and the current retransmission timeout retry count. That retry count
is **not** a cumulative retransmission counter. Addresses retain Linux proc hex
encoding. Debug session transport records include local and remote ports and the
remote address so the game peers can be correlated with these kernel records.

Run `scripts/capture-movement-transport.py` against the deployed release to retain
these fields alongside the unchanged five-person, five-car, and five-plane gates.
A nonempty send queue can include bytes in flight awaiting acknowledgement; it
does not alone prove a server stall or identify which downstream hop delayed
delivery. An empty queue likewise does not prove delivery to the browser when
nginx terminates the server connection. Compare consecutive samples, client
receive counters, accepted snapshot writes, and the sampling interval before
attributing a stall. Sampling itself has overhead and is only enabled for
explicit diagnostic sessions.
