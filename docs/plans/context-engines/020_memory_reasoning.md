# 020 — 근거 연결과 기억 재검토

상태: B 구현 중. 독립 A 잔여 수정 반영 후 진입했으며 전체 구현 완료가 아니다. 단위 `memory`, 선행 `routing`.

원본 확인: 2026-09-08 Honcho `5a2f807b8b905cbb20e88267a9138f53c1e8d755`의 [dream orchestrator](https://github.com/plastic-labs/honcho/blob/5a2f807b8b905cbb20e88267a9138f53c1e8d755/src/dreamer/orchestrator.py)를 읽었다. 연역 다음 귀납을 실행하며 각 실행의 성공·실패와 반복 수를 따로 기록한다. 모델 호출 중 DB transaction을 유지하지 않는다. LINA에서는 이 책임 분리를 자체 기록·출처 검증·내구 큐에 적용한다. upstream 전체 구현의 동등성을 주장하지 않는다.

같은 커밋의 [specialists](https://github.com/plastic-labs/honcho/blob/5a2f807b8b905cbb20e88267a9138f53c1e8d755/src/dreamer/specialists.py)에서는 제한된 반복 탐색과 관찰 생성, 안정된 정체성과 행동 추론의 분리를 확인했다. LINA의 재검토도 필요할 때 적격 기록을 검색·확장할 수 있어야 하며 고정 page를 두 번 요약하는 것으로 대체하지 않는다. authored persona 수정 권한은 이 재검토에 주지 않는다.

## 변경 지도

| 작업 | 경로 | 전 → 후 또는 신규 책임 |
| --- | --- | --- |
| MODIFY | `packages/lina-memory/src/engine/types.ts` | Observation의 직접 원문 인용만 → deduction/induction 결론과 전제 record id/revision을 구분한 입력 타입; 원문 관찰은 기존 계약 유지 |
| MODIFY | `packages/lina-memory/src/engine/schema.ts` | 기존 기록 저장 → 전제 edge와 처리 receipt 및 재검토 작업 상태의 버전 migration |
| MODIFY | `packages/lina-memory/src/engine/store.ts` | apply/recall → 근거 revision CAS, 파생 유효성 검사와 전이적 무효화 소비 |
| NEW | `packages/lina-memory/src/engine/reasoning.ts` | 제안된 전제의 존재·소유자·공개범위·revision·순환을 검증하고 결론을 원자적으로 수용 |
| NEW | `packages/lina-memory/src/engine/consolidation.ts` | 변경된 근거 집합과 정책 revision에 대한 내구 작업 claim/commit/retry; 같은 입력 재처리 중복 방지 |
| MODIFY | `packages/lina-runtime/src/context/companion.ts` | 에피소드 관찰 뒤 변경 근거를 재검토 큐에 연결; 닫힘/설정 변경 시 오래된 응답 commit 차단 |
| MODIFY | `packages/lina-runtime/src/context/memory-query.ts` | 한 차례 literal 검색 → 정책 제한 안의 반복 탐색과 추론 chain 원문 전달; 누락과 불확실성 명시 |
| MODIFY | `packages/lina-memory/src/engine/prompt.ts` | flat slot 추출을 유지하면서 명시적 사실과 잠정 가설·전제 연결을 구분한 재검토 프롬프트 |
| NEW | `packages/lina-memory/test/engine-reasoning.test.ts` | 근거 변경/순환/중복/교차 에이전트 부정 사례 |
| NEW | `packages/lina-runtime/test/memory-consolidation.test.ts` | 실제 companion 작업→저장→다음 query와 재시작 연결 |
| NEW | `packages/lina-runtime/src/context/policy-settings.ts` | 070에서 앞당긴 내장 엔진 정책 JSON/CAS 저장 owner |
| NEW | `packages/lina-runtime/test/engine-policy-settings.test.ts` | 기본값·CAS·재열기·손상 거부와 주입 owner 수명 검증 |
| MODIFY | `packages/lina-runtime/src/session-app.ts` | 실제 추론 서비스·정책 owner·설정 revision을 companion에 공급 |
| MODIFY | `packages/lina-memory/src/engine/receipts.ts` | 직접 관찰과 추론 receipt를 분리 검증 |
| MODIFY | `packages/lina-memory/src/engine/provenance.ts` | 원문 증명과 현재 전제 적격성 경계 |
| MODIFY | `packages/lina-memory/src/engine/records.ts` | 추론 support·history와 직접 관찰 우선순위 |
| MODIFY | `packages/lina-memory/src/engine/validation.ts` | strict 결론 입력 및 버전별 기록 검사 |
| MODIFY | `packages/lina-memory/src/engine/audit.ts` | 전제·추론 receipt·내구 작업의 복원 정합성 |
| MODIFY | `packages/lina-runtime/src/context/port.ts` | 전용 consolidate 서비스 및 요청 출력 한도 계약 |
| MODIFY | `packages/lina-opencodex/src/services.ts` | reflection 역할 라우트를 재사용하는 전용 재검토 호출 |
| MODIFY | `packages/lina-opencodex/src/prompts.ts` | 전제 id/revision 기반 검색·결론 JSON 전용 system prompt |
| MODIFY | `packages/lina-runtime/src/context/memory.ts` | observation과 구분한 선택적 consolidation 상태 |
| MODIFY | `packages/lina-memory/test/engine.test.ts` | v4 migration·동일 관찰 no-op 회귀 |
| MODIFY | `packages/lina-memory/test/engine-source-policy.test.ts` | v3 원본 보존 및 v4 전체 맥락 철회 검사 |
| NEW | `packages/lina-memory/src/engine/reasoning-receipts.ts` | 정규 입력/출력과 전제 history·claim을 대조하는 추론 receipt 검사 |
| NEW | `packages/lina-memory/test/consolidation.test.ts` | 내구 claim·중복·중단·트랜잭션 rollback 부정 경로 |
| NEW | `packages/lina-memory/test/engine-reasoning-schema.test.ts` | 실제 DB 재열기와 v4 checkpoint/receipt 손상 거부 |
| NEW | `packages/lina-memory/test/fixtures/engine-v3.ts` | 이전 schema fixture 생성; 실제 구버전 binary 생성 증거와 구분 |

## 필드·상태 흐름

새로운 대화가 들어오면 관찰→변경된 근거 집합→재검토 후보→모델 구조화 결과→현재 근거 재검증→결론 commit 순서다. status는 pending/running/committed/failed/withheld를 구분하며 모델은 처리 성공이나 권한을 자가 증명할 수 없다. 원문 철회는 모든 파생 결론과 대기 작업을 재검증하게 한다. 망각 범위 확인은 기존 대화 승인 흐름에서 수행하며 이번 단계가 원문을 임의 삭제하지 않는다.

입력은 해당 boundary에서 검증하고 저장 owner가 schema/revision/참조를 검증한다. 새 상태는 API/도구 출력과 실제 consumer까지 전달한다. 임의 JSON으로 권한을 부여하지 않는다. 구버전·알 수 없는 enum은 명시적으로 처리하고 조용한 기본값으로 데이터 의미를 바꾸지 않는다.

## 활성화와 기대 결과

- 반복된 동일 에피소드로 support를 늘리지 않음.
- 전제 correction 뒤 손자 결론도 recall 제외.
- 원문 허용 범위 변경 중 비동기 응답은 commit 거부.
- 재시작한 running 작업은 같은 입력 key로 복구.
- 새 근거 없는 재검토는 모델 호출하지 않음.
- 파일 DB 손상/미지 schema는 시작 시 거부..

## 검증 명령과 증거

각 NEW 테스트의 직접 경로를 `bun test`에 전달하여 실패→구현→통과를 남긴다. 이 문서 작성 시 새 테스트는 없으므로 실행 결과를 주장하지 않는다. 수정된 기존 기능의 affected tests, `bun run typecheck`, `bun run lint`를 수행하고 마지막 acceptance에서 `bun run ci:validate`, `bun run ci:build`와 전체 테스트를 수행한다. 현존 스크립트는 package.json에서 확인했으며 target coverage와 실제 exit code는 실행 시 기록한다.

## 감사와 재검증

공통 상태 계약은 004_contracts.md, 해당 단위의 추가 계약은 아래 사전 감사 수정 절을 따른다. A에서 source/소비자 누락을 검사하고, 각 구현 P에서는 선행 커밋으로 바뀐 타입과 경로를 재검증한다. A 통과 전 구현은 시작하지 않는다.

상세 identity/schema/transaction/search/API 계약은 [004_contracts](004_contracts.md)를 따른다.

## 사전 감사 수정: 큐 소유와 migration

개인 관찰 작업은 기존 CompanionQueue가 계속 소유한다. consolidation job은 engine DB의 engine_reasoning_jobs 한 곳에만 존재한다. MODIFY companion.ts의 기존 run 루프가 관찰 commit 뒤 consolidation claim/run/commit을 수행하고 양쪽 nextDue를 함께 계산한다. companion-queue.ts/schema.ts는 기존 관찰 job용으로 유지하며 consolidation row를 복제하지 않는다. MODIFY session-app.ts의 close는 CompanionMemory 종료를 기다려 실행 중 재검토를 취소하고, reopen은 commit receipt와 job을 대조한다.

MODIFY engine/schema.ts는 v3 전체 기존 schema/data audit 후 새 세 테이블을 같은 BEGIN IMMEDIATE 안에 생성하고 user_version=4로 갱신한다. version 1/2는 기존 v3 migration을 먼저 실행한다. 기존 record를 가짜 추론으로 변환하지 않는다. MODIFY engine/audit.ts와 validation.ts는 새 결론 및 edge/receipt/current revision 일치를 검사한다. MODIFY packages/lina-memory/test/engine.test.ts와 engine-source-policy.test.ts의 버전 단언 및 v3 migration fixture를 갱신한다. migration 중 실패는 rollback 후 기존 DB가 다시 열려야 한다.

## 이번 P의 출발점

routing D 결론(d531673): 내부 등급의 저장→재열기→실제 요청과 기존 대화 모델/에이전트별 선택 보존을 구현했고357개 관련 검사가 통과했다. 이 단위는 그 서비스 계약을 재사용한다. 전체 엔진 완료는 아니며 별도 LIFE 이미지 timeout을070/080에 넘겼다. 현재 memory schema는v3이며 기록/원문 증명/slot fence가 이미 있으므로 해당 출처 보호를 추론 기록이 우회해서는 안 된다. 재검토 큐에는 모델 응답이 아닌 host가 고정한 전제 revision과 정책 revision을 저장한다.

## 상세 계약과 검증 대상

아래는 위 초안의 단일 proposal 및 불완전한 receipt 열을 구체화한 계약이다. A 검토 결과가 반영되기 전에는 구현하지 않는다.

### 입력·기록·전제

`ConclusionProposal`은 기존 subject/kind/key/text와 reasoningKind 및 전제 id/revision만 받는다. 모델이 status, evidence, sourceProofs, support, agentId를 공급하면 strict parser에서 거부한다. host는 현재 적격 전제에서 원문 인용과 증명을 합치고 원본 사용자 entry id를 중복 제거한다. 추론은 항상 inferred다. 같은 원문에서 파생된 전제 두 개를 독립된 두 경험으로 세지 않는다. 기존 명시적 사실은 추론이 덮어쓰지 못한다.

`EngineRecord.reasoning`은 kind와 전제 목록을 보존한다. 추론 receipt는 직접 관찰 receipt와 별도 검증한다. MODIFY `engine/records.ts`, `engine/receipts.ts`, `engine/provenance.ts`, `engine/validation.ts`, `engine/audit.ts`가 모두 이 구분을 소비한다. v3 audit는 추론 메타데이터를 허용하지 않는다. v4 audit는 history와 current 양쪽의 전제/receipt/projection을 검사한다. 새 전제 edge를 넣기 전에 현재 전제 및 결론 revision도 history에 보존하여 FK가 가리킬 실재 행을 확보한다.

`applyConclusions`는 최대 기존 ENGINE_BATCH_MAX의 proposal을 한 transaction에 검증·저장한다. 입력 전제는 claim 시점에 존재한 기록만 허용한다. 같은 batch의 신규 결론을 전제로 삼지 못하며 동일 slot 중복도 거부한다. 빈 결과도 unchanged receipt로 완료한다. 연역 결과를 귀납이 쓸 때는 연역 commit 뒤 새 snapshot을 고정한다. receipt 재생에는 입력과 출력 fingerprint 모두 일치해야 하고 같은 requestId의 다른 payload는 conflict다.

전제 수정은 역방향 edge를 따라 자손을 같은 commit에서 무효화한다. 이 무효화는 관련 없는 원문에 global fence를 만들지 않는다. 사용자의 기존 명시적 forget 경로만 기존 원문 fence 의미를 유지한다. 만료·공개범위 변경은 DB write 없이도 생기므로 read/recall은 전제의 현재 revision·상태·출처를 재귀 검사한다. 역사적으로 타당한 만료 기록을 시작 audit가 손상으로 오인하지 않는다. 오래된 전제 참조가 활성 결론에 남으면 조회 대상에서 제외한다.

### 내구 작업과 호출 경계

jobs의 고정 입력에는 stage(deduction/induction), algorithmVersion, policyRevision, modelSettingsRevision, 전제 snapshot, 원문 증명, expectedRevision을 저장한다. receipt에는 이 정규 입력 및 정규 출력 JSON과 각 hash를 함께 저장하여 startup audit가 성공 상태를 재구성할 수 있게 한다. claim_token은 host가 만들며 commit 시 현재 token 및 state를 CAS로 검사한다. attempts/next_due/result_revision은 안전 정수로 검사한다.

직접 기록 id/revision 집합과 정책·모델 설정 revision으로 trigger fingerprint를 만든다. 원문 관찰 commit 뒤 별도 enqueue가 중단돼도 다음 run/reopen에서 같은 집합으로 누락 job을 복원한다. 추론 결과만으로 새 trigger를 만들지 않는다. 연역 완료 receipt는 후속 귀납 enqueue의 근거이며 재시작 때 누락된 후속 작업을 복원한다. 전체 입력은 예산에 맞는 고정 page로 나누고 coverage/cursor를 저장한다. 첫 page만 처리하고 전체 완료라고 표시하지 않는다.

모델 호출은 transaction 밖에서 수행한다. 응답 commit 직전에 claim, engine revision, policy/model revision, 원문 증명과 configure epoch를 다시 확인한다. stale은 withheld로 종료하고 변경된 입력에서 새 작업을 만든다. close는 abort하고 호출 종료를 기다린다. 재시작 시 running과 receipt를 대조한다. receipt가 없으면 이전 모델 호출 여부는 unknown이며 기존 관찰 큐와 같은 제한된 재시도만 허용한다. 중복 모델 호출 가능성과 중복 결론 commit 방지는 별개로 표시한다. retry 상한을 넘으면 failed로 남긴다.

기존 Companion run loop만 두 종류 큐를 진행한다. NEW consolidation.ts는 engine DB 작업 저장을 맡고 별도 timer나 daemon을 만들지 않는다. MODIFY `packages/lina-runtime/src/session-app.ts`는 실제 services.reasonMemory와 routeInfo/settings revision getter를 Companion configure의 선택적 세 번째 인자로 공급한다. 기존 observe-only 구성은 그대로 동작하며 추론 서비스가 없으면 unavailable 상태를 표시한다. 시험용 함수만 추가하고 실제 runtime 연결을 미루지 않는다.

### 정책 소유권과 후속 단계 변경

070에 있던 NEW `packages/lina-runtime/src/context/policy-settings.ts`와 관련 저장 테스트를 이 단위로 앞당긴다. 모델 설정과 별도 revision을 가진 strict versioned SQLite JSON/CAS store다. 초기 memory 정책은 재검토 활성화, bounded query rounds, 입력/출력 한도와 기존 retry 한도를 명시한다. 기본 한도는 기존 query/관찰 제한을 재사용하고 새 유료 실행 주기나 제품 예산을 정하지 않는다. 경로는 runtime owner가 주입하며 테스트는 임시 DB만 사용한다. session-app은 자기 소유 store만 닫고 주입된 공유 owner를 닫지 않는다. 070은 installation owner 조립 및 API PATCH로 확장하며 별도 정책 DB를 중복 생성하지 않는다.

### 조회·상태·실패 증거

memory-query는 정책상 제한된 반복 검색에서 원문과 전제 chain, provisional 여부, 검색 coverage를 전달한다. query는 쓰지 않는다. 각 round와 최종 delivery에서 revision/출처 검사를 유지한다. Companion의 cached recall에는 engine revision을 함께 저장해 원문 정책이 같아도 정정된 결론이 다음 답변에 재사용되지 않게 한다. detail에는 consolidation pending/running/failed/withheld/committed, unavailable, 마지막 오류와 coverage를 기존 observation 상태와 구분해 표시한다.

검증은 새 테스트의 red 기록부터 시작한다. 실제 임시 파일 DB의 v3→v4/reopen, 잘못된 edge/receipt/hash/안전 정수, A→B→C 정정, source revocation 중 late reply, 중복 episode/동일 원문 전제, explicit 우선, cycle, expired 전제, batch rollback, 빈 결과 replay, enqueue 전 crash, running 복구, 두 claim 경쟁, policy 변경 및 close 취소를 포함한다. Runtime은 관찰→연역→귀납→저장→query→정정 후 cached recall 제거를 signal 기반 fake provider로 검증한다. 실제 모델 품질은 이 증거에 포함되지 않는다.

## A 중 메인 소스 검사

기존 `applyOne`은 동일 값·동일 원문 관찰에도 record revision을 갱신한다. 이 상태에서 id/revision만 trigger로 쓰면 반복이 새 재검토가 된다. 동일 value와 정규화한 인용·증명·사용자 source 집합이 같으면 기존 record를 그대로 두고 관찰 처리 receipt만 commit하도록 바꾼다. 실제 새 인용/증명·정정은 record revision 변경과 자손 무효화를 수행한다. 테스트는 서로 다른 requestId로 같은 관찰을 적용해 record revision 및 모델 호출 수가 증가하지 않는지 확인한다.

기존 조회·관찰·출처 검사의 출발점은 74 pass / 0 fail / 322 assertions다. 실제 새 추론 검증은 아니며 로그는 `.codexclaw/evidence/01a08149-2fcd-7b83-b427-a104f083df05/memory-baseline.log`에 있다. 구조 검사기는 앞선 번호의 NEW를 후속 MODIFY 대상으로 허용하도록 보완했다. 경로/순서 검사일 뿐 의미적 완결성을 증명하지 않는다.

## 독립 A 검토 반영: 앞선 초안보다 우선하는 계약

검토자 Auditor(`01a081f6-df22-7172-bd04-7e145e075fa4`)의 첫 판정은 FAIL이었다. 다음을 반영해 재검토한다. 단위 범위 축소나 실제 모델 품질 통과로 해석하지 않는다.

1. **전제 내용과 관찰 receipt 분리.** premise ref는 `{recordId,revision,contentHash}`다. contentHash는 subject/kind/key/text/evidence/status/generation을 정규화해 계산한다. revision은 당시 history 원문을 고정한다. 현재 적격성은 같은 contentHash 및 현재 원문 권한을 검사한다. 같은 내용에 새로운 사용자 원문이 추가되는 것은 support 검토의 입력이며 결론의 내용 전제를 즉시 깨뜨리지 않는다. 모델 commit CAS는 고정 전제의 정확한 revision을 검사한다. 같은 내용의 인용/증명까지 동일한 재처리는 record를 쓰지 않는다. trigger는 직접 기록의 contentHash와 정규화한 source/support 집합을 사용하고 receipt revision 자체를 쓰지 않는다. 중복 entry/중복 quote는 한 번만 센다. 서로 다른 episode의 재진술만으로 귀납 결론을 확정하지 않는 규칙은 아래 support 상한으로 보장한다.
2. **전체 맥락 증명.** claim의 promptProofs는 모든 제공 기록 및 검색/확장 원문의 증명 합집합이다. 결론 sourceProofs는 promptProofs와 선택 전제의 역사적 증명을 합친 host 값이다. 인용 source 목록과 consulted proof 목록은 별개다. receipt는 각 검색 요청·결과 id/revision과 원문 proof를 정규 입력으로 저장한다. 인용하지 않은 맥락의 철회도 read/late commit을 막는다.
3. **추론 망각.** MODIFY store.invalidate 자체가 reasoning 기록이면 해당 결론과 전이적 자손만 철회하고 engine_fences에는 쓰지 않는다. public retract와 applyOne의 retracted 관찰 경로 모두 이 분기를 사용한다. 별도 결론 fence는 해당 slot/content/source fingerprint의 재학습을 막는다. 이는 engine_slot_fences에 결론 id와 원문 entry를 넣어 표현하며 원본 record에는 영향을 주지 않는다. 새로 허용된 근거가 있어도 기존 fenced 원문을 끼워 결론을 복원할 수 없다. 직접 기록 retract는 기존 global 원문 망각을 유지한다. applyOne correction은 slot fence에 더해 reverse edge 무효화를 수행한다. cycle 검사는 revision별 vertex만 보지 않고 record id ancestry를 검사한다.
4. **작업 identity와 CAS.** trigger는 모든 적격 active 직접 기록의 의미·source/support 집합이다. expectedRevision은 trigger fingerprint에서 제외하며 매 claim 때 고정한다. unrelated write로 CAS가 실패하면 같은 job을 stale-pending으로 되돌려 fresh snapshot으로 제한된 재시도한다. policy/source/content가 달라지면 withheld로 닫고 다른 trigger를 만든다. 재시도 상한은 동일 job에 누적된다. 새 trigger 생성 transaction은 이전 pending/running trigger를 superseded-withheld로 닫아 늦은 token commit을 거부한다.
5. **원자적 재검토 신호.** 네 번째 v4 테이블 `engine_reasoning_checkpoint(id INTEGER PRIMARY KEY CHECK(id=1), dirty_revision INTEGER NOT NULL)`를 추가한다. 직접 record가 실제 바뀌는 apply/retract transaction에서 dirty_revision을 갱신한다. coordinator는 이 marker와 현재 policy/model snapshot으로 최초 job을 만들고 marker 처리 상태를 job 입력에 함께 보존한다. 원문 commit과 재검토 필요 신호 사이에 crash gap은 없다. 연역 receipt commit과 귀납 pending row 생성은 같은 transaction이다. 정책 변경만으로도 coordinator가 새로운 trigger를 만들 수 있다. running 복구는 receipt와 token을 대조하며 이미 committed인 job의 모델을 다시 호출하지 않는다.
6. **전용 provider 경로.** `ContextServices.consolidate(text,signal,beforeDispatch,routeRequest?,maxTokens?)`를 추가한다. 기존 `reflection` 역할의 설정·4등급 해석을 사용하되 system prompt는 별도다. 구조 출력은 `{queries:[...]}` 또는 `{proposals:[...]}` 중 하나만 허용한다. session-app은 reasonMemory 대신 consolidate를 configure에 넣는다. output token 한도는 services.roleCall의 maxTokens까지 전달하며 반환 문자열을 자르는 것을 요청 예산 검증으로 삼지 않는다. loopback HTTP 테스트가 실제 system prompt/모델/effort/max output을 확인한다.
7. **추론 support 상한.** 귀납 결론은 항상 provisional이다. 연역 결론은 모든 전제가 supported이고 각 전제가 explicit 또는 supported deduction일 때만 supported가 될 수 있다. 그 밖에는 provisional이다. parseRecord는 reasoning 분기에서 이 host 계산을 검증하고 audit는 history 전제와 대조한다. 원문 entry 수만으로 추론을 승격하지 않는다. 신규 inferred 기록에서 stable identity나 authored persona 변경을 제안할 권한은 없다.
8. **단계별 탐색·coverage.** 각 연역/귀납 stage는 기본 후보 page 이후 적격 기억 검색과 전제 chain/원문 확장을 요청할 수 있다. policy의 maxSearchRounds/maxVisits/inputChars/maxOutputTokens 범위에서 실행하고 최종 결론 또는 budget-exhausted 상태로 끝낸다. 조회된 전체 맥락은2번에 따라 receipt에 고정한다. page는 engine의 id cursor 조회로 만들며 snapshot의200개 제한을 전체 집합으로 오인하지 않는다. stage/page 완료와 전체 trigger coverage 완료를 구분한다. page 진행은 자체 결과 commit 때문에 재시작하지 않으며 새 직접 입력이 들어올 때만 trigger를 교체한다.

정책은 주입된 installation owner가 있으면 그 snapshot을 쓴다. 주입이 없으면 version1/revision0의 불변 기본 정책을 메모리에서 사용하고 방마다 정책 DB를 만들지 않는다. policy-settings.ts의 저장 owner는 임시 DB로 독립 검증하고070에서 installation path 및 API에 조립한다. 이는020의 서비스 활성화를 미루는 뜻이 아니다. session-app의 기본 policy로 consolidate가 작동하며 caller가 policy owner를 주입할 수도 있다.

Migration audit의 기존 version===3 검사는 version>=3으로 바꾸고 v4 전용 검사를 추가한다. 추론 requestId는 전용 namespace와 receipt table로 분리하며 hasReasoningReceipt/withheld 조회를 제공한다. 한 transaction에서 같은 record를 여러 번 변경하더라도 history는 최종 상태 하나를 저장하도록 mutation을 모은다. v4 migration 당시 revision을 engine_meta의 reasoning_migration_revision에 저장한다. 그보다 큰 revision에서만 current/history 동일(id,revision)의 JSON 불일치를 startup에서 거부한다. 기존 v3가 같은 transaction 안에서 만들 수 있었던 불일치는 원형으로 보존하며 새 전제는 current를 정확히 고정한 별도 입력 snapshot으로 검증한다. timestamps/attempts/revisions와 모든 checkpoint/job 숫자도 범위를 검사한다.

추가 red 사례: 새로운 episode에서 같은 내용 재확인→기존 결론 유지, 두 provisional 전제→provisional 결론, inference만 forget→원본/형제 유지 및 같은 근거 재학습 차단, uncited prompt 철회, unrelated write 후 동일 job 재claim, marker 저장 후 kill/reopen, 실 API의 dedicated system prompt와 출력 한도. 기존74개에 lifecycle baseline17개(97 assertions)도 통과했다. 두 로그는 분리 보존하며 새 구현 증거로 합산하지 않는다.

A 잔여 수정: 관찰 결과의 retracted 상태로 inferred slot을 잊는 경우도 원본/형제를 보존하는 red를 작성한다. v3 동일(id,revision)의 history/current 불일치 fixture도 정상 이전돼야 한다. support 상한의 전제 조회는 applyConclusions/audit가 담당한다. store의 새 id-cursor read는 coverage 계산에 사용한다. 지속적인 새 대화로 superseded가 반복되면 consolidation은 pending/withheld로 남을 수 있으며 완료라고 표시하지 않는다. 동일 관찰 no-op은 updatedAt과 ranking 보존까지 검사한다.

## B 중간 구현 기록

11588d4는 동일 근거 재처리 시 premise revision을 보존한다. 2916005는 정정 뒤 cached recall을 거부한다. 35f3b7f의 전제 검증과7975195의 내구 작업 큐는 단위 검증을 마쳤다. 13bd989는 전용 consolidate 서비스와 정책 저장 owner다. child의 실제 loopback HTTP 검증과 로컬 타입 검사는 통과했으며 유료 모델을 호출하지 않았다.

v4 migration/checkpoint 및 receipt audit를 연결하는 작업은 계속 진행 중이다. 같은 transaction에서 record를 여러 번 바꿀 때 중간 상태를 history에 잘못 남기는 사례는 red로 재현하고 수정했다. 기존 v3의 같은 형태는 migration revision 경계로 보존한다. memory-v4-scope.log는144 pass/0 fail/680 assertions, memory-v4-types.log는 exit0다. 이 증거는 결론 apply·실제 Companion 재검토·다음 답변·재시작 end-to-end 완료를 뜻하지 않는다. 해당 연결은 아직 남아 있으며 memory-proof를 충족했다고 표시하지 않는다.

## B 검토 수정과 남은 연결

독립 코드 검토는 구현된 기초 범위 PASS였다. 재등장한 superseded trigger 재개, batch 안에서 다른 결론의 전제를 바꾸는 입력 거부, 넓은 전제의 대표 인용을 고쳤다. 결론 sources에는 전제별 대표 인용 한 개를 담고 전체 원문은 premise history/sourceProofs에 유지한다. 출처 노출 권한을 인용 수에 맞춰 축소하지 않는다. 반영 전13 pass/3 fail, 반영 후16 pass/0 fail이었다.

재시작 중 결과 unknown인 모델 호출도 소비한 attempt로 센다. 마지막 attempt에서 중단되면 interrupted_outcome_unknown/failed를 유지하며 자동으로 호출 한도를 늘리지 않는다. 기존 observation queue의 allowance 증가를 그대로 복제하지 않기로 했다. 완료 receipt가 있으면 재호출 없이 복구한다. 이 차이는 무한 crash 재시도의 호출 증가를 막기 위한 결정이며 새 정책 revision 또는 후속 명시적 retry가 필요하다. closed status는 기존 queue도 DB를 읽어 실패하므로 지원된 API라는 검토 전제를 반박했다. close에서는 cached text/proofs를 지운다.

새 `engine_reasoning_inputs(request_id,attempt,fingerprint,data)`는 claim 당시 실제 입력을 내구 저장한다. 검색 확장도 해당 attempt 입력과 provenance를 함께 갱신한다. receipt는 이 row와 완전히 같은 입력인지 audit한다. beginReasoning/applyConclusions는 현재 저장·재열기·정정·추론 망각·대화형 망각·uncited revocation 테스트를 통과했으나 runtime 자동 처리 연결과 end-to-end 검증은 아직 진행 중이다.
