# Lina — agent guide

- Read [POLICY.md](POLICY.md) for development, CI, merge and release authority; [CONTRIBUTING.md](CONTRIBUTING.md) is the contribution entry point. Keep repository rules here, not in global client settings.
- Engine work follows the [Moirai engine design](docs/MOIRAI_ENGINE.md): three judgment modules with distinct objectives (Clotho: future outcomes, Lachesis: desire and learned preference, Atropos: adopted intentions), Moirai arbitration under a declared policy, Host ownership of records and handoff, and existing owners keeping their sources. F1 common contracts are implemented; product integration remains planned, and this is not evidence of orchestration, circuit learning or qualification.
- Bun workspace; `bun test` / `bun run typecheck` / `bun run lint` from the root.
- Strict TS (see tsconfig.json), Biome, no default exports.
- Codex owns current and planned cognition/task execution: `lina-codex` owns the RPC adapter and TaskManager contract; OpenCodex owns provider routing. Moirai D22 supersedes the Senpi/OMO migration in D13/D21. Preserve Codex/OpenCodex and existing data. `lina-runtime/src/host.ts` contains Lina-owned contracts; do not introduce an engine SDK dependency into channels or memory.
- Discord layering: `discord.js` only in `discord/gateway-source.ts`; `lina-channels` never imports `lina-runtime`. QA scripts under `scripts/qa/` are exempt from the discord.js restriction.
- Every behavior change starts with a failing test; tests await signals, never sleep.
- Runtime artifacts (`.lina-sessions`, `data/memory`, `data/notepad.md`) are gitignored.
