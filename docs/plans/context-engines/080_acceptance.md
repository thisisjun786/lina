# 080 — 전체 기능 인수와 실제 모델 증거

상태: P 설계 초안. 감사 전이며 구현 완료가 아니다. 단위 `acceptance`, 선행 `integration`.

## 변경 지도

| 작업 | 경로 | 전 → 후 또는 신규 책임 |
| --- | --- | --- |
| NEW | `scripts/qa/context-engines.ts` | task-owned temp root에서 전체 기능 시나리오 실행; paid profile은 명시적 선택/승인 없으면 실행하지 않음 |
| NEW | `docs/plans/context-engines/081_contract_inventory.md` | 검증된 도구/API/설정/상태/오류 목록과 UI 기획용 계약 |
| MODIFY | `docs/VALIDATION.md` | 각 기능의 local fixture/실제 model/재시작/설치본 증거 범위 구분 |
| MODIFY | `README.md` | 완성된 자체 엔진 설명과 실제 제한, 업무와 Codex 구분 |

## 필드·상태 흐름

모의 모델은 구조/실패/복구 검증에 사용한다. 실제 모델의 추출·추론·요약·회상 성공은 허용된 profile로 별도 증거를 남긴다. 기존 live credentials를 발견했다고 호출 권한으로 보지 않는다. 미승인 실제 모델 검증은 명시적 미완료 기준이며 전체 목표 완료를 주장하지 않는다. UI 화면 제작은 다른 범위이고 UI 계약의 호출 가능성을 실제 임시 API로 확인한다.

입력은 해당 boundary에서 검증하고 저장 owner가 schema/revision/참조를 검증한다. 새 상태는 API/도구 출력과 실제 consumer까지 전달한다. 임의 JSON으로 권한을 부여하지 않는다. 구버전·알 수 없는 enum은 명시적으로 처리하고 조용한 기본값으로 데이터 의미를 바꾸지 않는다.

## 활성화와 기대 결과

- 네 tier 실제 적용.
- 기억 근거 수정→후속 추론 변화.
- 비밀 미공개 성장.
- repeated compaction/restart 후 결정 이유.
- 비코드 자료의 LLM 탐색과 A/B/Codex 인수.
- 외부 Honcho/OpenViking 없는 runtime.
- source gates 전체 통과.
- world HEAD/dirty 재대조.
- paid qualification 여부 명시.

## 검증 명령과 증거

각 NEW 테스트의 직접 경로를 `bun test`에 전달하여 실패→구현→통과를 남긴다. 이 문서 작성 시 새 테스트는 없으므로 실행 결과를 주장하지 않는다. 수정된 기존 기능의 affected tests, `bun run typecheck`, `bun run lint`를 수행하고 마지막 acceptance에서 `bun run ci:validate`, `bun run ci:build`와 전체 테스트를 수행한다. 현존 스크립트는 package.json에서 확인했으며 target coverage와 실제 exit code는 실행 시 기록한다.

## 감사와 재검증

공통 상태 계약은 004_contracts.md, 해당 단위의 추가 계약은 아래 사전 감사 수정 절을 따른다. A에서 source/소비자 누락을 검사하고, 각 구현 P에서는 선행 커밋으로 바뀐 타입과 경로를 재검증한다. A 통과 전 구현은 시작하지 않는다.
