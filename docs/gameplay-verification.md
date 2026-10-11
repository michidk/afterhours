# Gameplay verification

[CI at `531a9ef`](https://github.com/michidk/afterhours/actions/runs/38180198787) passes all 153 tests, formatting, import boundaries, TypeScript, and the production build. The last local full suite passed 152 tests. The added offshore-camera regression passed separately and is included in the 153-test CI run.

The tests exercise temporary destruction and recovery, saturated corpse retention and settling, names, powered engine routing, model-specific handling, ammo and reloads, grenade contacts and blast seat release, jetpack fuel and prediction, swimming, hull contacts, AI routes, parachutes, and binary protocol updates. `data/city.json` is unchanged against the audit baseline `c2da9ed`.

Headless Chrome checks use a 1280 by 900 viewport because T3 reported no automation host. Split browser runs passed joining and passenger nameplates, disconnect cleanup, firing the new weapons, grenade detonation, ordinary pickup, jetpack ascent and fuel use, parachute deployment and landing, watercraft boarding and controls, animated water, AI cruising, and both helicopter models. The final plane pass at 640 by 450 completed takeoff, steering, descent, airborne exit, and automatic parachute landing for both models without browser exceptions. Captured authority altitudes were 13.523 for the Island Hopper and 16.766 for the Firefly Sport. Screenshots and the dated successful result are in `/tmp/afterhours-plane-check/`; earlier gameplay captures are in `/tmp/afterhours-gameplay-check/`.

The browser check tests observable gameplay, not takeoff performance. On this shared machine the server ran slower than real time and rejected queued inputs while overloaded. At 1280 by 900, software rendering also delayed browser inputs beyond the server's 250 ms safety timeout. A live trace showed idle authority input while browser thrust remained held. The plane stalled and hit an obstacle. Both a native WebSocket pilot and the smaller browser viewport climbed normally. A five-second fixed-step simulation of the saved city reached altitude 18.477 and speed 40.

The browser now holds continuous controls until altitude exceeds 12, with a 60-second timeout. It keeps plane thrust on through the screenshot because idle planes slow and stall. Fixed-step aircraft tests retain the acceleration, climb, descent, stall, clearance, and authority/prediction checks. The server input timeout remains unchanged.

The rerunnable browser check needs an existing debug-enabled server and a headless Chrome CDP endpoint. It imports the environment's fallback helper without adding a browser dependency to the project.

```sh
BROWSER_CDP_HELPER=/home/vibepod/.agents/skills/headless-browser-fallback/scripts/cdp.mjs \
CDP_ENDPOINT=http://127.0.0.1:9226 \
GAME_URL=http://127.0.0.1:35267/ \
BROWSER_GAME_URL=http://172.17.0.1:35267/ \
node --import tsx scripts/browser-gameplay-check.mjs
```

`--transport-only`, `--aircraft-only`, and `--planes-only` repeat smaller stages. `BROWSER_WIDTH=640 BROWSER_HEIGHT=450` reduces the software-rendering workload for aircraft checks. `BROWSER_OUTPUT` selects the artifact directory. A successful run writes dated `result.json`, checkpoint `evidence.json`, and screenshots. Earlier screenshots remain in a reused directory, so only a current successful result proves that run completed. Local artifacts are not durable CI uploads.

The user confirmed real-device listening on 2026-10-11 with no adjustments needed, closing the last unchecked backlog item. Subjective handling on target devices and hardware performance remain unverified. Software rendering and overloaded-server timing are not hardware performance evidence. Water waves are cosmetic over a flat solver surface. Retired corpses settle without wall, actor, or later-impact contacts after leaving the bounded Rapier world.
