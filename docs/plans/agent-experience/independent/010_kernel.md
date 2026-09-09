# Kernel and durable owner

Depends on roadmap D. NEW only under `scripts/qa/adoption-kernel/`. Revalidate file absence and previous D before B. Main owns shared contracts; executor implements the bounded files below after audit. Tests first; missing import/behavior RED is retained.

## Exact file map and interfaces

- NEW `types.ts`: Evidence {id, revision, subject, domain: real|fiction, visibility: private|public, text, active}; Purpose {id,revision,subject,text,audience: private|public}; Ref {id,revision}; Adoption {id,kind: understanding|plan|intention,text,refs,condition,status: active|withdrawn}; Proposal discriminated kind: answer(text), adopt(adoptionKind,text,refs,condition), tool(tool,args), defer(reason,condition), noop(reason); all proposals contain purposeRevision. Frame {purpose,evidence,adoptions,receipts,version}. ModelPort(frame)->Promise<unknown>; ToolPort(name,args,id)->Promise<receipt>. Host-generated IDs only, not model-generated execution identities.
- NEW `validation.ts`: parse unknown proposal, bounded strings/arrays/JSON, reject unknown kinds/fields/invalid refs. Model tool args are data; tool allowlist checks stay host-owned.
- NEW `store.ts`: Bun SQLite temp DB, schema version guard; event/evidence/adoption/purpose/decision/effect/result-consumption records. Atomic transactions and unique decision IDs. `observe`, `correct`, `retract`, `setPurpose`, `frame`, `prepare`, `dispatch`, `recordResult`, `consume`, `pending`, `signal`, `close`. Full prepared frame dependency fingerprint includes all supplied evidence, adoptions, purpose/audience. Revision ordering rejects stale writes; source ancestry invalidates transitively without old-value revival. Durable dispatch marker before tool call; completed results cannot repeat execution. Unknown stays pending until exact receipt reconciled. Frame access limits subject/domain/audience before serialization. Store validates unknown restored data.
- NEW `kernel.ts`: constructor minimal store/model/tools; `step(purposeId)` assembles frame, persists decision snapshot, requests proposal, revalidates full input/current purpose, commits adoption/answer/noop/defer or dispatches allowed tool then records result. `resume` consumes durable results, never retries unknown effect. Returned trace distinguishes rejection/defer/noop/answered/observed/unknown. Model cannot access raw write client. Independent purposes may await models concurrently; short SQLite transactions serialize commit only.
- NEW `kernel.test.ts`: H01-H10 and ordinary answer/adopt/tool transitions using deterministic fake model at model port and real DB; tests observe frames and effect counters. Deferred promises activate concurrent mutation without sleeps.
- NEW `tsconfig.json`: extends ../../../tsconfig.json; include local **/*.ts only. No root config/dependency edits.

## Required edge evidence

Each H01-H10 row names exact mutation and counter/frame evidence in 001. Reopen DB verifies serialized adoption dependency meaning. `adopt` must retain refs for plans/intents as well as understanding. Raw source correction is trusted host API independent of model learning. Public-output restriction must follow actual serialized scope, not a prompt asking secrecy. Domain labels persist and are visible to model; do not coerce fiction into reality.

All functions use named exports and strict types. No existing Lina package import. No runtime branches by task/criterion ID. Store is persistence plus structural eligibility, not a semantic retrieval/learning engine. Semantic conditional-understanding selection remains model work.

Verification: focused Bun tests, local strict config and Biome. Before implementation record RED. C independently checks shape parser and transitive withdrawal/actual input race, not just test count. D records source hashes, limitations and next direction: transport/evaluation harness.
