// WebSockets preserve packet order even when jitter gives packets the same deadline.
export class OrderedDelay {
  private queue: { at: number; deliver: () => void }[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;

  schedule(at: number, deliver: () => void) {
    this.queue.push({ at, deliver });
    if (this.timer === undefined) this.arm();
  }

  clear() {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.queue = [];
  }

  private arm() {
    const first = this.queue[0];
    if (!first) return;
    this.timer = setTimeout(
      () => {
        while (this.queue[0] && this.queue[0].at <= performance.now()) {
          this.queue.shift()!.deliver();
        }
        this.timer = undefined;
        this.arm();
      },
      Math.max(0, Math.ceil(first.at - performance.now())),
    );
  }
}
