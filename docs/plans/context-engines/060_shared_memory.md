# 060 — 자료 기반 공통 기억과 소비

상태: P 설계 초안. 감사 전이며 구현 완료가 아니다. 단위 `shared-memory`, 선행 `resources + memory`.

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

## 감사 전 남은 검토

새 타입의 정확한 스키마와 모든 호출자, 세부 파일 분리 및 migration 체인은 이 변경 지도와 실제 소스를 다시 대조해 확정한다. 각 상세 설계가 미완료인 동안 roadmap을 잠그거나 production B를 시작하지 않는다.

상세 identity/schema/transaction/search/API 계약은 [004_contracts](004_contracts.md)를 따른다.
