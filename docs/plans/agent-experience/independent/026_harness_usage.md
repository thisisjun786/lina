# Independent experiment commands

Run from the Lina checkout. This experiment uses only its own kernel, SQLite
stores and synthetic tool environment. It does not import Lina memory, persona,
context or LIFE. Current status is implementation verification; recovery and live
qualification are not complete.

```sh
bun scripts/qa/adoption-kernel/cli.ts --help
bun scripts/qa/adoption-kernel/cli.ts export --seed development-example --output /tmp/lina-experiment/cases
bun scripts/qa/adoption-kernel/cli.ts compare --manifest /tmp/lina-experiment/cases/manifest.json --output /tmp/lina-experiment/runs
```

Create the parent evidence directory first. `compare` needs existing authorized
credentials in `OLLAMA_BASE_URL` (OpenAI-compatible endpoint ending `/v1`),
`OLLAMA_MODEL` and `OLLAMA_API_KEY`. Primary observed model label is
`glm-5.3-flash`. Do not commit credentials or echo the environment. One episode
allows six actual requests, 4096 output tokens/request, temperature0 and a
120-second request timeout. There are no hidden retries. Mode order rotates;
requests, receipts, transport failures and usage remain under the output directory.
Use one task evidence parent so `run-registry.sqlite` preserves the full history.
A repeated run needs a new output directory. Reusing a seed is development work,
not a fresh qualification sample.

A single public episode can be run or scored separately:

```sh
bun scripts/qa/adoption-kernel/cli.ts run --case PUBLIC_JSON --mode kernel --output NEW_DIRECTORY
bun scripts/qa/adoption-kernel/cli.ts score --case PUBLIC_JSON --truth PRIVATE_JSON --trace TRACE_JSON --output SCORE_JSON
```

Use baseline/kernel/ablation as the mode. `run` receives no private truth. `score`
validates declared prelude operations, the request/decision/effect chain and an
exact isolated replay before applying independent expected values. Replay never
calls the provider. The optional internal decision-ID factory is unavailable as
a CLI flag; normal execution continues to use random IDs.

After recovery verification and candidate freeze:

```sh
bun scripts/qa/adoption-kernel/cli.ts freeze --output NEW_FREEZE_JSON
bun scripts/qa/adoption-kernel/cli.ts export-fresh --freeze FREEZE_JSON --registry REGISTRY_SQLITE --output NEW_CASES_DIRECTORY
bun scripts/qa/adoption-kernel/cli.ts compare --manifest NEW_CASES_DIRECTORY/manifest.json --output NEW_RUN_DIRECTORY
bun scripts/qa/adoption-kernel/cli.ts qualify --index INDEX_JSON --output NEW_REPORT_JSON
```

Repeat fresh export and comparison for three different batches under the same
freeze. `NEW_RUN_DIRECTORY` must have the registry's directory as its parent.
Changing source/generator/rubric invalidates the freeze. The index has exactly
`version:1`, absolute `registryPath`, `freezePath`, `sourceHash`, `generatorHash`,
`rubricHash`, `frozenAt` (freeze `at`) and `hosts`. Each of the15 host receipts has
`id`, `sourceHash`, absolute `artifact`, SHA256 `artifactHash`, `exitCode:0`,
`command` argv and unique `testName` containing its H identifier. The command must
record a Bun test and matching `--test-name-pattern`; artifact bytes must contain
that exact passing test and zero failures. These receipts attest local execution;
independent review must verify the test actually establishes its criterion.
Do not manufacture missing H11-H15 process evidence.

Qualification reads the complete registry, selects its last3 fresh completed
qualification attempts, binds generation to freeze, reloads all64 episodes and
all3 modes per batch, replays/re-scores raw traces, validates H evidence and reports
macro/category thresholds plus common-behavior baseline/ablation deltas and cost.
A completed registry attempt is not necessarily a behavioral pass. A failed or
incomplete attempt cannot be skipped to recover an older streak. Development and
failed qualification seeds are never fresh again in this experiment history.

The `qualification-witness.test.ts` full-pass path deliberately uses private
truth and synthetic host/process attestations to test validator reachability.
It is excluded from runtime imports and is never evidence of GLM performance.
Functional protocol checks, measured task utility and consciousness claims are
separate; this experiment makes no consciousness or universal-ceiling claim.
