# R0: 네 지속 Codex 스레드 실행 증거

2026-09-10. QA 전용 구현과 실제 GLM 호출을 확인했다. **하나의 합성 채널에서 세 판단을 병렬 실행하고 모이라이가 종합한 뒤, native 프로세스를 다시 열어 같은 네 스레드를 이어 갔다.** 제품 인지 회차나 사용자 채널에 연결하지 않았다. 독립 코드 리뷰는 진행 중이다.

## 구현과 실행

- [조정기](../../../packages/lina-codex/src/moirai-probe.ts)는 역할별 thread/turn ID와 원본 입력을 기록하고, 세 역할의 native 완료와 전송 기록이 모두 성공해야 종합을 시작한다. 다른 thread와 이전 turn의 완료 알림은 현재 결과로 쓰지 않는다.
- [실험 게이트웨이](../../../packages/lina-codex/src/moirai-probe-gateway.ts)는 등록된 입력·모델·역할 지시를 확인하고 실제 송신, 응답, 사용량, 실패를 기록한다. 모델 도구는 노출하지 않는다. native 어댑터와 격리 정책은 기존 구현을 재사용한다.
- [실행 스크립트](../../../scripts/qa/moirai-native.ts)는 별도 임시 home/workspace와 원장을 사용한다. 제품의 메모리·페르소나·World/LIFE 실행기를 설치하지 않는다.

저장소 루트에서 실행한다. `--root`는 아직 존재하지 않는 Git 밖의 절대 경로여야 한다.

```sh
# 설치된 Codex와 합성 provider: 유료 모델 호출 없음
bun scripts/qa/moirai-native.ts --root=/tmp/moirai-fixture-new

# 설정된 OpenCodex 경유 Ollama Cloud GLM 실제 호출
bun scripts/qa/moirai-native.ts --live --root=/tmp/moirai-live-new
```

현재 실증 조합은 Linux, Codex CLI `0.153.4`, Bun `1.4.0`, OpenCodex `/v1/responses`, `ollama-cloud/glm-5.3-flash`다. OpenCodex 서버 버전은 이번 증거에서 확정하지 않았다. 각 회차는 별도 에피소드이며 호출 6회, 요청 출력 4,096토큰·120초 조건을 유지했다. 정상 경로는 회차마다 4회다. 실제 청구 금액은 측정하지 않았다.

## 고정 후보 실증

`live-6`은 세 소스 파일의 SHA-256을 `candidate-6/manifest.json`에 보존한 후보로 실행했다. 역할별 네 thread ID는 세 회차 내내 같았고 native 프로세스는 회차마다 새로 시작했다.

| 회차 | 직전 경계 | 세 판단의 동시 실행 구간 | thread별 누적 turn | 보고된 총 토큰 |
| --- | --- | --- | --- | --- |
| 1 | 새로 생성 | 8,387ms | 1 | 3,765 |
| 2 | 정상 종료 후 재개 | 4,091ms | 2 | 6,870 |
| 3 | 2회차 완료 뒤 소유 native 프로세스 그룹 SIGKILL | 2,918ms | 3 | 9,304 |

총 12개 게이트웨이 송신과 19,939토큰을 기록했다. 각 회차에서 세 판단이 끝난 뒤 종합 송신이 시작됐다. 첫 입력에만 있던 합성 표식 `teal`을 다음 두 회차의 새 입력에는 넣지 않았고, 실제 송신 이력과 각 판단 출력에서 확인했다. 모든 출력은 요청 한도 안에서 완료됐고 종료 후 세 native PID가 없음을 확인했다. OpenCodex 내부의 별도 물리 재시도 여부는 이번 원장에서 측정하지 않았다.

이 검사는 **완료 회차 뒤 native 프로세스 재개**다. 조정기 부모 프로세스의 강제 종료, 진행 중인 native 실행의 reconciliation, 효과 중복 방지, 일반 대화의 이해 적용을 입증하지 않는다. 미완료 원장이 있으면 자동 재실행을 거부한다.

독립 리뷰에서 `complete.json`의 존재만으로 재개하던 결함을 발견했다. [원장 검증](../../../packages/lina-codex/src/moirai-probe-state.ts)을 추가해 완료 내용·네 역할·thread/turn ID·개별 결과·원본 입력을 확인하고, 네 native 이력이 모두 일치해야 첫 resume을 보낸다. 빈/잘린/불일치 완료 기록, 실패 상태, 바뀐 출력, 추가 native turn의 회귀 검사는 수정 전 실패·수정 후 통과했다. 이 수정은 `candidate-6` 이후다. 새 합성 native 실행 3회차와 보존된 `live-6` 원장/이력으로 검증했고, 원래 live 후보와 구분한다.

이전 실험도 보존했다. `live-1`~`live-3`은 송신 전 실패, `live-4`는 첫 회차 4개 호출·2,686토큰 뒤 다음 회차 실패, `live-5`는 이전 후보의 12개 호출·16,230토큰 성공이다. 후보를 수정한 개발 실험이므로 연속 qualification으로 세지 않는다. 초기 실패 기록에는 세부 native/capture 오류가 없으며 현재 후보에서 각각을 남기도록 보완했다.

## 로컬 검증과 남은 일

- 관련 조정기·게이트웨이·checkpoint·도구 테스트: 37 pass.
- Codex 패키지와 checkpoint/prompt 테스트: 247 pass, 41 skip. opt-in native 검사는 기본 suite에서 생략되며 위 별도 native 실증과 범위가 다르다.
- 자체 기억·자료 엔진/저장/도구/API 테스트: 38 pass.
- 세션 시작과 기본 기억·비활성화·구형 설정 처리 테스트: 14 pass.
- `bun run typecheck`, `bun run lint`, `bun run ci:build`, `bun run ci:validate`: exit 0. lint는 기존 경고를 포함한다.
- root 타입 검사 대상 밖인 QA CLI도 별도로 검사해 0 diagnostics를 확인했다. 인자 없는 실행과 이미 존재하는 증거 경로는 exit 1이며 이전 결과를 변경하지 않았다.
- 최신 PR #8 CI는 author session을 재개하는 HTTP 테스트에서 200 대신 503으로 실패했다. 이번 PR #9 기반에서 해당 파일은 4 pass지만 PR #8 CI 실패가 해결됐다는 증거는 아니다.

OpenViking 실행 어댑터와 패키지 의존성은 기존 기반에서 이미 퇴역했다. 남은 구형 QA 스텁 3개를 삭제하고 checkpoint 안내·합성 도구 예시·호환성 이슈 선택지를 현재 로컬 엔진에 맞췄다. 활성 소스·패키지·lockfile·실행 스크립트에서 관련 참조가 없음을 확인했다. 퇴역 안내, 구형 도구 거부 테스트와 라이선스·과거 계획은 유지한다. 서비스·전역 설정·기존 외부 데이터는 변경하지 않았다.

원본은 Git 밖 세션 증거 폴더의 `moirai-r0/`에 있다: `candidate-6`, `native-fixture-final`, `live-1`~`live-6`, `live-6-verified.json`. 각 실행은 역할 원장, 실제 전송 기록, native history, 결과와 종료 기록을 가진다. 로컬 검사 로그도 같은 증거 폴더에 보존한다.

R1의 binding/회차 ledger, 진행 중 복구, R2의 판단·결과·해석 연결은 다음 작업이다. 30개 기준·중요 불변조건·90/80점·새 전체 배치 3연속, 동일 자원 비교와 추가 효용은 미검증 상태다. 기존 replay 리뷰의 플랫폼 차단도 이 실증으로 해소되지 않는다.
