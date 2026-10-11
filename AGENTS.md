# AFTERHOURS development

Keep gameplay authoritative in `server/`. Browser code may interpolate and render cosmetic effects, but must not decide positions, damage, pickups, or ownership. Keep generation deterministic and share its data contract in `shared/`.

Run `bun run test` and `bun run build` after gameplay or protocol changes. Update README controls and limitations when behaviour changes. Production debug tools must remain explicitly opt-in.

Use Conventional Commits: `<type>(<optional scope>): <description>`. Allowed types: feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert. Use an imperative lowercase description, no trailing period, and a subject at most 72 characters. Mark breaking changes with `!` and/or a `BREAKING CHANGE:` footer. Add a body when the reason is not obvious; keep trailers last. Applies to amends, squashes, and reverts too.
