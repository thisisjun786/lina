# Fresh Senpi SDK probe

This is an opt-in, synthetic compatibility probe for `@code-yeongyu/senpi`, not a production adapter. It uses the SDK pinned in [package.json](package.json), a loopback Chat Completions provider, and fresh temporary state. It does not reuse the retired Lina-Senpi implementation or open existing user sessions.

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

Run these commands in order. `bun run check` starts the CLI internally with disposable fixtures and removes those test directories afterward; it does not need a prior `qa` run.

`bun run qa` runs all five scenarios and prints a JSON report. By default it retains evidence below the system temporary directory, at the path named in `root`. These CLI evidence directories are not automatically removed; retain or delete them after inspection. To choose the location, use `bun run qa --root /tmp/my-new-senpi-evidence`; the absolute path must not exist, its parent must exist, and it must be outside this checkout. Existing evidence is never overwritten.

`--scenario` accepts `all`, `flow`, `correction`, `recovery`, `crash-fenced`, or `crash-unfenced`. The built entry is `bun dist/cli.js`, with the same options and locally installed dependencies.

The CLI records observations; its exit code alone is not a compatibility verdict. `bun run check` asserts the wire, process, and owner-state evidence. The `*.check.ts` filenames deliberately keep this separately installed package out of root `bun test` discovery. Root type checking also excludes QA scripts, so run this package's type check explicitly.

## What is measured

| Scenario | Independent observation |
| --- | --- |
| `flow` | The real SDK receives a synthetic tool call, executes only the allowed custom tool, and sends its independently generated result in the next HTTP request. Final text and execution events are observed. |
| `correction` | After a completed turn, `session.reload()` applies a changed system prompt; the next actual HTTP request contains the new policy and user correction. Earlier conversation messages remain unchanged. |
| `recovery` | A fixture holds an HTTP request. After its admission signal, `session.abort()` disconnects it and records an aborted assistant message. A fresh OS process opens the same session file, preserves completed history, and accepts an explicit new prompt. |
| `crash-fenced` | The worker is killed after a SQLite effect and receipt commit but before the tool returns to the SDK. A fresh process opens the session; an explicit new prompt causes another call. The synthetic provider supplies the same fixed operation ID with a new tool-call ID; the SDK does not recover or assign that operation ID. The fixture owner records two attempts but one effect. |
| `crash-unfenced` | The same crash and explicit replay run without owner deduplication. Two effects are recorded. This negative control distinguishes owner protection from SDK behavior. |

Cancellation and crash timing use HTTP and IPC signals registered before the triggering action, not sleeps. Child processes use an environment allowlist, temporary home/config/workspace paths, an explicit synthetic model, no discovered skills or extensions, and one allowed custom tool. Automatic compaction, title generation, provider/model retries, fallback, and model catalog refresh are disabled for this probe.

The CLI reads the installed SDK's version and rejects a dependency-pin mismatch before creating the evidence directory. The report records Bun, OS, architecture, API, provider, model, HTTP requests, SDK snapshots, and scenario observations. Each scenario directory also retains `requests.jsonl`, `events.jsonl`, worker output, session JSONL, tool calls, and `owner.sqlite`. Crash scenarios preserve `killed-session.jsonl` before reopening.

## Observed boundary

The checked `2026.9.10-2` SDK supports this tool loop, between-turn context replacement, cancellation, and fresh-process history reopening. Opening a saved session did not automatically resume the held request or unfinished tool before the probe's next explicit prompt.

After the crash, the completed conversation survived, but the interrupted tool call had no stored result. Replaying the operation explicitly could execute the custom tool again. The one-effect result belongs to [owner.ts](owner.ts): its effect is a database row committed atomically with a receipt. It does not establish exactly-once remote operations, arbitrary payload conflict handling, or an SDK-wide deduplication guarantee.

This supports continuing with a small LINA-owned Senpi adapter experiment. It does not establish production readiness or superiority to Codex.

## Not established

- Real-model comprehension, semantic obedience to corrections, or Moirai's cognitive benefit. The provider scripts responses; sentinels test transport, not intelligence.
- Mid-turn correction, withdrawing permission to disclose prior context, suppressing outdated responses, concurrent conversations, or coordinating three judgments and one synthesis.
- Automatic recovery of unknown executions or exactly-once user message delivery.
- Production `SessionPort` admission, source lineage, memory/persona integration, compaction, provider credentials, live model compatibility, or cross-platform behavior.
- Migration of existing Codex/Senpi state. Product execution remains Codex-only during this isolated probe.

The existing [Moirai plan](../../../docs/plans/context-engines/030_moirai_refactor_plan.md) proposes three independent judgments followed by one synthesis, with real outcomes informing later decisions. This SDK probe and its synthetic checks are not the plan's live-model qualification.
