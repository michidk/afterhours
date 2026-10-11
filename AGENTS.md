# AFTERHOURS development

Read [todo.md](todo.md) before starting work. Always update it as work progresses: add newly discovered gaps, record partial progress, and check off completed items only after verification. Keep unfinished items and their evidence accurate, and include the update in the same commit as the related work. Use `todo.md` as the project backlog instead of recreating `PLAN.md`.

Keep gameplay authoritative in `server/`. Browser movement prediction is provisional and must reconcile with server snapshots; it must never decide final positions, damage, pickups, or ownership. Keep reusable movement and data contracts in `shared/`. Generate cities only through the manual offline script in `scripts/`, persist the versioned artifact, and load it on server startup. Clients receive the loaded city from the server.

Run `bun run test` and `bun run build` after gameplay or protocol changes. Update README controls and limitations when behaviour changes. Production debug tools must remain explicitly opt-in.

Use Conventional Commits: `<type>(<optional scope>): <description>`. Allowed types: feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert. Use an imperative lowercase description, no trailing period, and a subject at most 72 characters. Mark breaking changes with `!` and/or a `BREAKING CHANGE:` footer. Add a body when the reason is not obvious; keep trailers last. Applies to amends, squashes, and reverts too.
