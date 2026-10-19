import { readFile } from "node:fs/promises";

/** Fixed unprivileged Linux counters; raw integer text preserves nanosecond precision. */
export async function readSchedulerStats() {
  const startedAt = Date.now();
  const counters = await Promise.all(
    [
      "/proc/self/schedstat",
      "/proc/sys/kernel/sched_schedstats",
      "/sys/fs/cgroup/cpu.stat",
      "/sys/fs/cgroup/cpu.pressure",
      "/sys/fs/cgroup/cpu.max",
      "/sys/fs/cgroup/cpu.weight",
    ].map(async (path) => {
      const at = Date.now();
      try {
        const text = await readFile(path, "utf8");
        return { path, at, completedAt: Date.now(), text };
      } catch (error) {
        return {
          path,
          at,
          completedAt: Date.now(),
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );
  return { startedAt, completedAt: Date.now(), counters };
}
