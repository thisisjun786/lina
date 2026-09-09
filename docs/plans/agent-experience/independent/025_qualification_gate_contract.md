# Qualification gate implementation contract

This closes the still-missing qualification command in 022, before harness D.
It does not assert any host or model pass. Threshold authority remains 001/005.
Main owns the gate; recovery supplies H11-H15 evidence after its full cycle.

`cli.ts qualify --index INDEX_JSON --output NEW_DIRECTORY` must evaluate saved
runs without model calls. `qualification.ts` owns ingress, ordered attempts and
verification. `qualification.test.ts` uses synthetic temporary saved artifacts;
those tests are gate validation only, never model qualification evidence.

The index enumerates every attempted batch in chronological order, development
and qualification, with immutable manifest path, comparison directory, source,
generator and rubric digests and start/end times. The final three attempts must
be distinct qualification seeds first used after the candidate freeze, complete
and passing on the same candidate and model configuration. Earlier failed and
development attempts remain in the index; reused seeds fail. A missing attempt
cannot be inferred from a provided index: qualification requires agreement with
the task's append-only run registry established before dispatch. Do not label an
arbitrary caller-supplied three-report list as a complete attempt history.

For each selected batch load its full qualification manifest (64 episodes:
B01-B14 four variants each, B15 four visible/omitted pairs), verify original hashes,
and require all baseline/kernel/ablation runs. Read every original trace and
private truth and recompute scores with current decoders/scorer; cached score or
report booleans alone are not proof. Validate run/score subprocess exits and
absence of invalidated.json. Source/generator/rubric digests and exact requested
model, returned model labels, request and output limits must agree. Missing or
transport-failed trials remain failures, never silently removed. Preserve cost
and failures from all attempts; calculate paired common-quality baseline and
ablation deltas separately from kernel structural uptake and H scores.

Each H01-H15 receipt records the exact criterion, candidate digest, command,
exit code, evidence artifact and its digest. The gate checks artifact bytes and
requires distinct row-specific test evidence rather than assigning every H row
from one aggregate green log. Receipts are local verification attestations, not
cryptographic proof that tests ran: final independent review must inspect the
mapped tests and sampled raw process evidence. No host receipts exist yet for
unperformed OS-process recovery scenarios. Never fabricate them to test live
qualification; synthetic gate fixtures must stay explicitly synthetic.

RED checks before implementation: missing/duplicate modes; missing B15 subcase;
reused/development seed; changed candidate/model/rubric; earlier failed attempt
breaking the final streak; altered raw trace/manifest; invalidated batch;
fabricated cached score; missing H row or altered H artifact; missing run registry
entry; output overwrite. Positive fixture must exercise all 30 rows with three
complete synthetic batches but explicitly remain gate-test evidence. Real
qualification only runs after recovery D and a frozen candidate, with fresh live
model traces and independent final review.

Preserve old development datasets unchanged. The learned-rule truth schema added
during harness review requires regeneration for new runs. A schema migration is
not permission to promote old scored development data into held-out evidence.

Registry implementation: comparison defaults to `run-registry.sqlite` in the
parent of its output directory; use one task evidence root across batches. The
registry preserves every seed occurrence and separate terminal execution records.
An alternate registry is explicit programmatic configuration and defines a
separate experiment history, not a way to reset the held-out seed rule. Existing
runs from before registry adoption remain development-only archived evidence.
