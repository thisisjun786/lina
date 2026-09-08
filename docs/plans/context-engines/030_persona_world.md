# 030 — 개인 성장과 월드 순환

상태: P 설계 초안. 감사 전이며 구현 완료가 아니다. 단위 `persona`, 선행 `memory`.

## 변경 지도

| 작업 | 경로 | 전 → 후 또는 신규 책임 |
| --- | --- | --- |
| MODIFY | `packages/lina-core/src/agents/persona.ts` | 작성 정체성+동적 배열 합성 → 근거 있는 현재 성향과 상대별 태도의 일관된 투영 |
| MODIFY | `packages/lina-core/src/agents/agent-learning.ts` | 개별 변화 수용 → source revision과 경험 id 중복 방지, locked identity 유지 |
| MODIFY | `packages/lina-runtime/src/persona/hooks.ts` | 일반 대화 persona 읽기 → shared current projection과 허용 근거를 매 턴 재검증 |
| MODIFY | `packages/lina-runtime/src/persona/reflection.ts` | 회고 결과 → 직접 사용자 선호/자기 성장/상대 관계의 권한과 반복 근거 분리 |
| MODIFY | `packages/lina-runtime/src/life/actor.ts` | 기존 actor 입력 → 동일한 현재 persona를 사건 해석/선택에 반영 |
| MODIFY | `packages/lina-runtime/src/life/work-bridge.ts` | Codex task receipt만을 통한 연결 → 기존 task 어댑터 보존; 공통 활동 근거 연결은 shared-memory 이후 integration에서 구현 |
| NEW | `packages/lina-runtime/test/persona-world-cycle.test.ts` | 사건 해석→성장→다음 actor/일반 대화 입력에 같은 변화 전달 |

## 필드·상태 흐름

핵심 이름·역할·명시적 lock은 학습이나 LIFE가 변경하지 않는다. LIFE 성장 원본은 기존 world owner에 유지하고 개인 대화 성장은 memory/agent owner에 유지한다. 공통 읽기 projection이 우선순위와 출처를 명시하며 독립적으로 수정 가능한 복제 상태를 만들지 않는다. 관계는 방향과 상대를 가진다. 사건/비밀 원문은 일반 대화의 성향 projection에 들어가지 않는다. 월드 담당이 수정 중인 store/visual 파일은 커밋 기준으로 대조 후 순차 통합한다.

입력은 해당 boundary에서 검증하고 저장 owner가 schema/revision/참조를 검증한다. 새 상태는 API/도구 출력과 실제 consumer까지 전달한다. 임의 JSON으로 권한을 부여하지 않는다. 구버전·알 수 없는 enum은 명시적으로 처리하고 조용한 기본값으로 데이터 의미를 바꾸지 않는다.

## 활성화와 기대 결과

- 같은 사건에 두 인격의 서로 다른 해석.
- 관계 A→B만 변화.
- retry 경험은 한 번 적용.
- explicit lock과 manual evolution은 유지.
- 일반 요청 직렬화에서 비밀/사건 문장 부재.
- 재시작 뒤 actor와 대화 projection 일치..

## 검증 명령과 증거

각 NEW 테스트의 직접 경로를 `bun test`에 전달하여 실패→구현→통과를 남긴다. 이 문서 작성 시 새 테스트는 없으므로 실행 결과를 주장하지 않는다. 수정된 기존 기능의 affected tests, `bun run typecheck`, `bun run lint`를 수행하고 마지막 acceptance에서 `bun run ci:validate`, `bun run ci:build`와 전체 테스트를 수행한다. 현존 스크립트는 package.json에서 확인했으며 target coverage와 실제 exit code는 실행 시 기록한다.

## 감사 전 남은 검토

새 타입의 정확한 스키마와 모든 호출자, 세부 파일 분리 및 migration 체인은 이 변경 지도와 실제 소스를 다시 대조해 확정한다. 각 상세 설계가 미완료인 동안 roadmap을 잠그거나 production B를 시작하지 않는다.
