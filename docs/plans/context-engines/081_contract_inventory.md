# 081 — UI 기획용 엔진 계약 목록

2026-09-09. [080](080_acceptance.md)의 reference 문서. 독자는 UI 설계자다. [001](001_requirements.md)의 10행과 [004](004_contracts.md)의 저장 계약을 현재 소스 경로에 연결한다. 새 API를 설계하지 않는다. 로컬 테스트·소스 이름만 근거이며 실제 모델 품질·설치본 체감·hosted CI를 완료로 표시하지 않는다.

저장 성공과 처리 완료는 다르다. 자료 PUT/원문 보존이 extract/brief/overview/capture ready를 뜻하지 않는다. 권한은 host scope가 공급하고 클라이언트가 principal을 넓히지 않는다. 구버전 enum은 조용히 바꾸지 않는다.

## 001 10행 대응

| 001 영역 | 현재 소스의 공개 경계 | 상태 | 증명 |
| --- | --- | --- | --- |
| 공통 모델 라우트 | `GET /api/models`, `PATCH /api/models/settings`, `POST /api/models/test`; `resolveModelRoute` | 구현. 대화 역할은 tier 금지 | [companion-routes.ts](../../../packages/lina-runtime/src/fleet/companion-routes.ts), [routes.ts](../../../packages/lina-runtime/src/models/routes.ts), [types.ts](../../../packages/lina-runtime/src/models/types.ts), [model-routes.test.ts](../../../packages/lina-runtime/test/model-routes.test.ts), [services.test.ts](../../../packages/lina-opencodex/test/services.test.ts) |
| 개인 기억 | `GET /api/agents/:id/mind`, `POST /api/agents/:id/mind/retract`, `POST /api/agents/:id/memory`, `lina_memory_query` | 구현. honcho면 migration-required | [companion-routes.ts](../../../packages/lina-runtime/src/fleet/companion-routes.ts), [server.ts](../../../packages/lina-runtime/src/fleet/server.ts), [memory.ts](../../../packages/lina-runtime/src/context/memory.ts), [memory-query.ts](../../../packages/lina-runtime/src/context/memory-query.ts), [engine-reasoning.test.ts](../../../packages/lina-memory/test/engine-reasoning.test.ts), [consolidation.test.ts](../../../packages/lina-memory/test/consolidation.test.ts), [memory-query.test.ts](../../../packages/lina-runtime/test/memory-query.test.ts) |
| 기억 재검토·탐구 | `lina_memory_query`; 엔진 policy `GET/PATCH /api/engines/policy`의 memory 한도 | 구현(질의·정리 job). 별도 재검토 UI 없음 | [memory-query.ts](../../../packages/lina-runtime/src/context/memory-query.ts), [policy-settings.ts](../../../packages/lina-runtime/src/context/policy-settings.ts), [memory-consolidation.test.ts](../../../packages/lina-runtime/test/memory-consolidation.test.ts) |
| 페르소나 | `lina_persona_read` profile/appearance/growth; `PATCH /api/agents/:id`, `POST .../revert` | 구현. 작성 정체성 vs 성장 분리 | [hooks.ts](../../../packages/lina-runtime/src/persona/hooks.ts), [persona.ts](../../../packages/lina-core/src/agents/persona.ts), [server.ts](../../../packages/lina-runtime/src/fleet/server.ts), [persona-native-growth.test.ts](../../../packages/lina-runtime/test/persona-native-growth.test.ts) |
| 월드 연결 | `lina_world_read`; LIFE projection `disclosureRevision` | 구현. 비밀은 별도 공개 행 | [world.ts](../../../packages/lina-runtime/src/world.ts), [context-policy.ts](../../../packages/lina-runtime/src/context-policy.ts), [life-publication-fleet.test.ts](../../../packages/lina-runtime/test/life-publication-fleet.test.ts) |
| 대화 컨텍스트 | `lina_context_update`, `lina_history_search`, `lina_context_expand` | 구현. 요약 완료≠원문 복원 | [tools.ts](../../../packages/lina-runtime/src/context/tools.ts), [context-tree.test.ts](../../../packages/lina-runtime/test/context-tree.test.ts), [context-session-budget.test.ts](../../../packages/lina-runtime/test/context-session-budget.test.ts) |
| 논리적 업무 파일 공간 | `/api/resources`, `/api/agents/:id/resources`; `lina_resource_list/read/search/put/move` | 구현. OS 경로 비공개 | [resource-routes.ts](../../../packages/lina-runtime/src/fleet/resource-routes.ts), [tools.ts](../../../packages/lina-runtime/src/resources/tools.ts), [resources-extraction.test.ts](../../../packages/lina-memory/test/resources-extraction.test.ts), [resources-tools.test.ts](../../../packages/lina-runtime/test/resources-tools.test.ts) |
| 공유 자료·기억 | `lina_resource_memory_read`; 활동 도구/HTTP; job retry | 구현. task id 없이 기록 가능 | [tools.ts](../../../packages/lina-runtime/src/resources/tools.ts), [activity-tools.ts](../../../packages/lina-runtime/src/resources/activity-tools.ts), [resource-memory-provenance.test.ts](../../../packages/lina-memory/test/resource-memory-provenance.test.ts), [resource-activities.test.ts](../../../packages/lina-memory/test/resource-activities.test.ts), [shared-resource-consumers.test.ts](../../../packages/lina-runtime/test/shared-resource-consumers.test.ts) |
| 공통 대화 행동 | `GET /api/onboarding/entry`, intro GET/POST, `lina_select_response`, 첫 답변 지침 | 구현. 지정 대화 모델 품질은 미증명 | [intro-routes.ts](../../../packages/lina-runtime/src/fleet/intro-routes.ts), [first-conversation.ts](../../../packages/lina-runtime/src/persona/first-conversation.ts), [response.ts](../../../packages/lina-runtime/src/policy/response.ts), [persona-first-conversation.test.ts](../../../packages/lina-runtime/test/persona-first-conversation.test.ts), [intro-api.test.ts](../../../packages/lina-runtime/test/intro-api.test.ts) |
| 외부 의존성 정리 | `GET /api/engines/status`; 기억 초기화 409 `MEMORY_MIGRATION_REQUIRED` | 신규 경로는 자체 owner. 기존 honcho는 전환 필요 표시 | [codex-fleet.ts](../../../packages/lina-runtime/src/fleet/codex-fleet.ts), [memory.ts](../../../packages/lina-runtime/src/context/memory.ts), [server.ts](../../../packages/lina-runtime/src/fleet/server.ts) |

## 공통 필드

권한 실패는 보통 403/404, 본문·revision 충돌은 409, 자료 owner 부재는 503 `RESOURCE_STORAGE_UNAVAILABLE`. 범위가 바뀌면 도구가 delivery 전에 거부한다. 재시도는 명시적 retry/새 requestId이며 같은 fingerprint의 다른 본문은 conflict다.

처리 job 상태([job-codec.ts](../../../packages/lina-memory/src/resources/job-codec.ts)): `pending` `prepared` `ready` `failed` `unknown` `unavailable` `stale` `exhausted`. `error`는 nullable 기계 문자열(최대 256). `attempt`는 현재 횟수이고 한도는 job `generation.maxAttempts`다. 이 값은 엔진 정책 `maxAttempts`에서 오며 허용 범위는 1–3, 기본 3이다. 한도 도달 시 `exhausted`/`attempts_exhausted`. 재시도는 `POST /api/resources/jobs/:id/retry`만. 원문 저장 성공과 job ready는 별개다.

엔진 정책 `GET/PATCH /api/engines/policy`([companion-routes.ts](../../../packages/lina-runtime/src/fleet/companion-routes.ts)): `expectedRevision`, resources/memory `enabled`, token 한도, `maxAttempts`(1–3, 기본 3). host가 관리하면 PATCH 409.

## 1. 공통 모델 라우트

- 대화 응답: 지정 conversation 프로필. `resolveModelRoute`는 conversation에 `request.tier`를 거부한다.
- 기억·페르소나·월드·자료 처리: `quick|standard|deep|intensive` 네 등급. 설정 `routes.tiers`가 profileId·reasoning·maxOutputTokens를 가리킨다. LIFE director/actor는 공통 등급 활성 상태에서 `{tier}`를 선택한다. 기존 `{provider,model}` 저장 행은 보존하지만 등급 활성 후 실행하려면 등급으로 갱신해야 한다. 등급 이름을 provider/model로 보내지 않는다. LIFE에 구형 직접 모델 설정이 남으면 상태는 `not_configured`, 게시 요청은 409 `MODEL_NOT_CONFIGURED`를 반환한다. 게시 대기 작업은 설정 수정 전까지 보존한다.
- 읽기: `GET /api/models` → catalog·settings revision·적용값.
- 쓰기: `PATCH /api/models/settings` `{revision, settings}`. stale는 409 「설정이 바뀌었습니다」.
- 시험: `POST /api/models/test` `{profileId, prompt}`. 진행 중 409, 실패 502. 12초 제한.
- UI: 저장된 등급 표시와 에이전트별 override. 내부 역할의 예전 모델/에포트 편집은 전역·에이전트 범위 모두 잠근다. 등급 미구성은 별도 안내하며, 새 tier 편집 화면은 이 목록의 구현이 아니다.

## 2. 개인 기억

- 조회: `GET /api/agents/:agentId/mind` → `available`, 없으면 `room-not-open` / `native-memory-disabled`.
- 철회: `POST /api/agents/:agentId/mind/retract` `{id, revision}`.
- 활성화: `POST /api/agents/:agentId/memory`. honcho면 409 `code: MEMORY_MIGRATION_REQUIRED`, `migrationRequired: true`. disabled면 `MEMORY_UNAVAILABLE`.
- 상태 스냅샷([memory.ts](../../../packages/lina-runtime/src/context/memory.ts)): `service` disabled/ready/unavailable, `pending/sending/accepted/unknown/failed/withheld`, `migrationRequired`, 성장 처리 오류.
- 도구: `lina_memory_query`. 결론 저장은 host `applyConclusions`이며 모델이 조용히 쓰지 않는다.

## 3. 기억 재검토·탐구

별도 HTTP 화면은 없다. 질의 도구와 consolidation job이 한도와 실패를 가진다. 같은 fingerprint의 반복 분석은 실행하지 않는다. UI는 활성화·한도·진행·실패만 보여 주면 된다.

진행 값은 `MemorySnapshot.consolidation`이다: `state=unavailable|disabled|pending|running|committed|failed|withheld`, 각 상태의 개수, `completedPages`, `totalPages`, `incomplete`, `error`. [ConsolidationStatus](../../../packages/lina-runtime/src/context/memory-consolidation.ts)와 [ContextChannel.snapshot](../../../packages/lina-runtime/src/context/channel.ts)이 원본 계약이다. 열린 세션의 context snapshot에서 `memory.consolidation`을 읽으며, `POST /api/agents/:id/memory`의 준비 성공 응답도 같은 기억 스냅샷을 반환한다. 이 POST는 상태 조회 전용 API가 아니라 세션 준비 경로다.

## 4. 페르소나

- 고정: 이름·역할·목소리·전기·외형·lock. 성장이 권한·정체성을 덮지 않는다.
- 읽기: `lina_persona_read` `section=profile|appearance|growth`. growth는 traits/habits/attitudes와 native records. profileRevision 불일치면 거부.
- 작성 갱신: `PATCH /api/agents/:id` `{revision, patch}`. 되돌림 `POST /api/agents/:id/revert` `{revision, changeId}`.
- UI 계약 필드: 핵심 설정, 변화 허용 범위, 현재 profile revision, 적용 여부(공유 성장 vs 대화 learned).

## 5. 월드 연결

- `lina_world_read`: 현재 수신자에게 허용된 허구 정보만. selector 없음.
- 공개는 성격 공유와 분리. `disclosureRevision`이 projection과 어긋나면 전달 전 거부.
- 사건 공개 행이 없으면 전달·게시를 거부한다. 들었다는 사실이 권한이 되지 않는다.

저장된 연결은 `GET /api/life/agents/:agentId/binding`으로 읽는다([binding routes](../../../packages/lina-runtime/src/fleet/life-binding-routes.ts)). `revision`, `projectionPolicyRevision`, `conversationRecipientId`를 가진 바인딩과 현재 처리의 `bindingRevision`·`disclosureRevision`을 [world.ts](../../../packages/lina-runtime/src/world.ts)가 대조한다. 별도의 집계된 `syncStatus` endpoint는 없다. UI가 바인딩 조회 성공만으로 동기화 완료를 표시하면 안 된다. 실제 전송 시 stale 권한이 거부되는 계약이다.

## 6. 대화 컨텍스트

- `lina_context_update`, `lina_history_search`, `lina_context_expand`.
- 요약 트리와 원문 체크포인트는 별개다. 압축 실패는 원문 삭제가 아니다. 재시작 후 결정 이유 복원은 context 테스트 경로의 로컬 증거다.

## 7. 논리적 자료 공간

주소 `lina://resources/<id>`. title 변경이 id를 바꾸지 않는다. 전역과 에이전트 접두 경로가 같은 handler다.

| 방법 | 경로 | 의미 |
| --- | --- | --- |
| GET | `/api/resources` | 목록. collectionId/cursor/limit |
| POST | `/api/resources` | 생성. text 또는 base64 하나 |
| GET | `/api/resources/search` | 검색. 의미 서비스 없으면 `incomplete`, `reasons: ["semantic_service_unconfigured"]` |
| GET | `/api/resources/:id` | 메타 + jobs |
| PATCH | `/api/resources/:id` | 갱신. expectedRevision |
| DELETE | `/api/resources/:id` | 삭제 표시. operationId+expectedRevision |
| GET | `/api/resources/:id/content` | `level=brief|overview|content` 또는 `format=original` 원문 bytes |
| POST | `/api/resources/jobs/:id/retry` | 색인 job 재시도 |

도구: `lina_resource_list`, `lina_resource_read`(level/offset/limit), `lina_resource_search`, `lina_resource_put`, `lina_resource_move`. 읽기는 confirm allowlist, 쓰기는 기존 승인. 바이너리는 descriptor이며 모델에 base64 원문을 넣지 않는다.

읽기 상태: `ready|unavailable`, `stale`, `complete`, `reason`(예: `not_available`, `undecodable_text`). HTML은 파생 extract만 검증 인용에 쓰고 raw markup은 `isResourceText`가 아니다.

## 8. 공유 기억과 자료 활동

- 기억 읽기: `lina_resource_memory_read`. 모델 입력은 id/kind/text/quote/stale/complete/activityKind. 해시·claim은 host ledger.
- 활동 도구: `lina_resource_activity_record|correct|grant|restrict`.
- HTTP: `POST /api/agents/:agentId/resources/activities/{record,correct,grant,restrict}`, `GET .../activities/:activityId`. 전역 `/api/resources/activities`는 귀속 agent 없으면 403.
- 도구/일반 HTTP outcome은 `recorded|failed`만. `verified_result`는 host 확인과 현재 원문/추출 인용을 요구한다. 저장만으로 성공이 되지 않는다.
- 조회 응답: receipt·공유 필드·철회. 원문 본문 없음.
- activityKind는 development/research/writing/organization/search/other. task id는 선택 참조이며 실행 명령이 아니다.

## 9. 온보딩·첫 대화

`GET /api/onboarding/entry`: `firstUser`, `legacyDrafts[]{id,name}`, `resume{id,agentId}|null`.

`GET /api/agents/:agentId/intro`: `room`, `turns`, `userRevision`, `shareUser`, `presets`, `sessionId`.

POST(같은 agent에 동시 409 「응답을 준비하고 있습니다」):

| 경로 | 본문 | 의미 |
| --- | --- | --- |
| `POST /api/agents/:id/intro` | kind, mode | 시작 |
| `.../intro/turn` | roomId, revision, requestId, text | 한 턴. requestId로 중복 방지 |
| `.../intro/finish` | roomId, revision, userRevision, shareUser, skip | 확정 |
| `.../intro/choose` | roomId, revision, userRevision, presetId, birthId, shareUser | 선택·출생 연결 |
| `.../intro/mode` | roomId, revision, mode | 모드 |
| `.../intro/restart` | roomId, revision | 첫 소개만. stale revision 거부 |
| `POST /api/agents/birth` | birthId, presetId/templateId, mode, 선택 draftId | 출생 |

일반 대화의 첫 답변 안내는 [first-conversation.ts](../../../packages/lina-runtime/src/persona/first-conversation.ts). `lina_select_response`는 목적별 안내만 고르고 모델·페르소나·권한을 바꾸지 않는다. 미확인 사용자 정보는 공유하지 않는다.

## 10. 이전·공개·대화 vs 등급

- 자체 자료: `GET /api/engines/status` `resources.state` ready 또는 rejected `RESOURCE_STORAGE_UNAVAILABLE`.
- 기존 외부 기억: 자동 변환하지 않음. 초기화 시 `migrationRequired`.
- 일반 대화 모델은 지정 프로필. 네 등급은 엔진 처리와 LIFE lane. UI가 대화에 tier 선택기를 붙이면 서버가 거부한다.
- 비밀 공개는 LIFE disclosure 행. 페르소나 성장 공유와 사건 공개는 다른 스위치다.

## 의도적 공백

- UI 화면·레이아웃은 미구현. 이 문서는 호출 가능성만 적는다.
- 실제 모델 추출·추론·요약 품질은 별도 승인. 로컬 합성 제공자 테스트는 구조 증거다.
- 의미 검색 서비스가 없으면 불완전 lexical 결과만 온다. 완전 검색으로 표시하지 않는다.
- 자료 HTML 추출은 정적 파싱이다. 계산 CSS·브라우저 실행이 아니다.
- Codex 작업 도구(`lina_task_*`)는 실행 하네스이며 자료 공간의 정의가 아니다.
