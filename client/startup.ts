interface ReadyMesh {
  isReady(completeCheck: boolean): boolean;
}
interface StartupScene {
  render(): void;
  getWaitingItemsCount(): number;
  getActiveMeshes(): { data: ReadyMesh[]; length: number };
}
interface StartupEngine {
  runRenderLoop(callback: () => void): void;
  stopRenderLoop(callback: () => void): void;
}

/** Warm the visible frame, not every shader variant in the streamed neighbourhood. */
export function prepareFirstFrame(
  engine: StartupEngine,
  scene: StartupScene,
  report: (message: string) => void,
  timeoutMs = 60000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let readyFrames = 0;
    let finished = false;
    let checked = 0;
    let total = 0;
    const started = performance.now();
    let lastReport = started;
    const finish = (error?: unknown) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      engine.stopRenderLoop(render);
      if (error !== undefined) reject(error);
      else resolve();
    };
    const render = () => {
      try {
        scene.render();
        const active = scene.getActiveMeshes();
        total = active.length;
        checked = 0;
        // Check all active meshes so compilation starts in parallel. Babylon's
        // active list includes visible geometry whose material is still compiling.
        for (let i = 0; i < total; i++) if (active.data[i].isReady(true)) checked++;
        const ready =
          total > 0 && checked === total && scene.getWaitingItemsCount() === 0;
        readyFrames = ready ? readyFrames + 1 : 0;
        // The second ready frame has actually rendered the prepared shaders.
        if (readyFrames >= 2) finish();
        else if (performance.now() - lastReport >= 500) {
          report(
            `Preparing the first frame… ${checked}/${total} visible objects ready`,
          );
          lastReport = performance.now();
        }
      } catch (error) {
        finish(error);
      }
    };
    const timer = setTimeout(
      () =>
        finish(
          Error(
            `First frame preparation timed out (${checked}/${total} visible objects ready). Check browser graphics acceleration and refresh.`,
          ),
        ),
      timeoutMs,
    );
    engine.runRenderLoop(render);
  });
}
