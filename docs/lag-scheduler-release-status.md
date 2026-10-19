# Scheduler release and browser failure

Scheduler diagnostic commit `7d34079` passed all 444 isolated tests, check/build,
and running production-server opt-in checks. Its
[CI run](https://github.com/michidk/afterhours/actions/runs/39317322098) passed
verification, network tests, and image publishing, but failed the browser job.
The scheduler diagnostic image is not deployed.

The browser failure is the existing scout held-movement gate. It observed a
3.2739 cm rewind during acceleration, beyond its unchanged 1 cm tolerance.
The [complete movement samples](lag-scout-browser-failure.json) retain that
failure. The last rendered positions around the failing transition were
593.413727 m and 593.380988 m. The frame interval was approximately 272 ms,
prediction remained active, both authoritative and predicted collision coverage
were ready, and the new presentation offset was -0.173758 m. A later frame also
recorded a 0.684342 m correction. These samples expose a slow-frame scout
reconciliation problem; they do not establish that the scheduler diagnostic
change caused it. The diagnostic reads are opt-in health sampling, and no
gameplay or client protocol code changed in that commit.

The next task is to reproduce this presentation rewind with a focused behavioral
test and fix its cause without changing the browser or production acceptance
thresholds. The prior production fifteen-client run still fails thirteen clients.

The isolated infrastructure worktree
`/home/vibepod/workspaces/k8s-afterhours-lag` contains an uncommitted image pin to
`ghcr.io/michidk/afterhours:sha-7d34079b54245771fabb37280ff6c838ef087671@sha256:9c039e95608dd01c0040925d03d3a6f6518e1174458a825a7351c26615cf1707`.
The exact pin passed `just verify`, but was not committed or pushed after the
browser failure. Main still runs the earlier kernel transport release.

The offline scheduler-analysis prototype is `/tmp/analyze-scheduler-capture.py`.
Known-counter fixtures checked nanosecond CPU/wait differences, microsecond
pressure differences, and unavailable wait reporting when scheduler accounting
is disabled. It has not analyzed production scheduler data because that release
has not deployed. Do not present those fixtures as production evidence.
