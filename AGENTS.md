# Lina — agent guide

- Read [POLICY.md](POLICY.md) for development, CI, merge and release authority; [CONTRIBUTING.md](CONTRIBUTING.md) is the contribution entry point. Keep repository rules here, not in global client settings.
- Bun workspace; `bun test` / `bun run typecheck` / `bun run lint` from the root.
- Strict TS (see tsconfig.json), Biome, no default exports.
- Codex is the sole execution engine; `lina-codex` owns its RPC adapter and OpenCodex owns provider routing. `lina-runtime/src/host.ts` contains Lina-owned contracts; do not introduce an engine SDK dependency into channels or memory.
- Discord layering: `discord.js` only in `discord/gateway-source.ts`; `lina-channels` never imports `lina-runtime`. QA scripts under `scripts/qa/` are exempt from the discord.js restriction.
- Every behavior change starts with a failing test; tests await signals, never sleep.
- Runtime artifacts (`.lina-sessions`, `data/memory`, `data/notepad.md`) are gitignored.
