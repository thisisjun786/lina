# 081 — Canonical serialization without recovery identity changes

Status: local implementation and independent review PASS, 2026-09-08. Delivery repair after [080](080_surfaces_and_acceptance.md).
The local 3,363-test gate passed, but hosted run 34255327669 exceeded the existing
5s image-event, 30s integrated LIFE, and 5s migration-checkpoint test budgets.
Keep all three budgets and assertions. No provider, renderer, merge or deployment
scope is added. Existing PR updates remain authorized.

## Evidence and contract

A CPU profile of three accepted steps and repeated actual store reads took 7.68s.
Canonical JSON encoding dominates: descriptor reads 16%, stringification 10.6%,
byte length checks 9.5%, and encoding loops above 25%. SQLite calls are roughly
1% each. Optimize serialization rather than weakening replay or startup audits.

Canonical output is durable identity: sorted keys, number normalization, escaping,
array order and SHA-256 must remain byte-identical. Keep prototype, descriptor,
cycle, sparse-array, finite/safe-number, depth, item and UTF-8 byte restrictions.
Never execute accessors or toJSON; never memoize a mutable caller object. Preserve
all corruption, grant, duplicate, checkpoint and original-source checks.

## Bounded implementation

| Owner / path | Change and verification |
| --- | --- |
| Worker: core `src/world/life-json.ts` | Replace recursive intermediate JSON strings and repeated descriptor lookups with one descriptor read per property and bounded ordered output. Count UTF-8 bytes without rescanning each ancestor string. Preserve every accepted output and rejection boundary. |
| Worker: core `test/life-json-compatibility.test.ts` and fixture if necessary | Golden canonical bytes/digests for numeric-looking keys, Unicode/escapes, negative zero and shared children; exact size/depth/item boundaries; getter/toJSON, symbols, cycles, sparse/extra-property arrays and invalid prototypes/numbers. Compare a deterministic nested corpus against the pre-change encoder to catch durable identity changes. |
| Main: 081/000/080 evidence and task-local profiles | Freeze baseline measurements and old encoder as evidence; run existing timed-out scenarios unchanged, profile the same workload, source gates, full native-enabled suite and current-head hosted CI; update PR and record remaining UI/live-provider gaps. |
| Independent reviewer | Audit plan before B and final byte/validation compatibility after implementation. Review threshold preservation and actual measured improvement; no approval inferred for external operations. |

The worker owns the small cohesive serializer/test slice. Main owns workflow,
baseline/profile and integration verification, source review and PR delivery.
Do not broaden to persistent replay caches, schema changes or application defaults
without new concrete evidence and an updated plan.

## Audit amendments before B

The independent plan review is NEAR-PASS; these required refinements are part of
the worker contract. Production scope is `packages/lina-core/src/world/life-json.ts`;
test scope is `packages/lina-core/test/life-json-compatibility.test.ts` and its
named reference/data fixtures under that test tree.

- Measure each encoded string/key leaf with `JSON.stringify` and UTF-8 byte
  length. Keep per-string and per-container limits: store the byte offset on
  container entry and check the difference on completion. A cumulative early
  limit would change error precedence for multi-fault input.
- Pre-scan every own key/descriptor before encoding children, retaining each
  descriptor once. Preserve property → item/list limit → child → subtree-byte
  rejection order and identical error messages. Read descriptor values, never
  `Reflect.get`; do not invoke getters or `toJSON`.
- Preserve default UTF-16 key sorting, including numeric-looking keys and BMP
  versus astral pairs; do not use locale/code-point ordering. Preserve encoded
  lone-surrogate, control-character and U+2028/U+2029 byte counts.
- Check depth before scalar/container dispatch. Test an empty container at depth
  32 and a primitive at depth 33. Retain own-key count and 4096-item limits after
  descriptor scanning. Index iteration must still reject hole-plus-extra-property
  arrays whose own-key count happens to match; retain their prior error message.
- Differential tests use the retained pre-change encoder and compare accepted
  bytes/digests or rejected messages for every corpus item. Include the three
  captured real LIFE states; undefined at every position, functions/bigints,
  symbols, non-enumerables, cycles, invalid prototypes and throwing getter/toJSON
  contrasts. Dense arrays use their indexed descriptor values rather than the
  iterator protocol. A Proxy with divergent traps now supplies descriptor values;
  record and test that behavior without introducing a new Proxy rejection rule.

Execution adjustment: the first worker produced no edits or progress after a
bounded interval and was closed before reassignment. Main takes the immediately
blocking `life-json.ts` implementation. A replacement worker owns only the
reference/corpus tests and fixtures, against the frozen pre-change source. This
keeps write sets disjoint and retains independent final review. The replacement
worker also produced no edits and was closed; main completed the source and
differential tests, with a fresh independent reviewer owning final review.

The first implementation reduced the same profile from 7.68s to 5.69s. Bulk
property-descriptor extraction and per-call primitive-string reuse were measured
without a useful improvement and are not retained. Descriptor values use a Map,
which was faster than a null-prototype record on captured states. `jsonBoundary`
uses the same encoder kernel and byte/error checks without materializing output
that its caller discards. Differential tests cover both public entry points.

## Completion

The three original integration tests must pass with their existing time budgets,
including the current-head hosted dev-gate. Require independent review, unchanged
canonical identity and strict-negative corpus, root/browser types, lint, build,
dependency/history scans and source-bound full-suite proof. A faster local profile
alone is insufficient. Retain original 080 evidence as an earlier revision and
record new evidence separately.


## Measured implementation evidence

The retained encoder at `602e52a` is the differential reference. Three captured
real LIFE states retain their exact canonical strings and SHA-256 digests. Five
compatibility tests passed 347 assertions, including both canonical output and
validation-only results. The same three-step/store-read CPU workload fell from
7.68s to 5.36s. The original integration tests passed without budget changes:
image-event 3.03s, integrated LIFE 12.73s, migration about 3.2s (93 assertions in
five tests across three files). These local timings are not hosted CI proof.

The implementation validates every descriptor once before traversing children,
keeps ordered chunks and encoded-byte offsets, and avoids output allocation for
validation-only callers. No cross-call cache, replay shortcut, database schema,
permission or timeout changed. Proxy values use validated descriptors instead of
invoking a divergent get trap; this is explicit in its dedicated contrast test.

Fresh actual health HTTP captures cover 11 cases on the optimized source. Cold
health opens no model/provider; rejected DB bytes and directory entries remain
unchanged. All four listeners closed and disposable state was removed. Final
source gates, independent review and hosted result are recorded at closure.

Final local native-enabled suite: 3,368 passed, zero failures, 18,194 assertions
across 481 files in 315 seconds, with unchanged source hashes. Root/browser types,
lint, build, CI validation and dependency audit passed on the same source.
Independent review found no blockers. Its extra probe confirms the accepted
key-size boundary and array Proxy contrast in addition to the shipped corpus.
The current-head hosted gate remains the final delivery criterion.
