# 020 — 근거 연결과 기억 재검토

상태: P 설계 초안. 감사 전이며 구현 완료가 아니다. 단위 `memory`, 선행 `routing`.

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

## 감사 전 남은 검토

새 타입의 정확한 스키마와 모든 호출자, 세부 파일 분리 및 migration 체인은 이 변경 지도와 실제 소스를 다시 대조해 확정한다. 각 상세 설계가 미완료인 동안 roadmap을 잠그거나 production B를 시작하지 않는다.

상세 identity/schema/transaction/search/API 계약은 [004_contracts](004_contracts.md)를 따른다.
