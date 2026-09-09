# Independent adoption-kernel experiment

Understood as: build and run a plain LLM plus adoption kernel with only minimal durable storage and tool ports, excluding existing Lina engines; iterate against 30 fixed criteria using real Ollama GLM 5.3 Flash until the engineering threshold passes. This experimental goal precedes the parent plan's whole-Lina integration.

## Loop contract

- Class C4 for durable effect/correction boundaries; satisfy-spec plus score optimization, HOTL requested on 2026-09-10.
- Scope: NEW `scripts/qa/adoption-kernel/` and this plan directory; parent plan links this scoped experiment. Preserve all existing dirty design files. No production engine imports, new dependency, release, push or deployed/user-data changes.
- Model authority: existing Ollama GLM 5.3 Flash access and repeated synthetic tests explicitly authorized without an overall call, cost, token or wall-clock cap. Per request timeout 120 seconds, max output 4096 tokens, max 6 model turns per episode, initial concurrency 2. Record exhausted episodes as failures; transport outages as incomplete runs, never pass. No automatic model substitution.
- Main owns state/evaluation. Delegate the bounded kernel implementation after audit; main implements transport and independent scoring in disjoint files. Independent reviewer audits rubric and final candidate. Main reclaims after two distinct implementation-agent failures; respect dispatch reconciliation.
- Evidence: task-local external artifacts, raw synthetic prompts/responses, red/green logs, seed/source/rubric hashes, model IDs, usage and failures. No credentials in artifacts.
- Stop: all critical invariants plus macro >=90/100 and each of six categories >=80/100 in three consecutive fresh qualification batches on one frozen candidate; independent review has no material blocker. No measured uplift claim unless matched comparison supports it. Plateau requires failure analysis/new mechanism, not criterion weakening or a false success.
- DONE requires all evidence; unavailable provider is unmet; BLOCKED only under host repeated-block rules. No arbitrary time/token exhaustion claim. Scope expansions and new external permissions go to user; routine model testing is already authorized.

## Architecture and ownership

Current root TypeScript config excludes nested scripts/qa; create a local tsconfig extending it. Bun 1.4.0 is present. Existing QA scripts establish placement; no existing independent kernel directory exists. Current HEAD d59a1b618998346c0586d5fab4660b395b61a2db. Oracle Map demo remains reference-only.

`cli -> evaluation runner -> model transport + Kernel -> Store + ToolPort`; types have no runtime imports. Evaluation fixtures/scorers never import into kernel/transport. Plain baseline gets same raw accessible events and tools; kernel adds durable adoption/currentness/consumption rules. Ablation retains raw evidence but omits derived understanding from model frames. No semantic retrieval, compression, trait engine, world engine, autonomous timer or hidden task solver. Storage records facts rather than deciding their meaning. Fixed character/role text is an input, not a persona engine.

Same-process capability wiring constrains cooperative modules only (E7 application boundary; bypass: malicious code with filesystem/network access; residual: no OS sandbox claim; final hostile-code isolation layer: none). Synthetic tools are allowlisted and confined to temporary stores, never arbitrary shell/network actions.

## Dependency roadmap

| workPhaseId | Plan | Deliverable |
|---|---|---|
| roadmap | this + 001 + decade docs | audited/frozen whole roadmap and rubric |
| kernel | 010_kernel.md | standalone kernel/store/parser and contract tests |
| harness | 020_harness.md | raw GLM transport, paired scenarios, independent scorer and CLI |
| recovery | 030_recovery.md | actual child-process recovery, boundary and evaluator mutation checks |
| qualification | 040_qualification.md | improvement cycles, three fresh passing batches, independent review and limits |

Future repair cycles append documents and goalplan work phases without changing frozen criteria. Each P quotes previous D direction. Each effect/state enum chain is types -> parser/host input -> store JSON+SQLite -> validated restore -> frame/commit/reconcile consumers; scorer uses external evidence, not private state to invent success.

Verification commands planned: `bun test ./scripts/qa/adoption-kernel`, `tsc --noEmit -p scripts/qa/adoption-kernel/tsconfig.json`, `biome check scripts/qa/adoption-kernel`, `bun scripts/qa/adoption-kernel/cli.ts --help`, `... --mode compare --seed <seed> --output <external-directory>`. New commands/targets do not exist yet and are NOT RUN; later P must verify executable availability and target coverage. Docs C uses link/path checks, not source-test claims.
