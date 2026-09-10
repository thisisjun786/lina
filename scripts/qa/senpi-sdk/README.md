# Fresh Senpi SDK probe

This is an isolated compatibility probe for the Senpi SDK pinned in [package.json](package.json), not a production adapter. Default checks use local fixtures. A separate opt-in command exercises a real model through the configured OpenCodex Responses API. Neither path reuses the retired Lina-Senpi implementation or opens existing user sessions.

## Run

From the repository root, with Bun 1.4:

```sh
cd scripts/qa/senpi-sdk
bun install --frozen-lockfile --ignore-scripts
bun run check
bun run typecheck
bun run lint
bun run build
bun run qa
```

Install first. The remaining commands are independent checks; `build` is needed only before using a built entry. `bun run check` starts its own disposable fixtures and removes those test directories afterward. `bun run qa` is a separate, optional run for retained synthetic evidence.

`bun run qa` runs all five scenarios and prints a JSON report. By default it retains evidence below the system temporary directory, at the path named in `root`. These CLI evidence directories are not automatically removed; retain or delete them after inspection. To choose the location, use `bun run qa --root /tmp/my-new-senpi-evidence`; the absolute path must not exist, its parent must exist, and it must be outside this checkout. Existing evidence is never overwritten.

`--scenario` accepts `all`, `flow`, `correction`, `recovery`, `crash-fenced`, or `crash-unfenced`. The built entry is `bun dist/cli.js`, with the same options and locally installed dependencies.

The synthetic CLI records observations; its exit code alone is not a compatibility verdict. `bun run check` covers the five Chat Completions scenarios below plus additional live-runner fixtures using Responses and adversarial evaluator checks. `bun run qa` runs only the five scenarios below. Neither command opts into a real model. The `*.check.ts` filenames deliberately keep this separately installed package out of root `bun test` discovery. Root type checking also excludes QA scripts, so run this package's type check explicitly.

## Synthetic coverage

| Scenario | Independent observation |
| --- | --- |
| `flow` | The real SDK receives a synthetic tool call, executes only the allowed custom tool, and sends its independently generated result in the next HTTP request. Final text and execution events are observed. |
| `correction` | After a completed turn, `session.reload()` applies a changed system prompt; the next actual HTTP request contains the new policy and user correction. Earlier conversation messages remain unchanged. |
| `recovery` | A fixture holds an HTTP request. After its admission signal, `session.abort()` disconnects it and records an aborted assistant message. A fresh OS process opens the same session file, preserves completed history, and accepts an explicit new prompt. |
| `crash-fenced` | The worker is killed after a SQLite effect and receipt commit but before the tool returns to the SDK. A fresh process opens the session; an explicit new prompt causes another call. The synthetic provider supplies the same fixed operation ID with a new tool-call ID; the SDK does not recover or assign that operation ID. The fixture owner records two attempts but one effect. |
| `crash-unfenced` | The same crash and explicit replay run without owner deduplication. Two effects are recorded. This negative control distinguishes owner protection from SDK behavior. |

The original five scenarios retain their local Chat Completions fixture. Cancellation and crash timing use HTTP and IPC signals registered before the triggering action, not sleeps. Synthetic child processes use an environment allowlist, temporary home/config/workspace paths, an explicit model, no discovered skills or extensions, and one allowed custom tool. Automatic compaction, title generation, provider/model retries, fallback, and model catalog refresh are disabled.

The CLI reads the installed SDK's version and rejects a dependency-pin mismatch before creating the evidence directory. The report records Bun, OS, architecture, API, provider, model, HTTP requests, SDK snapshots, and scenario observations. Each scenario directory also retains `requests.jsonl`, `events.jsonl`, worker output, session JSONL, tool calls, and `owner.sqlite`. Crash scenarios preserve `killed-session.jsonl` before reopening.

## Real-model command

Run from the repository root after the local checks:

```sh
bun scripts/qa/senpi-sdk/live.ts --live --evidence /tmp/my-new-senpi-live-evidence
```

This makes real model requests and can incur provider charges. It reads the existing OpenCodex discovery configuration and uses exactly `ollama-cloud/glm-5.3-flash`. The configured Hub must provide `/v1/responses`. No global configuration is changed. `--live` is required before discovery or model access; `--evidence` must be a new absolute directory. The built equivalent is `bun scripts/qa/senpi-sdk/dist/live.js` with the same arguments.

The scenario first plans an east/BOLT lookup without executing a tool. A second user turn corrects it to west/BOLT and requests the lookup and a strict JSON answer. The real SDK calls the local inventory tool. Its quantity and receipt are generated outside the model and are not supplied until tool execution. The tool accepts both warehouses, so a stale east selection remains observable rather than being prevented by the fixture.

[live-evidence.ts](live-evidence.ts) compares actual tool arguments and final JSON against that independent inventory data. It also checks HTTP status, request/response model identity, complete Responses events, and reported usage. Stale selections, forged quantities or receipts, malformed answers, and missing/wrong response models fail the checks. The live CLI writes `verdict: "fail"` and exits nonzero when this validation or cleanup fails.

The capture proxy permits at most six upstream requests, sets `max_output_tokens` to 4,096, and bounds each complete upstream request to 120 seconds. It buffers Responses SSE for recording; this probe does not measure interactive streaming quality. There are no SDK/proxy retries or model fallbacks. OpenCodex's internal provider retries are not measured. Missing usage remains unknown. Monetary cost is not measured; zero pricing fields in SDK events are configured placeholders, not billing evidence.

The live evidence directory retains `report.json`, independent `environment.json`, SDK `events.jsonl` and `messages.json`, `tool-attempts.jsonl`, `tool-results.jsonl`, `wire/wire-*.json`, and `cleanup.json`. Temporary SDK auth/session/workspace state is removed after the run; the session and proxy are closed. Wire artifacts include sanitized bodies, response status/headers, and latency, but not credentials.

## Recorded live result

On 2026-09-10, this repository's Git commit `de0e4ab` identified the QA harness used for one successful live run. This is the tested harness revision, not the SDK version or a claim about future checkouts:

| Observation | Result |
| --- | --- |
| SDK / runtime | Senpi `2026.9.10-2`, Bun `1.4.0`, Linux x64 |
| API / requested model | `openai-responses` through configured OpenCodex / `ollama-cloud/glm-5.3-flash` |
| Reported response model | `glm-5.3-flash` |
| Requests | Three HTTP 200 responses; each requested a 4,096-token output cap |
| Behavior observed in this run | No tool in the planning turn; exactly one west/BOLT lookup after correction |
| Final answer | Warehouse west, SKU BOLT, quantity 82, and the exact inventory receipt returned by the tool |
| Provider-reported tokens | 1,006 input, 160 output |
| Elapsed | Approximately 14.2 seconds for the complete scenario |
| Cleanup | Session closed, proxy port refused connections, runtime scratch directory absent |

The recorded run supplied `--evidence "$HOME/.local/state/lina-qa/senpi-live-20260910"`; the `/tmp` path above is an example for a new run. Raw evidence remains in the supplied directory and is not committed. The prior development attempt is retained in the sibling `senpi-live-20260910-failed-chat-completions/` directory: the Hub rejected `/v1/chat/completions` with two HTTP 404 responses, and no valid model answer was obtained. That failure led to the native Responses correction; it was not discarded or counted as a cognitive result.

## Recovery boundary

The checked `2026.9.10-2` SDK supports this tool loop, between-turn context replacement, cancellation, and fresh-process history reopening. Opening a saved session did not automatically resume the held request or unfinished tool before the probe's next explicit prompt.

After the crash, the completed conversation survived, but the interrupted tool call had no stored result. Replaying the operation explicitly could execute the custom tool again. The one-effect result belongs to [owner.ts](owner.ts): its effect is a database row committed atomically with a receipt. It does not establish exactly-once remote operations, arbitrary payload conflict handling, or an SDK-wide deduplication guarantee.

This supports continuing with a small LINA-owned Senpi adapter experiment. It does not establish production readiness or superiority to Codex.

## Not established

- General comprehension, reliable obedience across tasks, or Moirai's cognitive benefit. One bounded live correction case is not a quality benchmark or qualification batch.
- Mid-turn correction, withdrawing permission to disclose prior context, suppressing outdated responses, concurrent conversations, or coordinating three judgments and one synthesis.
- Automatic recovery of unknown executions or exactly-once user message delivery.
- Production `SessionPort` admission, source lineage, memory/persona integration, compaction, authenticated remote-Hub setups, other model/API combinations, or cross-platform behavior.
- Migration of existing Codex/Senpi state. Product execution remains Codex-only during this isolated probe.

The existing [Moirai plan](../../../docs/plans/context-engines/030_moirai_refactor_plan.md) proposes three independent judgments followed by one synthesis, with real outcomes informing later decisions. This SDK compatibility probe is not the plan's live-model qualification.
