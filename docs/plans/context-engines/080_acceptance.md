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
- 공통 대화 행동: 071 소유의 지침/RPC/첫 대화 상태 검사 결과를 받아, 지정 모델의 인사·구체적 요청·이견·기억 정정·검색/실행 전환 시나리오로 검증한다. 출처 없는 과거 대화를 꾸미지 않고, 역할 전환에도 작성된 목소리와 지정 모델을 유지해야 한다. 단기 모델 검증과 사용자의 장기 체감 평가는 구분한다.
- UI 계약 목록에 `GET /api/onboarding/entry`의 firstUser/resume, `GET /api/agents/:agentId/intro`의 room/turns/userRevision/shareUser/sessionId, POST turn/finish/choose의 revision·요청 ID·오류·재시도 의미를 포함한다. 기능을 새로 설계하지 않고 현재 소스와 실제 HTTP 결과를 대조한다.

## 검증 명령과 증거

각 NEW 테스트의 직접 경로를 `bun test`에 전달하여 실패→구현→통과를 남긴다. 이 문서 작성 시 새 테스트는 없으므로 실행 결과를 주장하지 않는다. 수정된 기존 기능의 affected tests, `bun run typecheck`, `bun run lint`를 수행하고 마지막 acceptance에서 `bun run ci:validate`, `bun run ci:build`와 전체 테스트를 수행한다. 현존 스크립트는 package.json에서 확인했으며 target coverage와 실제 exit code는 실행 시 기록한다.

## 감사와 재검증

공통 상태 계약은 004_contracts.md, 해당 단위의 추가 계약은 아래 사전 감사 수정 절을 따른다. A에서 source/소비자 누락을 검사하고, 각 구현 P에서는 선행 커밋으로 바뀐 타입과 경로를 재검증한다. A 통과 전 구현은 시작하지 않는다.

## routing D 인계

공통 등급은 기존 settings PATCH API로 활성/해제한다. 현재 UI는 저장된 등급의 보존·표시와 에이전트별 모델/추론 override만 제공한다. 이것을 새 tier 편집 UI 구현으로 표시하지 않는다.

전체 acceptance는070에서 다룰 LIFE 이미지 시간 초과가 해결된 전체 테스트 결과를 요구한다. routing357개 관련 검사 통과와 full-root3294pass/45기존skip/1timeout은 별개다. native qualification 등 기존45개 skip도 실제 모델 검증으로 계산하지 않는다. 유료 모델 자격 검증은 여전히 별도 승인 범위다.
