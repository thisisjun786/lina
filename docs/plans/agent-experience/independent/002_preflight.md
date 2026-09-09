# Preflight and current audit state

2026-09-10. Host goal active; current PABCD phase A, work phase roadmap. No implementation or scored qualification has started. The 30-row rubric is an audit candidate, not yet frozen.

## Verified environment

- Current source baseline: d59a1b618998346c0586d5fab4660b395b61a2db; task branch codex/independent-adoption-kernel, original worktree preserved.
- Bun 1.4.0 available. Existing repository installation provides TypeScript 5.9.3 and Biome 2.5.12. The current worktree has no installed dependencies; reuse existing tools with explicit type roots or an approved ordinary install if needed. No dependency installation performed.
- Direct Ollama OpenAI-compatible endpoint supports `glm-5.3-flash`. A synthetic request returned `{"ready":true}`, response model `glm-5.3-flash`, usage 23 prompt / 35 completion / 58 total tokens. This verifies transport only, not kernel behavior or backend identity beyond the response label.
- Transport implementation should use `/v1/chat/completions`, not Ollama native `/api/chat`. Existing credentials were used only in the authorization header; none copied into plans, prompts or evidence.

## Independent audit did not execute

The configured native reviewer terminated with HTTP 422: `input[0]: unknown item type "additional_tools"`. No review verdict exists. The child was closed after its errored notification; no child changes or owned implementation processes remain. CXC dispatch returned `reconcile` because this transport error is not classified for automatic fallback. Do not claim independent audit, enter B with a fabricated verdict, reset the dispatch, or create a replacement dispatch to evade this state.

The installed `cxc subagents dispatch` wrapper reports unknown subcommand although its help advertises it. Its installed `components/subagent-config/dist/fallback-dispatch-cli.js` entrypoint successfully performed the identical start/claim/created/failed protocol, without modifying the plugin. This resolved CLI wiring only; it did not authorize recovery from the reviewer transport error.

Recovery update: the user explicitly requested repair and resumption. Current reviewer configuration now selects `gpt-5.6-sol`, also present in the native supported-model list. A new authorized recovery dispatch preserves the old failed dispatch and uses the current configured model. Native agent `01a08732-8929-7643-a054-2bd101155cca` was created and its handle recorded. Creation is not an audit verdict; A remains open until the independent result is inspected. The ordinary `cxc subagents dispatch` wrapper now works too. No plugin or global model configuration was changed by this recovery.
