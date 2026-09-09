# Lina — agent guide

- Read [POLICY.md](POLICY.md) for development, CI, merge and release authority; [CONTRIBUTING.md](CONTRIBUTING.md) is the contribution entry point. Keep repository rules here, not in global client settings.
- Development priority: implement the [core adoption engine](docs/plans/agent-experience/000_plan.md#개발-우선순위) first. Read its [research and design conclusions](docs/plans/agent-experience/003_research_conclusions.md) before planning engine work; independent feature expansion must not displace this priority or add bypass paths. The linked plan owns scope, necessary maintenance exceptions, and completion criteria.
- Bun workspace; `bun test` / `bun run typecheck` / `bun run lint` from the root.
- Strict TS (see tsconfig.json), Biome, no default exports.
- Codex is the sole execution engine; `lina-codex` owns its RPC adapter and OpenCodex owns provider routing. `lina-runtime/src/host.ts` contains Lina-owned contracts; do not introduce an engine SDK dependency into channels or memory.
- Discord layering: `discord.js` only in `discord/gateway-source.ts`; `lina-channels` never imports `lina-runtime`. QA scripts under `scripts/qa/` are exempt from the discord.js restriction.
- Every behavior change starts with a failing test; tests await signals, never sleep.
- Runtime artifacts (`.lina-sessions`, `data/memory`, `data/notepad.md`) are gitignored.
