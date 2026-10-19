# Scout rewind reproduction status

The original CI failure remains in `lag-scout-browser-failure.json`. The rendered
scout moved backwards 3.27 cm during a roughly 272 ms render gap. This exceeds
the unchanged 1 cm movement gate.

Three subsequent Docker browser repetitions passed all existing scout gates.
Their captured Prediction input/reconcile/render calls reproduced their positions
exactly offline, with maximum position error zero and minimum forward step zero.
The recordings contain 157, 165, and 138 calls. This validates the recorder for
these runs; it does not reproduce or resolve the original intermittent rewind.
A prior recorded run failed the existing travel-distance gate at 7.6896 m,
while its replay also matched exactly and showed no rewind.

The browser test now attaches the complete call recording, initial prediction
state, and collision city before movement assertions. Actual callback times are
included so later delivery experiments can preserve input callback order rather
than infer it from scheduled input timestamps. Maps and Sets retain their contents
through tagged JSON serialization. Recording runs only inside the test.

The Docker browser startup deadline now matches the existing production startup
allowance of 600 seconds, because city generation and mesh baking precede health
readiness. The non-Docker deadline and all gameplay and latency gates are unchanged.

Raw recordings remain in the isolated worktree at
`.codex/scout-replay-captures/first` and
`.codex/scout-replay-captures/repeat-three`. The latter contains all three passing
repetitions. Do not use these local runs as production acceptance evidence. The
last public five-person/car/plane run still failed 13 of 15 clients.
