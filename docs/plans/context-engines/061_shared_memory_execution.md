# 061 — 자료 기반 기억과 공통 소비 실행 계약

상태: P, 독립 감사 전. 선행 resources는 fd4d1e7에서 종료했다. 515개 관련 테스트와 독립 검토가 통과했다. 다음 방향은 원문 권한과 revision을 유지하는 공통 기억이다. 전체 설치 연결은 070이 맡는다.

유형 satisfy-spec, 계기 060 실행. 목표는 에이전트 A/B와 Codex가 같은 자료와 자료 기반 기억을 이어 쓰되 개인 직접경험으로 오인하지 않는 것이다. 사용자 대화 모델 선택, UI, 설치 데이터 변경, 외부 호출, 푸시·머지는 범위 밖이다. 성공 조건은 아래 시나리오와 관련 타입·린트 검증 통과 및 독립 검토다. 기록은 이 문서와 세션 evidence/shared-memory-*에 남긴다. 로컬 완료 뒤 070으로 진행하며 라이브 검증은 별도 허가가 필요하다. 사용자가 지정하지 않은 시간·토큰 예산은 만들지 않는다. 두 실행자가 같은 위임 작업에 실패하면 주 에이전트가 회수한다. 새 위임은 P 수정으로 범위를 먼저 고정한다.

## 확인한 소스와 구현 순서

현재 ResourceStore는 schema1 catalog, ResourceIndex는 extract/brief/overview를 소유한다. ContextServices는 summary/recall 용 자료 호출과 실제 요청 한도를 지원한다. TaskManager.handleToolCall은 모델 인자 검증 뒤 executeTool에 네 인자만 전달한다. 저장된 task에는 ownerAgentId와 revision이 있다. 이 차이를 아래 순서로 메운다.

| 작업 | 경로 | 책임 |
| --- | --- | --- |
| MODIFY | `packages/lina-memory/src/resources/schema.ts` | schema1 검증 후 transaction 안에서 schema2 기억·작업 테이블 추가; 실패 시 원본 유지 |
| MODIFY | `packages/lina-memory/src/resources/codec.ts` | host scope agentId를 nullable로 확장; principal과 visibility 검증 유지 |
| NEW | `packages/lina-memory/src/resources/memories.ts` | 자료 기억, 명시적 capture 요청, attempt/claim/receipt, 근거 검증과 재시작 감사 |
| MODIFY | `packages/lina-memory/src/resources/store.ts` | memories 소유·감사·복구; 자료 변경과 활성 기억 무효화 연결 |
| MODIFY | `packages/lina-memory/src/resources/index.ts` | 자체 기억 타입과 저장 API export |
| NEW | `packages/lina-runtime/src/resources/context.ts` | 읽기 전용 자료 기억 선택과 한도 내 source-qualified context; 최종 전달 guard |
| NEW | `packages/lina-runtime/src/resources/memory-worker.ts` | 허용된 capture만 생성; 실제 요청 직전 claim, 구조·근거 검증 후 원자적 저장 |
| MODIFY | `packages/lina-runtime/src/resources/tools.ts` | put의 deriveMemory, 기억 읽기 접점; 모델이 scope를 만들지 못함 |
| MODIFY | `packages/lina-runtime/src/resources/services.ts` | capture worker 수명·취소·복구와 설치 가능한 consumer 조립 |
| MODIFY | `packages/lina-runtime/src/context/port.ts` | 자료 기억용 선택적 callback과 실제 input overhead 계약 |
| MODIFY | `packages/lina-opencodex/src/services.ts` | observation 역할, standard tier 기본 요청의 실제 provider body; 출력·입력 한도와 dispatch guard |
| MODIFY | `packages/lina-codex/src/task-rpc.ts` | host-only executeTool 다섯째 인자 taskId/agentId/owner revision/assertCurrent |
| MODIFY | `packages/lina-codex/src/tasks.ts` | 저장소에서 owner snapshot 생성, 호출 후 respond 직전 재검증 |
| NEW | `packages/lina-runtime/src/resources/task-consumer.ts` | 검증된 host task context를 scope로 바꾸는 공통 도구 adapter; task 없는 consumer도 허용 |
| NEW | `packages/lina-memory/test/resource-memory-provenance.test.ts` | 실제 임시 DB 재개방·변조·권한·중복·migration |
| NEW | `packages/lina-runtime/test/shared-resource-consumers.test.ts` | 일반 Lina A/B와 fake Codex RPC 도구 실행, task 없는 읽기와 인계 경쟁 |
| NEW | `packages/lina-runtime/test/resource-memory-worker.test.ts` | 실제 adapter fake fetch, 한도·취소·실패·복구 |
| NEW | `packages/lina-codex/test/task-tool-owner.test.ts` | owner 변경 전후 실행·응답 차단 |

주 에이전트가 저장/worker/context/통합을 맡고, A 통과 후 executor가 task-rpc.ts/tasks.ts와 task-tool-owner.test.ts만 맡는다. 실행자가 자료 파일을 수정하지 않는다. 독립 reviewer는 계획 및 최종 변경을 읽기 전용으로 검토한다.

## 저장·생성·무효화

기억은 resource_memories에 저장하고 resource_derivations에는 넣지 않는다. 004 필드에 source revision/hash, model generation, input/output hash, activityKind, claim receipt를 명시한다. 기억 종류는 observation/decision/experience, 업무 종류는 development/research/writing/organization/search/other다. taskId는 선택적 provenance일 뿐 생성 조건이 아니다. experience도 자료에서 추론한 재사용 지식이며 개인 경험이 아니다.

각 기억은 원문 version과 인용 구간/텍스트를 가진다. 모델이 제시한 근거는 실제 읽힌 원문과 대조한다. 새 모델 enum은 만들지 않고 기존 observation 역할에 standard tier를 요청한다. 사용자가 지정한 route와 실제 effective generation을 receipt에 남긴다. 출력은 구조 검증 후 저장하고 실제 호출 한도를 사용한다. 미지원 서비스, 범위 초과, 근거 오류는 기억 없음과 구체적 상태로 끝난다.

capture는 deriveMemory=true인 저장 또는 명시적 capture 요청만 시작한다. collection capture 정책은 현재 설정이 없으므로 자동 활성화하지 않는다. source 변경은 기존 기억을 즉시 조회에서 제외하고 이미 capture 의도가 기록된 해당 자료만 새 버전으로 재생성한다. 단순 검색은 capture/task 생성 경로를 호출하지 않는다. 저장 성공 후 capture 실패를 자료 저장 실패로 위장하지 않는다. 재시도는 원문 digest별 누적 횟수에 묶고 정책 변경으로 초기화하지 않는다.

capture 작업은 resource memory 전용 테이블을 쓴다. 기존 IndexKind 세 값과 모든 비교/worker/order/FTS 소비자를 바꾸지 않는다. 저장 mutation에서 capture intent와 원문 reference를 같은 transaction에 넣는다. pending→prepared→ready/failed/unknown/stale/exhausted를 엄격히 검사한다. prepared 재시작은 host의 명시적 독점 복구에서 unknown으로 바꾸며 자동 재호출하지 않는다. 완료는 기억 목록과 receipt를 같은 transaction에 저장하고 동일 claim 재전달은 중복 생성하지 않는다. schema1 마이그레이션은 기존 전체 감사 성공 후 수행한다. 손상되거나 알 수 없는 형식은 거부한다.

## 권한과 소비

agentId=null은 외부 소비자 표기다. host가 shared-only scope를 공급하며 null만으로 private 읽기 권한을 만들지 않는다. 기존 principal 소유권 검사와 현재 resource + 역사 version 이중 검사를 유지한다. 기억의 visibility는 모든 근거보다 넓어질 수 없다. 원문 변경, tombstone, 공개 범위 회수, 정책/route 변경 뒤 생성 결과는 현재 기억으로 반영하지 않는다.

context는 목적에 맞는 허용 기억과 URI/revision/인용을 한도 내 제공한다. 반환 문구는 공유 자료에서 얻은 지식임을 표시하고 instructions로 취급하지 않는다. 선택·읽기만으로 저장이나 Codex task를 만들지 않는다. await 뒤와 실제 전달 직전 scope/refs를 재검사한다.

TaskToolContext는 host 메모리의 callback이며 모델 JSON으로 serialize하지 않는다. taskId/agentId/revision은 store snapshot에서 만들고 assertCurrent는 현재 owner를 조회한다. 인계나 owner 변경 후엔 이전 호출을 실패로 응답한다. 불확실한 owner는 shared-only로 제한한다. 동일 도구 consumer는 task context 없이 Lina host scope로 실행 가능하다. fleet/codex-fleet.ts의 설치 교체는 070으로 유지하고 060에서는 실제 TaskManager fake RPC와 LinaHost 실행 경로로 증명한다.

## 필드의 전체 경로

memory/capture 필드는 strict 입력 schema → transaction JSON/명시 열 → 재개방 strict parser와 provenance audit → worker/context/tool 결과 순서다. unknown enum, unsafe revision, 중복 근거, 허위 인용은 거부한다. activityKind는 저장 요청에서 생성하고 receipt/기억을 거쳐 context에 전달한다. agentId=null은 scopeSchema에서 생성·검사하고 task-consumer와 기존 자료 API가 소비한다. scope는 DB에 권한 증서로 저장하지 않는다. task callback은 host-only이므로 직렬화/역직렬화 N/A다.

## 검증 시나리오와 기록

새 테스트는 B에서 실패를 먼저 확인한다. 계획 시점엔 파일이 없으므로 통과를 주장하지 않는다. 아래 경로를 bun test 직접 인자로 실행한다. 기존 resource 관련 suite와 Codex task suite는 변경 경로를 직접 읽는다. 타입·린트는 루트 package scripts의 전체 소스 범위를 사용한다. 자료 단계에서 같은 명령의 exit0가 확인되었지만 060 구현 증거로 재사용하지 않는다.

- A가 원문과 capture 저장 → B가 URI/근거와 함께 기억 읽기 → task 없는 일반 consumer에 새 task 없음.
- 같은 operation/claim 두 번 완료 및 DB 재개방 → 기억 id와 개수 동일.
- 원문 수정·삭제·private 전환을 provider await 중 실행 → 새 기억 활성화/전달 없음.
- private 원문을 shared 기억으로 제안, 허위 인용/임의 source ID → 거부, 공유 조회에 흔적 없음.
- schema1 실제 DB 재개방 → schema2로 내용 보존; malformed schema/근거/hash/카운터 → rollback 또는 시작 거부.
- prepared 상태에서 close/reopen/recover → unknown, provider 호출 0; 허용 재시도 한도 초과 → exhausted.
- fake OpenCodex fetch에서 standard route·입출력 한도 관찰; disabled/unsupported → 호출 0.
- TaskManager 도구 await 중 인계 → 응답에서 비공개 결과 없음; 미확인 owner shared-only, 모델 args의 owner 위조 거부.

문서 검증은 evidence/check-plan.py를 실제 실행하며 번호/경로/의존성만 검사한다. 의미 완전성은 독립 검토가 맡는다. C에서 000/004/060/061을 최종 계약에 맞춘다. 최종 layer는 host code와 저장 감사이며 임의 DB/host 코드 수정은 우회 가능하다. 악성 로컬 관리자를 막는 보안 경계라고 주장하지 않는다.
