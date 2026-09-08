# 엔진 상태·소유권 계약 초안

2026-09-08 · 독립 감사에서 검토할 설계. 실제 저장/응답을 아직 구현하지 않았다.

## 저장 전략과 범위

현재 Bun/node:sqlite와 openCheckedDatabase를 재사용한다. 개인 기억은 기존 agent binding DB에서 schema v3→v4로 이전한다. 공통 자료 공간은 installation-owned SQLite catalog와 불변 content blob 디렉터리를 사용한다. 외부 OpenViking 서비스·별도 daemon은 필수 요소가 아니다. LINA runtime이 owner이고 Codex 도구는 scoped consumer다. 설치 위치는 기존 installation root 하위이며 사용자 OS 폴더 트리는 공개 계약이 아니다.

초기 자료 입력은 명시적으로 제공된 bytes/text/import descriptor다. 자동 외부 폴더 관찰과 사용자 파일 이동은 하지 않는다. 동일 자료를 여러 collection에서 참조할 수 있다. 일반 source-code repository 수집/checkout은 이 엔진의 책임이 아니다.

## 개인 추론 기록

020 독립 A에서 정밀화한 계약이 이 절의 초안보다 우선한다. 특히 premise contentHash, 전체 consulted proof, inference 전용 망각, support 상한, 원자적 checkpoint, 전용 consolidate 호출은 [020의 감사 반영](020_memory_reasoning.md#독립-a-검토-반영-앞선-초안보다-우선하는-계약)을 따른다.

기존 `Observation`은 직접 원문 기반 입력으로 유지한다. 새 `ConclusionProposal`은 다음 필드를 가진다: `subject`, `kind`, `key`, `text`, `reasoningKind: deduction|induction`, `premises: [{recordId,revision}]`. sourceProofs는 모델 입력 필드가 아니며 owner가 premise에서 계산한다. 직접 user claim과 달리 결론은 항상 inferred다.

`EngineStore.applyConclusions({requestId,expectedRevision,proposals,claim})`가 추론의 쓰기 boundary다. claim은 host가 저장한 작업 입력이며 모델이 만들지 않는다. 전제는 동일 binding의 active/nonexpired/current source record여야 한다. 자신 참조·cycle·누락 전제·다른 agent 참조를 거부한다. 새 결론의 전제 edges는 해당 결론 revision에 묶는다. 동일 requestId/input fingerprint는 replay, 서로 다른 input은 conflict다. 원자적 batch와 빈 결과 receipt, 정확한 저장 열은 [020의 확정 전 상세 계약](020_memory_reasoning.md#상세-계약과-검증-대상)을 따른다.

새 테이블:
- `engine_premises(conclusion_id, conclusion_revision, premise_id, premise_revision)` 복합 PK 및 record_history 참조.
- `engine_reasoning_receipts`: 요청 identity, 정규화한 입력/출력, 정책·모델 설정 revision, 결과 revision과 outcome을 저장한다.
- `engine_reasoning_jobs`: 입력 fingerprint UNIQUE, 고정 입력 JSON, 정책·모델 설정 revision, state, claim token, attempts, next due, error, result revision을 저장한다.
- `engine_reasoning_checkpoint`: 직접 record commit과 함께 재검토 필요 revision을 남기는 singleton이다.

해당 schema validator/audit는 전제의 존재·version 정합·순환과 모든 record projection을 검사한다. 기존 v3 기록은 기존 직접 근거 그대로 유지하며 새 추론 전제를 소급 조작하지 않는다. 변경/철회된 전제로부터 역방향 edge를 순회해 descendants를 model eligibility에서 제외한다. restore 시 job의 claim과 실제 commit receipt를 대조한다. expired lease만으로 결과가 없었다고 단정하지 않는다.

재검토 claim의 입력은 변경된 record revision 집합과 policy revision이다. 모델 호출은 transaction 밖에서 수행한다. commit 직전에 동일 근거와 settings revision을 확인하고 달라졌으면 stale로 재계획한다. 반복 분석은 새 정보가 없는 동일 fingerprint에서 실행하지 않는다. 일반 query는 읽기이며 결론을 조용히 저장하지 않는다.

## 공유 자료 identity와 원문

공개 canonical 주소는 `lina://resources/<resourceId>`로 제안한다. 사람이 읽는 title/path는 별도이며 이름 변경이 canonical id를 바꾸지 않는다. 논리 collection id는 stable하며 순환 containment는 거부한다. parent는 하나이고 추가 모음은 별도 membership relation이다. shared/private 범위는 source policy owner가 관리하며 현재 consumer scope로 필터링한다.

- `resources(id PRIMARY KEY, title, parent_id, current_version, revision, media_type, owner_id, visibility, deleted_at)`.
- `resource_versions(id PRIMARY KEY, resource_id, revision, blob_hash, byte_length, source_json, created_at)`.
- `resource_memberships(collection_id, resource_id)` 복합 PK.
- `resource_derivations(resource_id, version_id, policy_revision, kind, text, source_versions_json, state)` 복합 PK.
- `resource_jobs(id PRIMARY KEY, resource_id, version_id, policy_revision, kind, state, claim_token, error, attempts)`와 동일 작업 UNIQUE.

Blob bytes는 준비 영역에 기록/해시 검증 후 같은 파일시스템에서 atomic rename한다. SQLite transaction이 version과 current pointer를 commit한다. commit 전 중단은 orphan staging, commit 후 중단은 존재하는 blob과 receipt로 복구한다. 시작 시 DB가 가리키는 blob 누락/해시 불일치를 성공 상태로 열지 않는다. 원본 수용과 파생 색인 완료 상태는 별개다.

`put(input, expectedRevision?)`, `read(id, {version?, level, offset, limit})`, `list(collectionId, cursor)`, `move(id,parentId,expectedRevision)`, `search(query,scope,policy)`가 core boundary다. 모든 mutation은 operationId/fingerprint로 idempotent하다. create는 새 stable id를 receipt에 저장한다. read의 `level=brief|overview|content`는 가용성과 revision/coverage를 함께 반환한다. binary 원문은 attachment-like descriptor로 전달하며 모델에 base64 전체를 텍스트 주입하지 않는다.

폴더 개요는 하위 current version 집합을 source_versions로 고정한다. 하위 변경 시 dirty 표시 및 중복 없는 job enqueue를 한 transaction에서 한다. 모델 결과 도착 시 입력 snapshot 불일치면 현재 개요로 활성화하지 않는다. 오래된 개요를 읽는 경우 stale/coverage를 표시하고 제한된 범위에서만 탐색 힌트로 사용한다.

## 검색과 공유 기억

빠른 find는 현재 권한으로 필터한 FTS/title/tag 후보다. search는 query planner→collection brief 후보→overview→필요한 content→rerank 순으로 방문하며 policy가 maxVisits/maxCalls/inputBudget/outputBudget을 제한한다. 예산 소진 시 incomplete와 cursor/근거를 반환한다. 미래 페이지가 있다는 사실을 근거 없는 완전한 검색 결과로 표시하지 않는다. 기본 언어는 고정하지 않으며 한국어 재현 사례를 포함한다.

선택적 vector index는 원본이 아닌 재생성 가능한 파생물이며 encoder/version/dimension을 기록한다. 혼합 인덱스를 같은 공간으로 비교하지 않는다. embedding 서비스가 없을 때도 collection 탐색은 가능해야 한다. 지원 유형의 내용 파악이 실패하면 원본 보존만 성공한 상태를 표시한다.

공유 memory candidate는 resource id/version 또는 명시적 공유 허용 대화 근거를 참조한다. 개인 기억의 임의 record를 공용 DB에 복사하지 않는다. activity kind는 development/research/writing/organization/search/other이며 task id는 optional external reference다. 이 enum은 task routing 명령이 아니다. 파일이 특정 activity에 소속되지 않아도 유효하다.

## API·도구 계약

기존 web/Fleet controller 인증/Origin 검사를 재사용한다. UI가 사용 가능한 엔진 계약은 settings revision, effective route, storage/index state, lastError와 retryability를 노출한다. 새 API 초안은 `/api/resources`, `/api/resources/:id`, `/api/resources/:id/content`, `/api/resources/search`, `/api/resources/jobs/:id/retry`이며 source는 `runtime/fleet/resource-routes.ts`다. 요청은 기존 same-origin proxy 범위에서 처리한다.

도구 이름은 `lina_resource_list`, `lina_resource_read`, `lina_resource_search`, `lina_resource_put`, `lina_resource_move`로 제안한다. caller identity/scope는 host가 공급한다. 모델이 scope를 넓히는 인자를 받지 않는다. read 도구는 existing confirm-mode auto allowlist에 실제 등록하고 실행 경로 회귀 테스트를 작성한다. 쓰기/삭제는 기존 approval contract를 사용한다. Codex dynamic tools와 Lina 앱이 동일 owner를 공유하며 별도 task 생성 없이 호출 가능하다.

## 부정 경로와 검증

각 store: file DB reopen, unknown schema, dangling source/version, repeated operationId with different payload, stale revision and competing process mutation을 재현한다. Runtime: scope change during model call, cancel before/after commit, service close, index unavailable, unsupported parser와 late reply를 재현한다. 모든 경우 old/current 결과를 혼동하지 않고 authoritative receipt와 상태가 맞아야 한다.

개인 추론·공유 자료·LIFE의 범위를 섞는 host 권한 우회는 in-process privileged code의 책임이다. 구조화된 모델 출력 검증만으로 임의 호스트 코드의 우회를 막는다고 주장하지 않는다. 공개 도구/API boundary와 저장 invariant는 부정 테스트로 검사한다.

## 정식 감사 반영 계약

`policy_revision`은 파생 작업 생성 시 engine policy settings의 저장 revision이며 modelSettingsRevision과 별개다. policy owner는 runtime/context/policy-settings.ts의 내장 SQLite store다. resources.owner_id는 생성 시 host가 공급한 principalId다. 다른 principal은 shared 자료만 사용할 수 있고 private 조회는 principalId 일치가 필요하다.

공유 기억은 요약 derivation과 분리한 `resource_memories(id PRIMARY KEY,resource_id,version_id,policy_revision,proposer_id,visibility,kind,text,evidence_json,state,revision,fingerprint,UNIQUE(resource_id,version_id,policy_revision,fingerprint))`에 저장한다. 동일 원문 version에서 여러 기억을 만들 수 있다. memory job의 완료 receipt는 생성한 memory id 목록을 가진다. resource_derivations는 brief/overview/extract/embedding의 파생 표현에만 사용한다. LIFE resource activity는 해당 memory 또는 resource version을 stable id와 revision으로 참조하며 허용 근거를 따로 검증한다.
