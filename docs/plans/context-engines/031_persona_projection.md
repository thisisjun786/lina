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
