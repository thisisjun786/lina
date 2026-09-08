# 051 — 자료 공간의 저장·탐색·실행 계약

상태: resources P. 050/004의 초안을 현재 소스에 맞춰 구체화한다. 구현은 독립 A 이후 시작한다.

## 실행 범위

C4 satisfy-spec. context D(`732bcf1`,492 tests 및 type/lint/docs/build 통과)의 다음 방향인 LLM 중심 비코드 공간을 구현한다. 자료는 task 없이 생성·이동·검색할 수 있다. 전체 owner 조립과 Codex의 host context 연결은060/070, 공유 기억 생성은060이다. 이번 단위는 core 저장·색인·검색과 실제 scoped 도구/API adapter까지 검증한다. 별도 시간/토큰 예산은 없다. 실제 사용자 파일 스캔·이동·외부 provider 실행·설치/푸시/머지/배포는 하지 않는다. SoT는 docs/ARCHITECTURE.md와 새 자료 엔진 계약 문서(기존 docs/plans의050/051)다.

## 기존 구현과 흡수 범위

OpenViking e7f2fe5의 검토된 원리는003의 논리 URI, collection brief/overview, scope 탐색과 query planning/rerank다. 원본 코드를 복사하거나 OpenViking 서버를 새 필수 의존성으로 만들지 않는다. 기존 openviking adapter 퇴역은070이며 이 단위가 존재한다는 이유로 기존 연결을 조용히 삭제하지 않는다.

`core/attachments/filesystem.ts`의 checkedDirectory/readRegular/writeExclusive/fsyncDirectory를 재사용한다. 모델 입력은 OS 경로가 아니다. `extractDocument`는 PDF/DOCX/XLSX를 이미 제한된 child process로 처리한다. 이미지 원본 저장과 이미지 이해는 별개다. PNG/JPEG 설명은 기존 analyzeImage가 있을 때만 요청하고 없으면 unavailable이다. 코드 저장소 checkout/import나 스킬 실행은 이 공간의 역할이 아니다. 문서 안의 코드 인용까지 삭제하지 않는다.

Bun node:sqlite FTS5 trigram을 임시 DB에서 다시 확인했다: 태양광 phrase MATCH1건. 기존 attachment-document/openviking-tools 기준 검사11pass62asserts/2files exit0. 이 증거는 파서·FTS 가용성이지 의미 검색 품질 검증이 아니다.

## identity·권한·버전

주소 `lina://resources/<uuid>`는 이름/위치 변경에 불변이다. resource.kind는 document|collection, primary parent는 collection 또는null이며 depth/cycle을 검증한다. document는 불변 current version을 참조하고 collection은 문서 blob을 가장하지 않는다. 문서의 추가 collection membership은 별도 relation이며 primary parent를 바꾸지 않는다.

ResourceScope는 host가 공급하는 principalId/agentId/allowedVisibilities다. 모델의 args로 scope를 바꾸지 않는다. private는 ownerId가 principalId와 일치해야 하고 shared는 shared grant가 필요하다. shared 자료의 내용 편집은 협업 가능하되 공유 범위 변경과 삭제는 생성 owner만 할 수 있다. ownerId 자체는 불변이다. 공유 자료를 private ancestor 아래 두는 작업은 거부한다. private collection은 같은 owner의 private 하위를 가지며, shared collection의 private 문서는 다른 scope의 목록/검색/개요에서 빠진다.

모든 metadata/content/visibility/delete mutation은 operationId와 정규화 입력 fingerprint로 idempotent하며 다른 입력으로 재사용하면 conflict다. metadata revision은 CAS다. put 새버전에는 당시 owner/visibility를 보관한다. 역사 원문 읽기는 현재 자원의 권한과 당시 버전의 권한을 모두 검사한다. private→shared가 과거 비공개 버전까지 자동 공개하지 않는다. 삭제는 tombstone이며 원문 bytes를 지우지 않는다. 부모/참조가 있는 collection 삭제는 거부한다.

자료 기반 파생 입력은 ResourceVersionRef `{resourceId,resourceRevision,versionId:null|string}`로 고정한다. private 근거에서 shared derivation을 만들지 않는다. 모델의 임의 source label은 권한 증명이 아니다. 일반 supplied text의 의미를 검사해 비밀 여부를 판별한다고 주장하지 않는다. 060/070의 host source context가 개인 기억→공유 자료의 전송 권한을 소유한다.

## 저장과 복구

설치별 SQLite catalog와 불변 hash blob 디렉터리다. 현재 resourceRoot 변수는 배포 asset root이므로 재사용하지 않는다. 새 owner는 명시적 전용 state root를 받는다. Scope는 DB 경로가 아니라 같은 catalog의 접근 범위다.

필수 테이블은 resources, resource_versions, resource_memberships, resource_operations, resource_jobs, resource_derivations, resource_meta와 FTS다. jobs/derivations의 입력 JSON은 현재 resource refs와 policy/model revision을 묶는다. collection 개요는 현재 읽을 수 있는 하위 버전 집합에서 파생한다. shared collection 개요에는 shared 하위만 쓰고 private 하위의 존재/수/제목을 공개하지 않는다.

Blob은 해시·길이를 검증한 staging 파일에서 atomic rename 및 directory fsync를 마친 후 DB version/current pointer와 operation receipt를 같은 transaction에 commit한다. DB 실패 시 생긴 미참조 blob은 성공으로 기록하지 않으며 다음 동일 hash 저장에서 검증 후 재사용할 수 있다. 시작 시 참조된 모든 blob의 누락/변조를 거부한다. 무관한 사용자 파일을 자동 삭제하지 않는다. operation receipt와 최종 resource/version/projection 정합을 감사하며 unknown schema/enum, unsafe counter, orphan DB reference를 거부한다.

원본 저장 한도와 파서 한도는 분리한다. 저장은 기존64MiB storage 기술 ceiling 안에서 명시적 owner 한도를 받는다. 기존 문서 추출기의2MiB 입력 제한은 우선 그대로 유지하고 초과 문서는 원본 보존+extraction unavailable로 표시한다. 이 제한을 전체 문서 이해 성공으로 감추지 않는다. 더 큰 파일 지원을 이유로 첨부 UI의 기존 한도를 바꾸지 않는다.

## 색인·검색·모델 호출

원본 commit은 중복 없는 extract/brief/overview 작업을 enqueue한다. 텍스트와 JSON/CSV/Markdown은 bounded UTF-8 text, PDF/Office는 기존 파서, 이미지 분석은 선택된 vision service다. 원본 저장, 추출, 모델 개요, FTS 검색 준비를 별도 상태로 노출한다. unsupported/failed/cancelled/unknown은 ready가 아니다.

worker는 pending→prepared claim과 소비 attempt를 먼저 저장하고 transaction 밖에서 처리한다. 완료 전 source refs/policy/model 설정을 다시 검사한다. prepared 재시작은 unknown outcome을 남긴다. retry는 명시 요청과 기존 maxAttempts 안에서 가능하며 새 fingerprint로 같은 근거를 무제한 호출하지 않는다. 원문이 바뀐 old job은 현재 derivation으로 활성화하지 않는다. collection 하위/멤버십 변경은 visible source 집합이 바뀐 경우만 새 개요 작업을 만든다.

빠른 find는 scope 필터 후 title/FTS/literal 후보를 반환한다. search는 허용된 collection의 brief/overview→query planning→자료 후보→rerank를 호출 예산과 방문 한도 안에서 실행한다. planner/reranker는 입력으로 받은 ID만 선택하며 신규 권한·임의 URL/filepath를 만들 수 없다. 한국어3자 미만 query는 literal 후보를 사용한다. model 미설정/오류나 한도 소진은 lexical fallback과 incomplete 이유를 반환하고 의미 검색 성공을 가장하지 않는다. fake embedding은 만들지 않는다.

추출/overview stale 결과는 current처럼 표시하지 않는다. 현재 읽을 수 없게 된 source가 포함된 파생 text는 숨긴다. source edit/삭제/권한 축소 후 FTS/검색 결과도 최종 delivery 시 다시 검증한다. list/read/search는 명시적 scope/페이지 budget/cursor를 받으며 cursor는 권한 증명이 아니다. binary content는 descriptor이며 base64 전체를 모델 text로 반환하지 않는다.

## 정책 소유자와 호출 한도

기존 EnginePolicySettingsStore에 version3의 resources 항목을 추가한다. memory.enabled가 자료 읽기나 자료 색인을 끄지는 않는다. resources는 enabled(파생 모델 작업), maxVisits, maxCalls, inputTokens, outputTokens, maxAttempts를 소유한다. 기존 v1/v2를 읽을 때만 기본 항목을 보충하고 저장 bytes/revision은 유지한다. 구형 memory/context 쓰기는 현재 resources를 보존한다. source/jobs에는 이 owner의 revision과 resource policy digest, 각 호출의 route key, estimator id를 함께 고정한다. 모델 설정이 바뀌면 prepared 결과는 현재 파생물로 commit하지 않는다.

기술 기본값 후보는 maxVisits32, maxCalls3(planning+overview 선택+rank), inputTokens7000, outputTokens1024, maxAttempts3이며 새 제품 과금·주기 결정을 뜻하지 않는다. enabled 기본값은 true지만 등록된 provider가 없으면 호출하지 않는다. 명시적 owner 설정으로 변경 가능하고 호출별 모델 capability 한도가 다시 상한을 적용한다. 자동 정기 스케줄은 추가하지 않는다. job 재시도 횟수는 source fingerprint에 귀속하며 policy/route 변경만으로 횟수를 초기화하지 않는다. 새 근거 버전은 별도 작업이다. extraction은 모델 예산과 분리하지만 동일 durable claim/outcome 검사를 따른다.

## 전체 연결과 변경 지도

050의 신규 packages/lina-memory/src/resources/{types,codec,schema,content,store,extraction,indexing,retrieval,index}.ts를 사용한다. SQL mutation/index job 저장이 커지면 같은 디렉터리의 records/jobs/audit로 분리하되 새 framework는 도입하지 않는다.

| 추가 변경 | 경로 | 전체 연결 |
| --- | --- | --- |
| NEW | `packages/lina-runtime/src/resources/tools.ts` | host scope→catalog mutation/read→typed result/current guard |
| NEW | `packages/lina-runtime/src/resources/services.ts` | permitted frozen text/IDs→공통 summary/recall route→strict model outputs |
| MODIFY | `packages/lina-runtime/src/context/policy-settings.ts` | v1/v2 읽기 호환과 resources 정책 v3/공통 revision |
| MODIFY | `packages/lina-runtime/src/context/port.ts` | 전용 resource summary/planning/rank callbacks |
| MODIFY | `packages/lina-opencodex/src/services.ts` | 기존 route resolver와 실제 bounded request 적용 |
| MODIFY | `packages/lina-opencodex/src/prompts.ts` | resource 전용 요약/planner/rank 출력 계약 |
| MODIFY | `packages/lina-runtime/src/execution.ts` | 실제 read/list/search allowlist (approval-policy.ts가 아님) |
| NEW | `packages/lina-runtime/src/fleet/resource-routes.ts` | 기존 gateway에서 받을 scoped Request→Response API adapter; 실제 설치 조립070 |

각 resource/version/job/source state는 types→codec→SQL+blob→decode/audit→read/search/tools/routes까지 전달한다. 050 test 신규 경로에 실제owner 테스트를 만들고 기존 파서/source/승인 회귀를 포함한다. 일반 대화 모델은 fixed selection을 유지하고 새 resource call만 기존 shared tier resolver를 쓴다.

## 수용과 분업

file DB reopen에서 stable ID/rename/move/history, 같은op replay/conflict, 두connection CAS, parent cycle, corruptblob/JSON/counter/foreignscope를 검사한다. parser는 실제 임시 PDF/Office 파일과 이미지 unavailable로 original/derived 상태 분리를 검증한다. restartprepared/late result/권한 변경 중dispatch를 활성화해 worker outcome을 확인한다. private 이전 버전·private child·scope 변경의 목록/FTS/overview/최종delivery를 검사한다. 도구 confirm-mode read는 waiting_approval 없이 완료하며 write는 원래승인 규칙을 지킨다. API adapter의 put/read/search와 binary descriptor를 직접 호출한다.

최근 두 executor 구현은 진행이 없어 main이 회수했다. 이 단위의 긴 저장·권한 경로는 main이 구현하고, 경계가 고정된 후 독립 검토를 사용한다. 단순 탐색 위임으로 구현 위임을 가장하지 않는다. A 전에 코드 변경은 없다.

최종 C는 resource tests, 기존 parser/permission/contracts와 types/lint/docs/build로 검증한다. 실제 모델 의미 회수 품질은080의 별도 승인된 자격 검증 대상이다. 같은 OS의 privileged 코드/DB 재작성 자체를 막는 보안 격리라고 주장하지 않는다.
