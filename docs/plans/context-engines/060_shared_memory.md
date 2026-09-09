# 060 — 자료 기반 공통 기억과 소비

상태: 061 독립 A 통과 후 구현, C 통과. 설치 연결은 070이 맡는다. 단위 `shared-memory`, 선행 `resources + memory`.

## 변경 지도

| 작업 | 경로 | 전 → 후 또는 신규 책임 |
| --- | --- | --- |
| NEW | `packages/lina-memory/src/resources/memories.ts` | 비코드 자료에서 관찰/결정 이유/재사용 경험을 생성하고 자료 revision에 연결 |
| NEW | `packages/lina-runtime/src/resources/context.ts` | 현재 요청 목적·범위에 맞는 shared memory와 원문 조립 |
| MODIFY | `packages/lina-runtime/src/fleet/codex-fleet.ts` | 외부 workTools 등록 → 자체 자료 도구를 Lina 및 Codex 동적 도구에 등록 |
| MODIFY | `packages/lina-runtime/src/context/port.ts` | 개인 context 서비스와 구분된 shared resource context 접점 |
| NEW | `packages/lina-runtime/test/shared-resource-consumers.test.ts` | Lina agent A/B와 Codex 동적 도구의 동일 자료 탐색·갱신 |
| NEW | `packages/lina-memory/test/resource-memory-provenance.test.ts` | 원본 revision 변경에 따른 기억·파생 요약 무효화 |

## 필드·상태 흐름

자료 기억은 어떤 에이전트가 직접 경험했다는 주장과 분리한다. 개발/비개발/간단 검색이 모두 업무이며 기록은 task id를 요구하지 않는다. 수행 결과는 실제 원본 기록의 참조로 연결하며 이 엔진은 작업 할당/완료 판정 owner가 아니다. 매 짧은 검색을 강제로 영구 기억화하지 않는다. 미완료 맥락은 자료로 저장 가능하지만 작업 실행 상태와 동등하다고 표시하지 않는다.

입력은 해당 boundary에서 검증하고 저장 owner가 schema/revision/참조를 검증한다. 새 상태는 API/도구 출력과 실제 consumer까지 전달한다. 임의 JSON으로 권한을 부여하지 않는다. 구버전·알 수 없는 enum은 명시적으로 처리하고 조용한 기본값으로 데이터 의미를 바꾸지 않는다.

## 활성화와 기대 결과

- A가 리서치 자료/결정 이유 저장→B가 재설명 없이 이어가기.
- Codex가 동일한 resource id 읽기.
- 개인 비밀을 공유 메모리로 보낼 때 scope 차단.
- search만 수행한 요청이 Codex 작업을 생성하지 않음.
- 자료 수정 뒤 오래된 기억 재색인.
- 공유 지식을 개인 직접경험으로 반환하지 않음..

## 검증 명령과 증거

각 NEW 테스트의 직접 경로를 `bun test`에 전달하여 실패→구현→통과를 남긴다. 이 문서 작성 시 새 테스트는 없으므로 실행 결과를 주장하지 않는다. 수정된 기존 기능의 affected tests, `bun run typecheck`, `bun run lint`를 수행하고 마지막 acceptance에서 `bun run ci:validate`, `bun run ci:build`와 전체 테스트를 수행한다. 현존 스크립트는 package.json에서 확인했으며 target coverage와 실제 exit code는 실행 시 기록한다.

## 감사와 재검증

공통 상태 계약은 004_contracts.md, 해당 단위의 추가 계약은 아래 사전 감사 수정 절을 따른다. A에서 source/소비자 누락을 검사하고, 각 구현 P에서는 선행 커밋으로 바뀐 타입과 경로를 재검증한다. A 통과 전 구현은 시작하지 않는다.

상세 identity/schema/transaction/search/API 계약은 [004_contracts](004_contracts.md)를 따른다.

## 사전 감사 수정: 생성 주체와 범위

공유 기억은 개인 agent DB가 아닌 resource catalog의 resource_memories에 저장한다. source는 resource id/version, 정책 revision, 제안자와 입력 근거다. ResourceScope는 host-supplied `{principalId, agentId:null|string, allowedVisibilities:('private'|'shared')[]}`이며 private는 owner_id 일치까지 요구한다. owner_id는 설치 내 생성 주체 id이고 scope 자체를 모델 출력으로 생성하지 않는다.

MODIFY resources/indexing.ts: version commit에서 extraction/summary job을 만들고, 명시적 deriveMemory 또는 저장된 collection capture 정책이 허용한 경우에만 memory job을 enqueue한다. memory worker가 resources/memories.ts를 standard 기본 tier로 호출한다. 일반 단순 검색은 job 생성 trigger가 아니다. MODIFY runtime/resources/tools.ts put 입력에는 deriveMemory 선택값을 제공하되 scope를 승격하지 못하게 한다. MODIFY fleet/codex-fleet.ts는 Lina 도구에 실제 botId scope를 공급하고, Codex 도구는 확인된 task owner가 있으면 그 agentId, 없으면 null/shared-only를 공급한다. Codex task id는 공유 자료 사용의 필수값이 아니다.

## 정식 감사 반영 변경 지도

공유 기억 저장 위치는 004의 resource_memories다. 위의 resource_derivations(kind=memory) 초안은 이 계약으로 대체한다.

| 작업 | 경로 | 전 → 후 |
| --- | --- | --- |
| MODIFY | `packages/lina-codex/src/task-rpc.ts` | executeTool의 host-only 다섯 번째 인자에 taskId/agentId를 전달; 모델 args에서 받지 않음 |
| MODIFY | `packages/lina-codex/src/tasks.ts` | 실제 store에서 현재 task owner 확인 후 tool context 공급; 인계/미확인 시 private 권한 자동 승계 금지 |
| MODIFY | `packages/lina-runtime/src/fleet/codex-fleet.ts` | host context로 principal scope 생성; 확인 불가 시 agentId=null/shared-only |

검증: task owner 인계 직전/직후 오래된 tool context는 private 자료를 반환하지 않는다. Codex task 없이 쓰는 LINA consumer는 자신의 host scope를 그대로 쓴다.

## 061 실행 계획 우선

현재 구현 계약은 [061](061_shared_memory_execution.md)과 004의 schema2 capture DDL을 따른다. 위 fleet/codex-fleet.ts 설치 교체는 070에서 수행한다. 060은 자체 task-consumer와 실제 TaskManager fake RPC/LinaHost 경로를 검증한다. capture는 기존 resource index enum/attempt 테이블과 분리한다.
