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

`kernelTransport.scheduler` adds fixed, unprivileged Linux scheduler and cgroup
counter reads. Each read retains its own request/completion timestamps and raw
integer text, or an explicit error. `/proc/self/schedstat` describes the main
thread: cumulative execution nanoseconds, runnable wait nanoseconds, and
timeslices. Compare counter differences between samples, rather than interpreting
the cumulative values as a single pause. Check `/proc/sys/kernel/sched_schedstats`
first: when it is `0`, a zero wait counter cannot rule out scheduler contention.

For cgroup v2, `cpu.stat` reports cumulative CPU usage and quota throttling in
microseconds. `cpu.pressure` reports cumulative pressure in microseconds along
with its rolling averages; cgroup pressure includes every thread in the game
container and is not specific to the main thread. `cpu.max` and `cpu.weight`
record the effective quota and scheduling weight. Missing cgroup v2 files remain
explicit errors. These files are read-only diagnostics and do not enable kernel
accounting, change priority, or alter resource limits. Slow observation intervals
cannot precisely attribute an individual stall.
