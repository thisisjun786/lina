# 031 — 개인 성장 투영의 생성과 소비

상태: persona P 보완 설계. 030의 revision-only 설계를 이 문서로 대체한다. 수용 조건과 실행 범위는 030을 따른다.

## 소유권과 데이터

개인 성장의 authoritative owner는 AgentStore다. 기억 원본과 결론은 EngineStore, 허구 경험과 성장은 WorldStore에 남긴다. AgentStore에는 기억 원문을 복사하지 않고 해석 결과와 원본 참조를 보관한다. WorldStore에 개인 성장의 두 번째 수정 가능한 테이블을 만들지 않는다.

개인 대화용 현재 성향은 적격 self/relationship 기록을 검증해 읽는다. subject=user는 persona authority가 아니다. provisional 기록은 잠정 배경으로 표시하며 안정된 행동으로 승격하지 않는다. manual evolution에서는 동적 성향을 적용하지 않는다. world가 없는 대화에서도 이 개인 투영은 유효하다. 관계의 자유문장을 특정 agent id로 추측하지 않는다.

공유용 개인 성향은 별도의 제한된 해석 결과다. 모델은 등록된 LifeDefinition의 공유 허용 dimension만 선택할 수 있다. 출력은 trait(axisId, value), habit(habitId, value), attitude(axisId, toAgentId, value), 그리고 근거 record id 목록이다. 임의 label/text/quote/비밀/권한은 출력 필드가 아니다. label은 host가 당시 정의에서 가져오고 숫자 범위·boolean·참여자 id·방향을 검증한다. authored identity 또는 manual/explicit lock 변경 권한은 없다. 원본 self/relationship의 지원된 현재 기록만 근거로 쓴다. 일반 사용자 사실과 LIFE-derived 대화는 입력에서 제외한다.

AgentStore v3에 agent_behavior_jobs와 agent_behavior_receipts를 추가한다. job은 agent/world/profile revision, definition/projection digest, memory record의 id/revision/contentHash와 적격 source proof digest, 정책·모델 revision, 요청 fingerprint, 상태·attempt를 고정한다. receipt는 정확한 typed output과 고정 입력을 묶는다. 같은 source content로 request id만 바꿔도 새 성장 근거가 되지 않는다. receipt의 원본 참조는 새 읽기마다 runtime의 현재 EngineStore로 검사한다. 취소·철회·만료로 부적격해지면 과거 receipt를 지우지 않고 현재 projection에서 제외한다.

job 상태는 pending/prepared/committed/failed/withheld다. claim은 durable하게 prepared로 저장한 뒤 모델을 호출한다. receipt와 committed 전환은 같은 transaction이다. prepared 상태로 재시작하면 결과가 없다고 단정하지 않고 failed/unknown 진단과 소비된 attempt를 남긴다. retry는 기존 memory 정책의 maxAttempts 안에서만 허용한다. 정책·profile·definition·source가 달라지면 withheld이며 다음 최신 입력 fingerprint만 새 job으로 생성한다. 빈 출력도 receipt를 남겨 동일 입력 재호출을 막는다.

원본 statement와 숫자 성향 사이의 모델 판단은 실제 모델 품질 검증 대상이다. strict typed output 검사는 문장 누출과 임의 dimension 생성을 막지만 판단의 타당성을 보증하지 않는다. 이 제한을 기능 증거에 명시한다.

## 공통 행동 합성

CurrentPersonaSnapshot은 새로운 버전 1 계약이며 기존 SharedPersonaView v1의 의미를 변경하지 않는다. worldView, personalBehavior, sourceStamp, composedBehavior와 truncated를 가진다. 모델에는 composedBehavior만 직렬화하고 원본 참조·stamp는 host가 보관한다.

숫자 dimension은 clamp(worldCurrent + personalValue - authoredInitial, min, max)로 합성한다. 같은 근거를 두 번 더하지 않고 각 origin의 현재 값 하나씩만 읽는다. 개인 근거가 철회되면 worldCurrent로 복귀한다. habit은 해당 dimension에 유효한 LIFE 변화 근거가 있으면 LIFE 값, 없으면 개인 값, 둘 다 없으면 authored initial이다. 이 결정 규칙은 구현 알고리즘이며 세계의 주기·예산·공개 대상을 새 기본값으로 정하지 않는다. named locks/manual과 projection allowlist는 합성보다 우선한다. 관계는 from agent와 명시적 toAgentId를 유지한다.

IdentityPolicySnapshot v2는 profile별 typed personalBehavior와 sourceStamp를 고정한다. sourceStamp는 개인 receipt·memory content·profile·definition·projection의 현재성 digest다. 실제 values도 저장하므로 역사적 replay에서 현재 개인 DB를 읽지 않는다. 과거 v1은 현재 v2로 덮어쓰지 않고 당시 serializer로 유지한다. v1 실행을 복구할 때 새 개인 성향을 끼워 넣지 않는다. 신규 입력은 v2이며 dispatch/commit 직전 current sourceStamp를 대조한다.

## 변경 지도와 전체 경로

| 작업 | 경로 | 책임 |
| --- | --- | --- |
| NEW | `packages/lina-core/src/agents/behavior-types.ts` | typed output, frozen input, receipt, source stamp와 strict 값 parser |
| NEW | `packages/lina-core/src/agents/behavior-store.ts` | AgentStore가 소유하는 jobs/receipts, CAS·replay·current projection·startup audit |
| MODIFY | `packages/lina-core/src/agents/agent-schema.ts` | v0/1/2 감사와 보존 뒤 v3 추가; unknown/corrupt 거부 |
| MODIFY | `packages/lina-core/src/agents/store.ts` | 기존 transaction/lifecycle로 behavior owner 노출 |
| MODIFY | `packages/lina-core/src/agents/persona.ts` | 공통 행동 합성, 개인 대화용 성향, stable authored prefix 보존 |
| MODIFY | `packages/lina-core/src/agents/agent-learning.ts` | legacy 반복 근거에서 request id 대신 독립 source entry 기준 적용 |
| NEW | `packages/lina-runtime/src/persona/native-growth.ts` | EngineStore 적격 근거→고정 job→전용 제한 해석→commit, 현재 source 검사 |
| MODIFY | `packages/lina-runtime/src/context/companion.ts` | 관찰·consolidation 이후 성장 처리 및 drain/close, 별도 무소유 timer 없음 |
| MODIFY | `packages/lina-runtime/src/context/port.ts` | 별도 persona interpretation 서비스 계약 |
| MODIFY | `packages/lina-opencodex/src/services.ts` | reflection role/tier를 재사용한 persona interpretation 호출; 일반 대화 모델 고정 |
| MODIFY | `packages/lina-opencodex/src/prompts.ts` | 허용 dimension/value/evidence만 반환하는 별도 prompt |
| MODIFY | `packages/lina-runtime/src/session-app.ts` | native 성장 producer와 현재 projection 소비 연결 |
| MODIFY | `packages/lina-runtime/src/persona/hooks.ts` | 매 턴 개인+공유 투영과 delivery 재검증; 성장 도구도 같은 projection |
| MODIFY | `packages/lina-runtime/src/persona/reflection.ts` | 기존 legacy path와 native producer 중복 성장 방지, 중립 reference 명칭 |
| MODIFY | `packages/lina-core/src/world/life-types.ts` | IdentityPolicySnapshot v1/v2 분기; SharedPersonaView v1 보존 |
| MODIFY | `packages/lina-core/src/world/life-validation.ts` | 버전별 exact decoder, unknown field/version 거부 |
| MODIFY | `packages/lina-core/src/world/autonomy-views.ts` | actor/director/target/reflection의 공통 합성 행동 직렬화 |
| MODIFY | `packages/lina-core/src/world/views.ts` | 기존 LIFE-only projection 보존, 공통 합성의 정의·lock 입력 제공 |
| MODIFY | `packages/lina-core/src/world/autonomy-persistence.ts` | v2 typed identity 값 저장/복원과 당시 버전 digest 유지 |
| MODIFY | `packages/lina-core/src/world/autonomy-step-records.ts` | v1 역사/새 v2 identity의 정확한 decode |
| MODIFY | `packages/lina-core/src/world/life-persistence.ts` | identity 버전별 transition replay |
| MODIFY | `packages/lina-core/src/world/social-persistence.ts` | identity v2 저장·복원과 과거 v1 유지 |
| MODIFY | `packages/lina-core/src/world/life-transition.ts` | lock/evolution 소비의 버전 독립성 |
| MODIFY | `packages/lina-runtime/src/life/runner.ts` | 준비/dispatch/commit에서 frozen source 현재성 검사 |
| MODIFY | `packages/lina-runtime/src/life/social/service.ts` | identity 소비의 버전 분기 |
| MODIFY | `packages/lina-runtime/src/fleet/life-runtime.ts` | 신규 v2 identity, 게시글 author도 공통 행동 사용, v1 복구 비교 |
| MODIFY | `packages/lina-runtime/src/world.ts` | 대화 projection과 sourceStamp 현재성 전달 |
| MODIFY | `packages/lina-core/src/world/autonomy-store-types.ts` | frozen typed identity 계약 노출 |
| MODIFY | `packages/lina-core/src/world/publication-types.ts` | author의 host-only source stamp를 신규 버전으로 고정; 모델 text에는 미포함 |

생성자는 native-growth, 저장/복원자는 behavior-store와 world identity codecs, 소비자는 persona hooks/autonomy-views/fleet publication author다. 새 enum의 비교·switch뿐 아니라 destructuring·JSON digest·전체 객체 equality 소비도 A와 B에서 검색한다. 전체 installation의 여러 agent owner 초기화/종료·checkpoint는 070의 lifecycle 조립과 함께 연결하되, 이 단위의 session-app 경로와 실제 직렬화 소비를 테스트 없이 넘기지 않는다. inactive agent의 현재 memory owner가 없으면 현재성을 가정하지 않고 개인 투영 unavailable로 표시한다.

## 위임과 검증

main은 runtime producer, hooks, session/fleet 소비를 맡는다. A 통과 뒤 executor는 behavior-types/store와 해당 저장 테스트를 맡고, 다른 executor는 v1/v2 world identity codec과 관련 replay 테스트를 맡는다. AgentStore/schema 통합과 공통 composition은 main이 수행하여 쓰기 충돌을 피한다. 타입 경계는 packet에 동결하고 변경 시 main이 계획을 수정한다.

새 테스트: `packages/lina-core/test/persona-behavior-store.test.ts`, `packages/lina-runtime/test/persona-native-growth.test.ts`, `packages/lina-runtime/test/persona-world-cycle.test.ts`. 단위마다 먼저 실패를 확인하고 구현한다. 030의 기준 검사에 이 경로와 변경된 source의 기존 회귀 검사를 추가한다. 현재 새 파일은 없으므로 실행했다고 주장하지 않는다. C에서 root/browser typecheck, lint, structural plan check와 필요한 runtime build를 기록한다.

조건별 증거: 중복 fingerprint는 모델 호출·commit 수 1; 같은 내용의 여러 request는 독립 근거 수 증가 없음; source 철회·만료는 다음 읽기에서 개인 영향 0; manual/lock 변경은 늦은 결과 commit 거부; raw secret marker는 shared model bytes에 없음; directed relation은 반대 agent에 없음; 입력 변경 중 await는 stale/withheld; file DB 재시작은 같은 receipt와 당시 request bytes; corrupt receipt/unknown schema는 시작 거부; unconfigured dimension/route는 빈 성공 대신 unavailable/not-configured.

권한 검사는 공개 API/도구와 저장 boundary에 적용한다. 임의 in-process host 코드의 우회까지 방지하는 보안 격리라고 주장하지 않는다. 별도 서비스를 설치하거나 사용자 DB를 열어 검증하지 않는다.

## A 준비: 호출·입력 계약

공유 성장 해석 입력은 작성 profile, 현재 공유 dimension 정의, 적격 개인 기록으로 한정한다. LIFE 사건/현재 성장 값을 다시 추론 입력에 넣어 자기 강화 근거를 만들지 않는다. producer의 fingerprint는 profile/definition/projection/policy/model 설정과 선택한 record의 semantic contentHash를 포함한다. 단순 corroboration으로 record revision만 바뀐 경우 같은 의미의 입력을 새 성장으로 세지 않는다. commit guard는 당시 정확한 source revision과 현재 적격성도 검사한다.

behavior owner API는 `enqueue(input)`, `claim(jobId, expectedRevision)`, `commit(claim, output, assertCurrent)`, `fail(claim, reason)`, `recover()`, `current(agentId, worldId, assertCurrent)`, `status(agentId)`다. owner의 transaction 안에서 token/CAS 및 현재 source 검사를 완료한 뒤 receipt를 저장한다. foreign-key owner는 agent_profiles다. runtime이 공급하는 assertCurrent는 MemoryStore의 현재 record/contentHash, source policy, profile/evolution, 공유 definition과 설정을 확인하며 모델이 전달하는 callback이 아니다. 현재성을 확인할 owner가 없으면 unknown을 true로 바꾸지 않는다.

동일 dimension의 개인 값은 최신 적격 receipt의 값 하나를 사용한다. 여러 receipt의 숫자를 누적하지 않는다. 모든 입력 record를 보수적으로 provenance에 묶고, 출력의 evidence record id는 그 부분집합이어야 한다. source-only 교정과 시간 만료도 current()에서 검사하므로 global memory revision만 비교하지 않는다. 저장 시점의 구조·참조·fingerprint 감사와 현재 원문의 적격성 검사는 구분한다. 시작 시 원문 owner가 닫혔다는 이유로 정상 과거 receipt를 손상이라고 판단하지 않으며, 현재 사용은 보류한다.

PublicationAuthor는 현재 버전 필드가 없는 정확한 형식을 legacy로 유지하고, 신규 `{version:2,...legacyFields,sourceStamp}`를 별도 decoder로 읽는다. `publication-record-fields.ts::parsePublicationAuthor`, 이를 사용하는 publication-record-validation/reply-records/posts/jobs와 실제 model/feed allowlist를 함께 검증한다. 기존 `publication-model.ts`는 name/voice/behavior만 직렬화하고 `publication-feed.ts`도 공개 author 필드만 내보내므로 이 allowlist를 보존한다. old author를 decode한 결과에 version/sourceStamp를 자동 추가하지 않아 과거 digest를 유지한다.

## A 1차 검토 반영 (이전 문단과 충돌하면 이 절 우선)

1. PublicationAuthor v2의 nested decoder 경로를 위 호출 계약처럼 확정한다. prepared legacy author는 기존 v1 필드로 현재 profile/LIFE behavior를 재구성해 비교하고, 동일하면 당시 bytes로 dispatch한다. 새 개인 성장은 신규 job부터 사용한다. 기존 authored profile·LIFE·공개 정책 변경은 기존 guard대로 거부한다. 과거 post에는 새 sourceStamp를 덧붙이지 않는다. 추가 MODIFY `packages/lina-core/src/world/publication-record-fields.ts`, `publication-record-validation.ts`, `publication-reply-records.ts`, `publication-posts.ts`, `publication-jobs.ts`, `publication-model.ts`, `publication-feed.ts`. 조건: 파일 DB의 legacy pending job과 published post를 다시 열어 전자는 같은 bytes로 dispatch, 후자는 같은 digest로 조회; v2 stamp는 실제 모델 및 feed bytes에 없음.

2. 현재 EngineRecord의 relationship은 대상 agent id가 없다. 이를 근거로 모델이 agent 대상을 새로 선택하게 하지 않는다. 개인 공유 출력은 traits/habits만 허용하고 attitude 출력은 parser가 거부한다. 방향 있는 agent 관계는 기존 LIFE attitude owner가 생성·보존하고 공통 투영에서 그대로 소비한다. 일반 사용자와의 관계 문장은 개인 대화의 잠정/지원 배경으로만 사용한다. task 없는 활동의 명시적 actor/participant 근거는 060/070의 원래 경로로 연결한다. 관계 기능 자체를 제거하는 것이 아니라 출처 없는 target 부여를 금지하는 결정이다.

3. pending v1 LIFE step은 identity의 저장 버전으로 current profile/lock/LIFE를 비교하고, 허용되면 당시 입력으로 완료한다. 신규 step만 v2를 생성한다. `parseIdentityPolicy` 안의 전용 version decoder만 1|2를 허용하고 공용 LIFE `version()`은 변경하지 않는다. accepted event는 재실행하지 않는다. restore test는 pending v1→완료 한 번→다음 신규 v2 입력 및 old request bytes 불변을 증명한다.

4. reviewer의 “원본 owner가 닫혀도 마지막 개인 값을 계속 사용” 제안은 채택하지 않는다. 원문 철회/만료를 확인할 수 없는데 사용을 허용하면 출처 계약을 어긴다. 대신 runtime의 비동기 준비 단계에서 필요한 원본 owner를 먼저 확보하고 동기 dispatch guard에서 현재성을 검사한다. 저장된 개인 값과 digest를 owner 닫힘만으로 수정하지 않는다. 확보 실패는 실행을 unavailable로 보류하며 개인 값 없는 새 identity로 조용히 바꾸지 않는다.

개인 source lifecycle도 030에서 구현한다: 추가 MODIFY `packages/lina-runtime/src/fleet/manager.ts`, `fleet/life-runtime-installation.ts`, `fleet/codex-fleet.ts`. `session-app.ts`는 native mind/journal이 생성된 뒤 persona hook 설치 전에 source port를 Fleet에 등록하고, 실패·close에서 해당 등록만 해제한다. Fleet는 world에 기존 개인 receipt가 있는 agent의 source가 필요하면 기존 `app(id)` owner를 비동기로 확보한다. 새 추론 호출 없이 저장 검사를 할 수 있어야 한다. 수신자의 개인 데이터는 source port의 host scope에 남긴다. engine_disabled/honcho이면 native owner를 만들어 조용히 전환하지 않는다. receipt가 없으면 개인 값 없음이 확인된 상태이며 owner unavailable과 구분한다.

runner/publication은 비동기 entry의 `ensurePersonalSources(worldId,signal)` 뒤에만 identity/author를 준비한다. 기존 동기 beforePrepare/dispatch/commit guard에서는 promise를 무시하지 않고 등록된 source의 current 검증만 수행한다. 추가 MODIFY `packages/lina-runtime/src/life/publication.ts`와 runner의 publication 조립을 포함한다. 모든 app의 background writer는 기존 installation 종료 순서로 drain하고 새 독립 타이머를 만들지 않는다. 전체 자료 owner/checkpoint 추가는 070에 남지만 개인 성장의 재시작 동작은 이 단위에서 검증한다.

sourceStamp는 opaque content digest와 receipt/profile/definition/projection revision 참조이며 owner availability를 digest에 넣지 않는다. 검증 상태는 별도 diagnostic이다. source expiry는 global memory revision이 같더라도 eligibility guard가 거부한다. receipt는 model request digest를 저장한다. 재시작 request byte 검사는 actual request-capturing fake에서 고정된 입력과 digest를 대조한다. HabitDefinition.initial은 기존 boolean 필드다.

반영 판정: 1·2·3 수용. 4의 churn 결함은 수용하되 검증하지 않은 값 사용이라는 해결책은 출처 계약에 어긋나므로 위 owner 확보 방식으로 대체했다. 이 보완의 closure review 뒤 B로 진행한다.

합성은 label 문자열로 join하지 않는다. `views.ts`의 공통 허용 조건을 내부 helper로 분리하고, 원본 trait/habit id로 개인 값을 결합한 뒤 마지막에 label을 직렬화한다. 같은 label을 가진 다른 id 테스트를 추가한다. 기존 projectSharedPersona는 LIFE-only 의미를 유지하고 새 CurrentPersonaSnapshot만 결합 결과를 반환한다. habit의 LIFE 우선 여부는 값이 initial과 다른지가 아니라 현재 profile revision에 속하는 적격 LIFE 변화 row의 존재로 판단한다. 원래 값으로 돌아온 정식 LIFE 변화도 존중한다.

## A 종료 전 원본 owner 획득 보완

`Fleet.app(id)` 자동 시작은 사용하지 않는다. app 생성은 Codex session과 관찰 큐까지 시작할 수 있으므로 성장 현재성을 읽는 책임에 비해 범위가 크다. 등록된 열린 source port를 우선 사용하고, 없으면 기존 binding/state.sqlite/mind.sqlite를 읽기 전용으로 연다. 새 DB 생성·스키마 이전·큐 복구·모델 호출·Codex 시작·대화 세션 생성은 하지 않는다. 누락/이전 필요/손상/다른 binding은 unavailable이다. 기존 receipt가 없을 때는 조회할 개인 근거가 없다는 상태로 구분한다.

추가 MODIFY `packages/lina-core/src/session-binding.ts`의 checked DB opener에 readOnly 옵션: 기존 안전 경로 검사를 재사용하되 디렉터리/파일을 만들지 않고 SQLite readOnly 연결을 사용한다. 추가 MODIFY `packages/lina-core/src/store.ts`와 `packages/lina-memory/src/engine/store.ts`에 읽기 전용 factory/옵션을 제공한다. 이 경로는 현재 스키마(journal v2/mind v4)를 먼저 확인한 뒤 기존 decoder/audit를 재사용하고, BEGIN read transaction으로 검사하며 WAL 설정·migration·recovery를 실행하지 않는다. public 반환 타입은 읽기/close로 제한하고 SQLite 자체도 쓰기를 거부한다. 이전 스키마는 migration-required로 보류하며 일반 owner가 여는 기존 migration 경로를 변경하지 않는다.

새 `packages/lina-runtime/src/persona/source-owner.ts`는 Fleet의 binding 경로 계산을 사용하며 임의 모델 인자로 파일 경로를 받지 않는다. 현재 읽기 범위에 필요한 owner만 열고 lease/close 책임을 명시한다. 원본 proof 검사와 memory eligibility는 기존 메서드를 재사용하며 SQL을 새로 복제하지 않는다. 읽기 transaction을 await/model 호출 동안 유지하지 않는다. dispatch/commit guard는 최신 읽기를 다시 수행하고, expiry를 현재 clock으로 검사한다. 여러 DB의 정합은 journal proof/current record를 두 번 대조하여 변동 중 결과를 보류한다.

위에서 명시한 async ensurePersonalSources는 이 가벼운 읽기 owner만 확보한다. availability는 digest를 바꾸지 않고, 실패 시 동작을 보류한다. 새 `packages/lina-runtime/test/persona-source-owner.test.ts`와 `packages/lina-core/test/store-readonly.test.ts`에서 inactive agent 재시작 후 읽기 성공, 외래 binding/누락/legacy/corrupt 거부, 가능한 mutation의 실제 SQLite 거부, app/Codex/model factory 호출 0, main DB/WAL의 데이터 불변을 검증한다.

위임 보완: 두 번째 executor는 world codec 대신 이 읽기 전용 opener/store/source-owner와 해당 테스트를 담당한다. 첫 executor는 behavior owner 신규 파일만 유지한다. main이 AgentStore/schema·공통 composition·world codec·runtime producer/consumers를 순차 연결한다. dependency가 없는 새 테스트/모듈만 병렬로 작성하고 동일 파일 쓰기는 하지 않는다.
