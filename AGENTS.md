# Lina — agent guide

- Read [POLICY.md](POLICY.md) for development, CI, merge and release authority; [CONTRIBUTING.md](CONTRIBUTING.md) is the contribution entry point. Keep repository rules here, not in global client settings.
- Engine work follows the [Moirai engine design](docs/MOIRAI_ENGINE.md): three judgment modules with distinct objectives (Clotho: future outcomes, Lachesis: desire and learned preference, Atropos: adopted intentions), Moirai arbitration under a declared policy, Host ownership of records and handoff, and existing owners keeping their sources. The design is confirmed but not implemented; it is not evidence of orchestration, circuit learning or qualification.
- Bun workspace; `bun test` / `bun run typecheck` / `bun run lint` from the root.
- Strict TS (see tsconfig.json), Biome, no default exports.
- Current runtime execution is Codex: `lina-codex` owns its RPC adapter and OpenCodex owns provider routing. The confirmed engine design (D13, D21) selects Senpi as the cognition backend, `omo app-server` as the development-task execution backend behind the existing `TaskManager` contract, and Senpi native provider accounts instead of OpenCodex; Codex CLI and OpenCodex are retired only when the F1–F4 roadmap lands that switch, not through ad-hoc edits. `lina-runtime/src/host.ts` contains Lina-owned contracts; do not introduce an engine SDK dependency into channels or memory.
- Discord layering: `discord.js` only in `discord/gateway-source.ts`; `lina-channels` never imports `lina-runtime`. QA scripts under `scripts/qa/` are exempt from the discord.js restriction.
- Every behavior change starts with a failing test; tests await signals, never sleep.
- Runtime artifacts (`.lina-sessions`, `data/memory`, `data/notepad.md`) are gitignored.
