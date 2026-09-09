# 030 — 개인 성장과 월드 순환

## 실행 범위

Satisfy-spec/C4 사이클이다. 사용자가 승인한 자체 엔진 완성 작업에서 memory D의 다음 방향을 이어받는다. 목표는 작성 정체성을 보존하면서 검증된 개인 성장과 LIFE 성장을 일반 대화·행동·게시글 작성에 일관되게 전달하는 것이다. UI, 모델 품질 인증, 공통 자료 활동과 tier 연결(070), 푸시·머지·배포·설치 데이터 변경은 범위 밖이다. 별도 시간·토큰 예산은 지정되지 않았다.

계획은 이 문서, 실행·감사·검증 증거는 `.codexclaw/evidence/01a08149-2fcd-7b83-b427-a104f083df05/persona-*`에 남긴다. 수용 조건과 관련 회귀 검사가 통과하면 이 단위를 닫고 context로 진행한다. 실패는 원인과 미충족 조건을 기록하며 완료로 바꾸지 않는다. 제품 의미를 바꾸는 미정 권한은 사용자 판단이 필요하고, 통상 구현 선택은 main이 결정한다. 구현 위임은 P에서 쓰기 범위를 확정한 뒤 수행하며, 서로 다른 두 담당이 같은 과제에 실패하면 main이 회수한다.

memory D의 결론은 `7aa4229`에서 590개 범위 테스트와 타입·lint·빌드 검증 통과이며, 다음 방향은 “origin-specific memory and LIFE growth composed without exposing events/secrets”다. 이 단위는 그 방향을 유지한다. 일반 source of truth 갱신 대상은 `docs/ARCHITECTURE.md`와 `docs/PERSONA_CONTEXT.md`다.

## 현재 소스에서 확인한 계획 보완점

- `runtime/persona/hooks.ts`의 snapshot은 nativeDynamics일 때 빈 Dynamics를 사용한다. nativeState는 성장 조회 도구에서만 읽는다. 일반 대화 입력의 현재 개인 성향 투영을 추가해야 한다.
- 실제 LIFE persona 직렬화는 `core/world/autonomy-views.ts::buildLifeModelInput()`에 있다. `runtime/life/actor.ts`만 수정해서는 actor·target·reflection의 입력이 바뀌지 않는다. 이 경로와 `fleet/life-runtime.ts::fleetPublicationAuthor()`를 변경 지도에 포함한다.
- `EngineRecord`의 self/relationship text는 구조화된 공개 성향이 아니다. 원문·근거·개인 사실을 그대로 LIFE 또는 게시글 입력으로 보내지 않는다. 상대별 관계도 자유문장의 이름을 agent id로 추측하지 않는다. 공유용 투영은 허용된 dimension/target과 검증된 값만 내보내고 출처 검사는 host에 남겨야 한다.
- IdentityPolicySnapshot에 revision 참조만 추가하면 실제 개인 성장 값의 생성·저장·동결 경로가 빠진다. P에서 이 경로를 확정한 후 A로 진행한다. v1 저장 기록을 현재 인격으로 다시 해석하지 않는다.

기존 기준 검사 `bun test packages/lina-core/test/life-persona.test.ts packages/lina-core/test/life-persona-v1-reopen.test.ts packages/lina-core/test/life-autonomy-persona.test.ts packages/lina-runtime/test/life-persona-hooks.test.ts packages/lina-runtime/test/persona-runtime.test.ts`는 exit 0, 7 pass/44 assertions다. 경로를 직접 지정하여 기존 persona/LIFE 투영과 v1 복원을 검사했으며 아직 새 연결을 검증하지는 않는다. 로그는 `persona-baseline.log`다.

추가 수용 시나리오: native 자기 성향 생성 후 일반 요청에 반영; 동일 원문을 다른 request id로 재처리해도 성장 근거 증가 없음; 근거 정정·철회·만료 뒤 다음 요청에서 제거; manual/locked 전환 중 응답 도착 시 반영 거부; A→B 관계가 B→A로 복제되지 않음; 원문 비밀 표식이 actor/publication의 공유 성향에 없음; 성장 변경 중 아직 dispatch하지 않은 요청 거부; file DB 재개방 후 과거 step 입력은 동일하고 새 step만 현재 성장 사용. 실제 모델의 해석 품질은 이 합성 테스트와 별도로 표시한다.

## PR #3 연결 검토 기준점 (2026-09-08)

LIFE `cefaffcbb4d767848ace6bc0151b9271bf336bf2`를 상대 계약 기준으로 삼는다. 검토 범위와 CI 증거는 [070의 PR 연결 검토](070_runtime_integration.md#pr-3-연결-검토-기준점-2026-09-08)에 기록했다. 아직 이 포크에 통합하지 않았다.

`fleetLifeIdentity()`는 AgentStore의 profile revision/evolution으로 실행 정체성을 구성하고, `fleetPublicationAuthor()`는 `projectSharedPersona()`의 traits/habits/attitudes를 소비한다. 따라서 일반 대화와 actor뿐 아니라 게시글 작성자도 새 공통 투영의 소비자로 검사해야 한다. LIFE 성장과 대화 성장을 별도 수정 가능한 복제본으로 만들지 않는다. 작성 정체성·manual evolution을 보존하고, 성장 근거 철회 및 revision 변경을 다음 읽기에 반영한다.

사건·비밀은 공통 성향에 넣지 않는다. 일반 대화의 shared-growth/disclosed-life 출처 표시와 기억 엔진의 학습 제외 계약을 유지하며, 회고·요약·재시작 이후에도 허구가 실제 경험으로 다시 저장되지 않는 교차 엔진 테스트를 추가한다. LIFE 자체의 완료 및 별도 CI는 이 결합 수용 조건을 대신하지 않는다.

상태: P 설계 초안. 감사 전이며 구현 완료가 아니다. 단위 `persona`, 선행 `memory`.

현재 실행 설계는 [031 개인 성장 투영](031_persona_projection.md)이다. 아래 초기 설계와 다르면 031의 owner·생성·저장·버전 계약이 우선한다. 특히 revision-only identity 확장은 실제 typed 값과 source stamp를 고정하는 설계로 대체한다.

## 변경 지도

| 작업 | 경로 | 전 → 후 또는 신규 책임 |
| --- | --- | --- |
| MODIFY | `packages/lina-core/src/agents/persona.ts` | 작성 정체성+동적 배열 합성 → 근거 있는 현재 성향과 상대별 태도의 일관된 투영 |
| MODIFY | `packages/lina-core/src/agents/agent-learning.ts` | 개별 변화 수용 → source revision과 경험 id 중복 방지, locked identity 유지 |
| MODIFY | `packages/lina-runtime/src/persona/hooks.ts` | 일반 대화 persona 읽기 → shared current projection과 허용 근거를 매 턴 재검증 |
| MODIFY | `packages/lina-runtime/src/persona/reflection.ts` | 회고 결과 → 직접 사용자 선호/자기 성장/상대 관계의 권한과 반복 근거 분리 |
| MODIFY | `packages/lina-runtime/src/life/actor.ts` | 기존 actor 입력 → 동일한 현재 persona를 사건 해석/선택에 반영 |
| MODIFY | `packages/lina-runtime/src/life/work-bridge.ts` | Codex task receipt만을 통한 연결 → 기존 task 어댑터 보존; 공통 활동 근거 연결은 shared-memory 이후 integration에서 구현 |
| NEW | `packages/lina-runtime/test/persona-world-cycle.test.ts` | 사건 해석→성장→다음 actor/일반 대화 입력에 같은 변화 전달 |

## 필드·상태 흐름

핵심 이름·역할·명시적 lock은 학습이나 LIFE가 변경하지 않는다. LIFE 성장 원본은 기존 world owner에 유지하고 개인 대화 성장은 memory/agent owner에 유지한다. 공통 읽기 projection이 우선순위와 출처를 명시하며 독립적으로 수정 가능한 복제 상태를 만들지 않는다. 관계는 방향과 상대를 가진다. 사건/비밀 원문은 일반 대화의 성향 projection에 들어가지 않는다. 월드 담당이 수정 중인 store/visual 파일은 커밋 기준으로 대조 후 순차 통합한다.

입력은 해당 boundary에서 검증하고 저장 owner가 schema/revision/참조를 검증한다. 새 상태는 API/도구 출력과 실제 consumer까지 전달한다. 임의 JSON으로 권한을 부여하지 않는다. 구버전·알 수 없는 enum은 명시적으로 처리하고 조용한 기본값으로 데이터 의미를 바꾸지 않는다.

## 활성화와 기대 결과

- 같은 사건에 두 인격의 서로 다른 해석.
- 관계 A→B만 변화.
- retry 경험은 한 번 적용.
- explicit lock과 manual evolution은 유지.
- 일반 요청 직렬화에서 비밀/사건 문장 부재.
- 재시작 뒤 actor와 대화 projection 일치..

## 검증 명령과 증거

각 NEW 테스트의 직접 경로를 `bun test`에 전달하여 실패→구현→통과를 남긴다. 이 문서 작성 시 새 테스트는 없으므로 실행 결과를 주장하지 않는다. 수정된 기존 기능의 affected tests, `bun run typecheck`, `bun run lint`를 수행하고 마지막 acceptance에서 `bun run ci:validate`, `bun run ci:build`와 전체 테스트를 수행한다. 현존 스크립트는 package.json에서 확인했으며 target coverage와 실제 exit code는 실행 시 기록한다.

## 감사와 재검증

공통 상태 계약은 004_contracts.md, 해당 단위의 추가 계약은 아래 사전 감사 수정 절을 따른다. A에서 source/소비자 누락을 검사하고, 각 구현 P에서는 선행 커밋으로 바뀐 타입과 경로를 재검증한다. A 통과 전 구현은 시작하지 않는다.

## 사전 감사 수정: 실제 인격 소비와 LIFE 상태

추가 MODIFY packages/lina-core/src/world/views.ts와 life-types.ts: SharedPersonaView의 기존 lifeRevision/bindingRevision/projectionPolicyRevision을 성장 출처 리비전으로 사용한다. 동일 의미의 growthRevision 필드를 새로 만들지 않는다. views.ts는 이 기존 리비전을 공통 투영에 전달한다. 추가 MODIFY runtime/fleet/life-runtime.ts의 fleetLifeIdentity: 일반 persona projection과 같은 허용된 growth snapshot을 actor 입력에 포함한다. IdentityPolicySnapshot은 기존 v1 decode를 보존하고 v2 profile 항목에 선택적 growthSource={worldId,lifeRevision,bindingRevision,projectionPolicyRevision}와 personalMemoryRevision을 추가한다. 현재 자료가 없으면 null을 명시한다. 실제 성장 값은 actor persona 입력에서 제공하며 policy snapshot에는 현재성 확인에 필요한 참조만 넣는다. 관련 core world identity codec/validation 소비자는 타입/필드 검색으로 같은 단위에서 모두 갱신한다.

in-flight step은 고정된 identity/profile/growth digest를 사용한다. 새 성장 revision이 도착하면 아직 outbound되지 않은 step은 stale로 재계획하고, 이미 수용된 사건을 새 인격으로 재실행하지 않는다. legacy 저장 사건은 당시 버전 decoder로 복원한다. 동일 경험을 native memory와 world 두 곳에 쓰지 않고 origin별 authoritative growth를 공통 projection으로 읽는다.

원본 LIFE의 agents/store.ts·world/store.ts와 persistence dirty 변경은 이 포크에 복사하지 않는다. 해당 owner 변경의 커밋을 확인한 뒤 서로 다른 checkout의 diff를 비교해 통합하며, 기다리는 동안 다른 단위를 진행한다. 공통 파일 변경은 이 포크에서만 수행하고 최종 candidate가 양쪽 계약을 지키는지 검증한다.

## IdentityPolicySnapshot 소비 경로

추가 MODIFY packages/lina-core/src/world/life-validation.ts의 parseIdentityPolicy, life-transition.ts, life-persistence.ts, social-persistence.ts, autonomy-persistence.ts 및 runtime/life/runner.ts, social/service.ts의 typed identity 소비를 대조한다. 기존 v1 기록은 historical read에 그대로 허용하고 새로운 v2는 신규 실행 입력에만 사용한다. growth revision을 요구하는 경로와 legacy replay를 분리한다. SharedPersonaView의 public export와 publication-types.ts도 타입 호환성을 검사한다.

추가 MODIFY `packages/lina-runtime/src/world.ts`의 identityPolicy 인터페이스와 `packages/lina-core/src/world/autonomy-store-types.ts`의 IdentityPolicySnapshot 소비도 v1/v2 계약을 따른다. 공개 view의 기존 lifeRevision을 성장 revision으로 재사용한다.
