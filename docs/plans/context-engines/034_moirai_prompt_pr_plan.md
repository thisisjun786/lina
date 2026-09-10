# Moirai 공통 지침·역할 지침 비교 PR

2026-09-11 · 문서 회차 검토 완료, 구현 회차 대기 · 문서 C2 / QA 구현 C3

같은 모델을 세 번 호출했을 때 상세 역할 지침이 어떤 판단을 만드는지 관찰할 QA 실행 경로를 만든다. 먼저 [연구](032_moirai_prompt_research.md)와 [지침 후보](033_moirai_prompt_candidates.md)를 Draft PR로 올리고, 같은 PR에 비교 실행과 기록을 추가한다. 첫 PR은 실험을 실행하고 실패까지 남기는 데서 끝난다. 지침의 성능 우월성은 별도 실모델 평가가 필요하다.

Understood as: 동일 모델 안의 판단 방법 분화와 향후 모델별 지침 최적화를 위해, C/E 비교를 실행할 수 있는 작은 첫 PR을 만들고 같은 Draft PR에서 보강한다.

## 실행 계약

| 항목 | 이번 작업 |
| --- | --- |
| 형태·계기 | satisfy-spec. 연구 초안을 먼저 Draft PR로 올리고 같은 PR에서 보강하라는 요청 |
| 목표 | C 공통 지침과 E 상세 역할 지침의 3판단·1종합을 동일 조건에서 실행하고 원문과 실패를 보존 |
| 제외 | 제품 대화 연결, R1 진행 중 복구, 실제 조회, 도메인 쓰기, 다중 모델 탐색, 자동 최적화, qualification, merge·배포 |
| 검증 | 문서 링크·공백 검사; 기존 및 새 Moirai 계약 테스트; 타입·lint; 실제 격리 native와 로컬 합성 provider 실행; 해당 PR 현재 후보의 dev-gate |
| 종료 | 검토한 비교 실행·검증 결과를 같은 열린 Draft PR에 반영. 성능 개선 판정은 하지 않음 |
| 기록 | 이 계획, [구현 설계](040_moirai_prompt_comparison.md), 기존 연구·후보 문서. 원본 실행 자료는 checkout 밖의 새 경로 |
| 결과 | DONE=위 기준 충족. NOOP=이미 충족한 개별 항목을 재확인. BLOCKED/NEEDS_HUMAN=구체적 외부 의존성. UNSAFE=허용 범위 초과. 자원 소진은 성공이 아님 |
| 방향 변경 | 인터페이스·실행 흐름 변경은 계획을 먼저 갱신. 두 독립 구현 담당자가 실패하면 main이 남은 범위를 회수. 추가 위임은 P에서 범위 기록 |
| 자원 | 저장소·로컬 도구와 이 Draft PR의 commit/push만 사용. 유료 실모델 실험 없음. 사용자 지정 토큰·시간 예산 없음. 각 native 요청은 기존 120초 제한, 조건별 생성은 최대 4회 |

## 의존 순서

1. 문서 회차: 연구와 지침 후보를 읽고 전체 변경 파일·검증 조건을 확정한다. 독립 검토와 문서 검사를 마친 뒤 Draft PR을 만든다.
2. 구현 회차: 문서 회차의 확정 설계를 다시 현재 소스와 대조한다. 프롬프트·응답 계약, 기존 probe 연결, 비교 실행 순서로 구현하고 같은 PR을 갱신한다.

각 회차는 PABCD를 별도로 완료한다. 두 회차는 하나의 기능을 설명하고 구현하므로 PR을 나누지 않는다. 문서는 저장소의 기존 번호·위치를 재사용하며 새 최상위 devlog 체계를 만들지 않는다.

## 현재 소유자와 변경 경계

```text
docs/plans/context-engines/030..040  연구·설계·검증 설명
packages/lina-codex/src/moirai-probe.ts  기존 네 스레드 조정기
packages/lina-codex/src/moirai-probe-{gateway,state,transport}.ts  R0 전송·기록 검증
packages/lina-codex/test/moirai-*  합성 계약 검증
scripts/qa/moirai-native.ts  격리 실행·종료·native readback
scripts/qa/moirai-native-lifecycle.ts  실행 신원·안전한 증거 경로
```

`moirai-probe.ts:27`의 지침과 `:362`의 gateway 기대값은 현재 고정돼 있다. `:175`의 독립 판단이 끝나면 `:184`에서 곧바로 종합한다. 현재 형식은 자연어이므로 JSON 유효성 검증 지점이 필요하다. `moirai-probe-state.ts:124`는 `resumable: true`인 완료 기록만 복구하므로 새 실험을 재개 불가로 기록할 수 있다. `scripts/qa/moirai-native.ts:190`의 기본 실험은 세 회차를 재개하며 실행한다.

아무 코드도 바꾸지 않거나 설정만 바꾸면 지침 고정과 JSON 검증 부재를 해결하지 못한다. 새 RPC·gateway를 만들면 이미 검증한 경계를 복제하게 된다. 기존 probe에 실험용 계약을 선택적으로 연결하고 기본 R0 경로는 유지한다. 제품 package export나 runtime 소유권은 변경하지 않는다.

## 검증 출발점

문서 검사 명령은 세 문서 경로를 직접 받아 45개 링크와 코드 블록·공백을 검사했고 오류 0개였다. 이는 의미나 성능의 자동 검증이 아니다. `git diff --check`는 종료 코드 0이었다.

`bun test packages/lina-codex/test/moirai-probe.test.ts packages/lina-codex/test/moirai-probe-state.test.ts packages/lina-codex/test/moirai-probe-gateway.test.ts packages/lina-codex/test/moirai-probe-reconciliation.test.ts packages/lina-codex/test/moirai-probe-runner.test.ts`: 107 pass, 0 fail. 경로를 직접 지정해 기존 조정기·전송·복구·격리 보조 함수를 관찰한다. 새 비교 기능의 증거는 아직 아니다.

루트 타입 검사는 `packages/*/test`를 포함한다. 새 QA 파일은 테스트에서 실제 import해 타입 검사 경로에 포함한다. lint는 루트 `biome check .`를 사용한다. 구현 전 새 계약 테스트의 RED와 구현 후 같은 테스트의 GREEN을 남긴다.

독립 검토는 문서의 모델 효과 주장을 새 성능 증거로 승격하지 않는다. [기존 연구 검토의 지적과 수정](032_moirai_prompt_research.md)은 초안의 검토 기록이며 이번 계획의 독립 승인과 구분한다.

## 회차 기록

설계 담당의 D1(고정 지침 주입), D2(중립 입력), D4(한 회차·재개 금지), D6(합성 JSON 응답)는 채택했다. D3는 같은 검증 원칙을 유지하며 기존 runRole 안에서 raw result 저장 뒤 검증하고 기존 failure-role 기록에 오류를 남기는 방식으로 수정했다. D5는 별도 프로세스·native home으로 조건을 분리하고 실행 manifest의 모델·wire 옵션·실행 파일·소스 신원을 비교하는 방식으로 수정했다. 이미 있는 gateway 기록에서 시도 수와 latency를 읽는다. schema/prompt 파일은 QA 전용 probe 옆에 두고 public index로 내보내지 않는다.

설계 반영 확인은 ALIGNED였다. 추가 제안인 실제 전송의 중립 ID 검사, outbound 설정 대조, 실패 주입 위치, proposalId 발급 규칙도 명세에 반영했다. 독립 검토를 마친 뒤 문서 회차를 닫는다. 구현 회차 결과는 검증한 소스와 명령을 연결해 이 절에 기록한다.

독립 A 검토의 첫 결과는 FAIL이었다. 공통 입력 문서의 role 이름, 응답 스키마의 필수 필드·중첩 구조·한도, 결과 파일 없이 종료한 자식의 통합 테스트가 불명확했다. 세 지적을 수용해 033의 중립 슬롯·규범 스키마와 040의 실제 자식 fixture 실행 명세에 반영했다. Draft 발행은 가능하다는 검토 의견이 있었으나, 구현 시작과 문서 회차 종료는 보완 검토가 끝난 뒤 진행한다.

보완 검토는 `8997de3..481cba4`에서 세 수정과 문서 검사를 재확인해 PASS를 반환했다. 설계 담당도 변경한 결정 D2/D3/D5를 ALIGNED로 확인했다. [Draft PR #10](https://github.com/thisisjun786/lina/pull/10)은 `dev` 대상이며 `481cba4`에서 docs-only CI의 changes와 dev-gate가 통과했다. source lint/types/tests/build는 문서 전용 선택에 따라 생략됐고 실행 성공으로 세지 않는다. 같은 커밋의 전체 Git 이력 비밀정보 검사는 285개 커밋에서 발견 0개였다.

문서 회차의 결론: 040의 작은 C/E 설계를 구현한다. 다음 P는 이 결론과 현재 코드를 대조하고 동일 설계의 실행 계약부터 시작한다. 제품 통합·실모델 품질 평가는 계속 후속 범위다.
