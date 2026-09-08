# 040 — 원문 보존과 단계별 컨텍스트

상태: P 재검토. 실제 실행 계획은 [041](041_context_execution.md)을 함께 따른다. 구현 전이다. 단위 `context`, 선행 `routing + memory`.

## 변경 지도

| 작업 | 경로 | 전 → 후 또는 신규 책임 |
| --- | --- | --- |
| NEW | `packages/lina-runtime/src/context/policy.ts` | 버전 있는 청크/요약/최근 원문/복원 예산 정책과 검증 |
| MODIFY | `packages/lina-runtime/src/context/tree.ts` | INPUT_CHARS 상수 중심 분할 → 모델 추정 토큰과 명시적 input budget으로 분할; 원문 범위와 요약 연결 유지 |
| MODIFY | `packages/lina-runtime/src/context/external.ts` | thresholdChars/8192 상수 → 정책별 incremental checkpoint와 최근 원문 보존 |
| MODIFY | `packages/lina-runtime/src/context/coordinator.ts` | 요약+working injection → 현재 입력 예산 내 우선순위/현재성 검사와 omission 상태 |
| MODIFY | `packages/lina-runtime/src/context/tools.ts` | 기존 검색/expand → 정책 예산과 요약 하위 범위 탐색 |
| MODIFY | `packages/lina-core/src/context/store.ts` | 기존 summary 저장 → 정책 revision/cache fingerprint가 기존 모델/source fingerprint와 일치하는지 검증 |
| NEW | `packages/lina-runtime/test/context-policy-recovery.test.ts` | 반복 압축/변경/재시작/요약 실패와 원문 회수 |

## 필드·상태 흐름

원문은 요약으로 대체 삭제하지 않는다. leaf summary는 원문 묶음, 상위 summary는 하위 summaries를 참조한다. Codex native compaction과 Lina checkpoint를 구분한다. 원문 추출/예산 초과 시 오래된 유효 checkpoint를 유지하고 상태를 노출한다. 단순 문자/4 추정은 정확한 tokenizer로 가장하지 않는다; 모델별 tokenizer 지원 여부와 보수적 추정을 기록한다. 정책 변경은 새 summary cache key에 포함하며 기존 checkpoint의 읽기와 신규 생성 정책을 분리한다.

입력은 해당 boundary에서 검증하고 저장 owner가 schema/revision/참조를 검증한다. 새 상태는 API/도구 출력과 실제 consumer까지 전달한다. 임의 JSON으로 권한을 부여하지 않는다. 구버전·알 수 없는 enum은 명시적으로 처리하고 조용한 기본값으로 데이터 의미를 바꾸지 않는다.

## 활성화와 기대 결과

- 한글/긴 tool text와 surrogate 경계 분할.
- 작은 입력 예산에서 모든 원문 span coverage.
- A 결정→B 변경→재시작 후 최신 결정과 이전 이유 조회.
- 요약 오류에서 이전 checkpoint 유지.
- source withdrawal 뒤 기존 요약의 부적격 내용 제외.
- 설정 변경 뒤 새 한도 실제 적용..

## 검증 명령과 증거

각 NEW 테스트의 직접 경로를 `bun test`에 전달하여 실패→구현→통과를 남긴다. 이 문서 작성 시 새 테스트는 없으므로 실행 결과를 주장하지 않는다. 수정된 기존 기능의 affected tests, `bun run typecheck`, `bun run lint`를 수행하고 마지막 acceptance에서 `bun run ci:validate`, `bun run ci:build`와 전체 테스트를 수행한다. 현존 스크립트는 package.json에서 확인했으며 target coverage와 실제 exit code는 실행 시 기록한다.

## 감사와 재검증

공통 상태 계약은 004_contracts.md, 해당 단위의 추가 계약은 아래 사전 감사 수정 절을 따른다. A에서 source/소비자 누락을 검사하고, 각 구현 P에서는 선행 커밋으로 바뀐 타입과 경로를 재검증한다. A 통과 전 구현은 시작하지 않는다.

## 사전 감사 수정: 요약 예산 소비

추가 MODIFY context/summarize.ts의 기존 [2048,512] 재시도 한도를 정책 값으로 받는다. 각 시도 한도는 010 services의 요청 maxTokens에 전달되며 profile/catalog cap과 최소값을 사용한다. 추가 MODIFY context/native.ts는 기존 prepare 이벤트의 원문 경계와 최근 보존량에 정책을 적용한다. 실패 시 원문 coverage를 축소해 성공으로 만들지 않는다. context/policy.ts는 `{version:1, leafInputTokens, leafOutputTokens, condensedOutputTokens, freshTailEntries, expansionTokens, refreshThresholdTokens, maxSearchCalls}`의 safe integer 범위를 검증한다. 정책 저장은 integration의 settings owner가 담당하며 040은 명시적 injected policy와 기본값을 제공한다.
