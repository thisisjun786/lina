# R0: 네 지속 Codex 스레드 실행 증거

2026-09-10. QA 전용 구현과 실제 GLM 호출을 확인했다. **하나의 합성 채널에서 세 판단을 병렬 실행하고 모이라이가 종합한 뒤, native 프로세스를 다시 열어 같은 네 스레드를 이어 갔다.** 제품 인지 회차나 사용자 채널에 연결하지 않았다. `candidate-7`의 독립 코드 리뷰는 R0 구현과 OpenViking 잔여 정리 범위에서 PASS였다. 이후 CodeRabbit과 Codex 리뷰가 발견한 결함과 각 수정 후보의 검증을 아래에 구분해 기록한다.

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

같은 검토에서 사용량·응답 모델 검사도 보완했다. 음수·문자열·합계 불일치·4,096 초과 출력 토큰은 원본을 저장한 뒤 실패로 판정한다. 사용량 미제공은 `null`이며 0으로 바꾸지 않는다. live 실행은 provider가 반환한 `glm-5.3-flash`를 정확히 확인한다. 이 조건의 회귀 검사 6개는 수정 전 실패했고 수정 후 통과했다.

수정 후보 `candidate-7`의 `live-7`도 새로 실행했다. 12개 송신·19,182토큰, 세 회차 모두 같은 네 thread, 누적 이력 1→2→3, 종합 전 세 판단 완료, 정상 재시작과 완료 후 SIGKILL 재개를 확인했다. 판단 동시 실행 구간은 회차별 4,637/2,484/3,806ms였다. 종료 후 모든 기록된 PID가 없었다. `live-7-verified.json`과 후보 해시가 이 결과의 기준이며 이전 후보의 통과를 재사용한 판정이 아니다.

이전 실험도 보존했다. `live-1`~`live-3`은 송신 전 실패, `live-4`는 첫 회차 4개 호출·2,686토큰 뒤 다음 회차 실패, `live-5`는 이전 후보의 12개 호출·16,230토큰 성공이다. 후보를 수정한 개발 실험이므로 연속 qualification으로 세지 않는다. 초기 실패 기록에는 세부 native/capture 오류가 없으며 현재 후보에서 각각을 남기도록 보완했다.

## 로컬 검증과 남은 일

### CodeRabbit 후속 수정

`219368b`를 검토한 CodeRabbit의 [입력 검증](https://github.com/thisisjun786/lina/pull/9#discussion_r3977956846), [증거 경로](https://github.com/thisisjun786/lina/pull/9#discussion_r3977956856), [종료 확인](https://github.com/thisisjun786/lina/pull/9#discussion_r3977956885) 지적은 모두 유효했다.

- native 입력은 저장된 문자열과 같은 `text` 항목 정확히 하나만 허용한다. 이미지·빈 항목·잘못된 자료형이 섞인 이력이 통과하던 결함을 수정했다. 회귀 검사는 수정 전 실패했다.
- 실행기는 상대 경로와 현재 checkout 내부의 증거 경로를 파일 생성 전에 거부한다. 상위 경로의 심볼릭 링크도 거부한다.
- `rpc.close()` 뒤 소유 프로세스 그룹의 존재를 확인하고 `shutdown-N.json`에 결과를 저장한다. 그룹이 남거나 종료·관찰 오류가 있으면 실험은 실패이며 `ownedProcessesClosed`도 거짓이다.

관련 테스트는 28 pass다. 별도의 살아 있는 자식 프로세스로 종료 여부 검사를 확인했고, CLI에 상대 경로·checkout 내부 절대 경로를 넘겼을 때 exit 1과 파일 미생성을 확인했다. `bun run typecheck`, `bun run lint`는 exit 0이며 QA CLI를 포함한 별도 타입 검사도 0 diagnostics다.

수정 후보의 `native-fixture-coderabbit`는 설치된 Codex와 합성 provider로 세 회차를 완료했다. 정상 재시작과 완료 후 SIGKILL 재개를 통과했고 세 소유 프로세스 그룹 모두 종료됐음을 기록했다. 이번 수정 검증에서는 유료 모델을 호출하지 않았다. 이전 `live-7`의 실모델 증거와 별개이며 새 CodeRabbit 승인이나 qualification을 뜻하지 않는다. 원본 리뷰·검사 로그·후보 해시는 Git 밖 `moirai-r0/coderabbit-repair/`에 보존한다.

### Codex 리뷰 후속 수정: 전체 전달 이력과 출력 대조

`da3dde5`의 CI는 `dev-gate`까지 통과했지만, Codex 리뷰에서 [이전 전송 이력 누락](https://github.com/thisisjun786/lina/pull/9#discussion_r3978126115), [provider/native 출력 불일치](https://github.com/thisisjun786/lina/pull/9#discussion_r3978126124), [native 이력 순서 변경](https://github.com/thisisjun786/lina/pull/9#discussion_r3978126134)을 통과시키는 세 결함이 확인됐다. 같은 커밋의 CodeRabbit `SUCCESS` 상태는 재리뷰 승인이 아니다. 봇은 자동 리뷰를 건너뛴다고 알렸고 마지막 실제 리뷰 대상은 `219368b`였다.

현재 수정은 다음 계약을 적용한다.

- 게이트웨이는 이전에 수신한 전체 입력과 provider의 최종 출력이 다음 입력 앞부분에 같은 순서·내용으로 있는지 확인한다. 메시지 역할·텍스트 항목 경계·phase와 reasoning의 summary·opaque 내용도 비교한다. ID·완료 상태·annotation 같은 전송 메타데이터는 비교에서 제외하며 원본 wire에는 남긴다. 현재 사용자 입력도 정확히 하나의 텍스트 항목이어야 한다.
- 재개 중 새로 추가된 native 환경·권한·skill 안내는 허용된 envelope 형태만 받는다. 이 안내 내부의 의미가 안전한지까지 인증하는 검사는 아니다. 이전에 전달된 안내는 다음 회차부터 전체 prefix 비교에 포함한다. 별도 provider 문맥을 불러오는 `previous_response_id`·`conversation` 등 미지원 전송 필드는 거부한다.
- provider의 최종 assistant 출력과 native 완료 텍스트가 같아야 역할 결과를 확정한다. 불일치면 종합을 시작하지 않고 양쪽 결과·사용량을 실패 기록에 남긴다.
- 회차 시작과 완료 기록에 같은 1부터 시작하는 연속 순번을 저장한다. 재개 전에 순번과 네 역할의 전송 기록 연결을 검증하고 native turn의 위치까지 대조한다. 순번·capture가 없는 과거 원장은 원본 그대로 보존하며 자동 보정하거나 새 증거로 인정하지 않는다.

관련 테스트 51 pass, Codex 패키지 281 pass/41 skip, root 타입·QA CLI 타입·lint가 통과했다. 입력 이력 변조와 출력 불일치 재현은 수정 전 실패·수정 후 통과했다. 순서 검증의 RED/GREEN 로그도 보존한다. 테스트 기대값은 합성 입력·응답으로 지정했으며 실제 모델의 답을 기준값으로 복사하지 않았다.

`native-fixture-review-history-2`는 설치된 Codex와 합성 provider로 새 세 회차를 통과했다. 이어 `live-review-history`에서 Linux/Codex `0.153.4`/Bun `1.4.0`/OpenCodex Responses/`ollama-cloud/glm-5.3-flash`의 실제 12회 송신과 19,152토큰을 기록했다. 같은 네 thread를 유지했고 각 회차의 전체 wire 입력 항목 수는 역할별 3→8→12개였다. 세 판단 완료 후 종합, 정상 종료 후 재개, 완료 후 SIGKILL 재개, 세 소유 프로세스 그룹 종료를 확인했다. 직접 청구 금액과 OpenCodex 내부 물리 재시도 횟수는 미측정이다.

개발 도중 `native-fixture-review-history`는 첫 회차 완료 뒤 재개 capture 연결이 빠져 실패했다. 이 기록과 실패 원인도 보존한다. 합성 fixture의 미지원 필드로 테스트가 멈춘 중간 로그도 삭제하지 않는다. 최종 원본·후보 해시·검사 로그는 Git 밖 `moirai-r0/review-history-repair/`에 있다. 이 실증은 R0 전송과 완료 회차 재개에 한정하며, 독립 인지 qualification·진행 중 효과 복구·기존 replay 리뷰의 차단 해소를 뜻하지 않는다.

### 기존 검증과 미완료 범위

- 관련 조정기·게이트웨이·checkpoint·도구 테스트: 37 pass.
- Codex 패키지와 checkpoint/prompt 테스트: 247 pass, 41 skip. opt-in native 검사는 기본 suite에서 생략되며 위 별도 native 실증과 범위가 다르다.
- 자체 기억·자료 엔진/저장/도구/API 테스트: 38 pass.
- 세션 시작과 기본 기억·비활성화·구형 설정 처리 테스트: 14 pass.
- `bun run typecheck`, `bun run lint`, `bun run ci:build`, `bun run ci:validate`: exit 0. lint는 기존 경고를 포함한다.
- root 타입 검사 대상 밖인 QA CLI도 별도로 검사해 0 diagnostics를 확인했다. 인자 없는 실행과 이미 존재하는 증거 경로는 exit 1이며 이전 결과를 변경하지 않았다.
- 리뷰 수정 후 조정기·게이트웨이 25 pass, Codex 패키지 254 pass/41 skip을 확인했다. 위 초기 검사 수와 합산하지 않는다.
- 최신 PR #8 CI는 author session을 재개하는 HTTP 테스트에서 200 대신 503으로 실패했다. 이번 PR #9 기반에서 해당 파일은 4 pass지만 PR #8 CI 실패가 해결됐다는 증거는 아니다.

OpenViking 실행 어댑터와 패키지 의존성은 기존 기반에서 이미 퇴역했다. 남은 구형 QA 스텁 3개를 삭제하고 checkpoint 안내·합성 도구 예시·호환성 이슈 선택지를 현재 로컬 엔진에 맞췄다. 활성 소스·패키지·lockfile·실행 스크립트에서 관련 참조가 없음을 확인했다. 퇴역 안내, 구형 도구 거부 테스트와 라이선스·과거 계획은 유지한다. 서비스·전역 설정·기존 외부 데이터는 변경하지 않았다.

원본은 Git 밖 세션 증거 폴더의 `moirai-r0/`에 있다: `candidate-6`/`candidate-7`, `native-fixture-final`/`native-fixture-resume-repair`, `live-1`~`live-7`, `live-6-verified.json`/`live-7-verified.json`. 각 실행은 역할 원장, 실제 전송 기록, native history, 결과와 종료 기록을 가진다. 로컬 검사 로그도 같은 증거 폴더에 보존한다.

R1의 binding/회차 ledger, 진행 중 복구, R2의 판단·결과·해석 연결은 다음 작업이다. 30개 기준·중요 불변조건·90/80점·새 전체 배치 3연속, 동일 자원 비교와 추가 효용은 미검증 상태다. 기존 replay 리뷰의 플랫폼 차단도 이 실증으로 해소되지 않는다.
