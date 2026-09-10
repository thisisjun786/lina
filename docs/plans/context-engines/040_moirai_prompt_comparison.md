# 첫 C/E 비교의 구현 설계

의존: [PR 계획](034_moirai_prompt_pr_plan.md)의 문서 회차, [응답 계약과 원문](033_moirai_prompt_candidates.md). 이 문서는 첫 구현 회차의 변경 명세다. 아직 구현·실행 증거가 아니다.

## 변경 파일과 데이터 흐름

| 작업 | 경로 | 구현 내용 |
| --- | --- | --- |
| NEW | `packages/lina-codex/src/moirai-prompt-pack.ts` | C/E 선택, 공통·일반·역할·종합 지침과 출력 계약 조립, 고정 revision과 완성 지침 digest |
| NEW | `packages/lina-codex/src/moirai-judgment.ts` | 고정 입력과 외부 JSON 응답의 최소 구조·식별자·sourceRef·종합 후보 검증. 제품 효과 소유권이나 사실 판정은 만들지 않음 |
| MODIFY | `packages/lina-codex/src/moirai-probe.ts` | 선택적 QA 실험 계약. 선택 지침을 native thread/start와 gateway.expect 양쪽에 사용. raw 완료를 보존하고 판단 검증 뒤 종합. 새 스레드·한 회차, 재개 불가 |
| MODIFY | `scripts/qa/moirai-native.ts` | 명시적 `--prompt-condition=C\|E`, `--case=<id>` 조합으로 한 회차 실행. 기본 R0 세 회차는 유지. 완성 지침·입력·실패·usage·latency manifest 기록 |
| NEW | `scripts/qa/moirai-prompt-cases.ts` | 단순 요청, 사용자 정정, 충돌 근거의 고정 합성 입력과 로컬 provider의 합성 JSON 응답. 모델 입력에는 정답/평가 규칙을 넣지 않음 |
| NEW | `scripts/qa/moirai-prompt-compare.ts` | 각 사례의 C/E를 별도 native home/root에서 실행하고 양쪽 결과·실패를 모은 비교 명세. 기본 합성 실행만 제공 |
| NEW | `packages/lina-codex/test/moirai-prompt.test.ts` | 원문 조립·출력 구조·식별·출처 검증의 RED/GREEN |
| NEW | `packages/lina-codex/test/moirai-prompt-probe.test.ts` | 실제 probe의 지침 전달·독립 병렬·검증 후 종합·실패·재개 차단 계약 |
| NEW | `packages/lina-codex/test/moirai-prompt-compare.test.ts` | CLI 조건 검증과 쌍별 입력·한도·실패 분모·usage 기록. 실제 자식 fixture 명령으로 결과 파일 없는 실패를 주입. 기존 QA 코드 import로 타입 검사 연결 |
| MODIFY | `packages/lina-codex/test/moirai-probe-fixture.ts` | 새 테스트에 필요한 응답/지침 관찰을 선택적으로 제공. 기존 기본 출력은 유지 |
| MODIFY | `docs/ARCHITECTURE.md`, `030`, `032`, `033`, `034`, `040` | QA 구현과 합성 증거, 아직 수행하지 않은 실모델 평가를 구분해 현재 상태 갱신 |

gateway의 tool 차단·전송 검증, native 격리 정책, 기본 R0 복구 알고리즘, public barrel과 의존성은 변경하지 않는다. 불필요한 새 타입·함수는 기존 소유자를 재사용한다.

## 프롬프트·응답 계약

`PromptCondition = "C" | "E"`. CLI에서 선택하고 pack builder가 정규화한다. runtime manifest에 condition/revision/exactInstructions/digest를 직렬화하고 비교기는 해당 manifest를 읽어 불일치를 실패로 남긴다. unknown condition은 native 시작 전에 거부한다. 제품 설정이나 저장된 세션으로 읽히는 소비자는 없다.

프롬프트 원문은 033의 COMMON, GENERAL, ROLE, SYNTHESIS를 그대로 출발점으로 삼는다. C의 세 초기 지침은 동일하고 E는 각 역할 블록만 추가한다. Moirai 지침과 출력 계약은 두 조건에서 동일하다. 조립 순서와 UTF-8 완성 문자열을 고정해 기록한다. 지침 이름만 기록하거나 hash만 남겨 원문을 잃지 않는다. 코드의 canonical 문자열과 문서 원문을 값으로 대조하는 검증은 허용하지만 특정 표현의 존재를 성능 검사로 쓰지 않는다.

고정 입력에는 requestId/snapshotId/bindingGeneration, 원문·정정·제약, sourceRef/버전/현재성/원문, 빈 allowedRetrieval을 포함한다. 현재 roundId와 슬롯별 proposalId는 Host가 발급해 실제 송신 payload에 넣는다. 입력에는 Clotho/Lachesis/Atropos 이름을 넣지 않고 중립 슬롯 p1/p2/p3을 쓴다. 종합에 전달하는 결과도 중립 ID를 사용한다. C/E에서 사례 내용과 근거는 같고 실행 식별자만 달라질 수 있다. 역할 이름은 E의 지침에만 들어간다. 새 스레드에서 한 번만 실행하므로 대화 상태를 동기화하거나 과거 회차를 복구하지 않는다.

응답은 033의 JSON 계약을 따른다. 정해진 필드의 타입·열거값·nullable·배열 상한을 검증한다. roundId/snapshotId/proposalId는 Host 기대값과 같아야 한다. 인용한 sourceRef는 해당 입력에 존재해야 하며 유효한 현재 근거여야 한다. support의 근거 없는 주장은 거부한다. Moirai는 검증된 세 proposalId를 각각 한 번씩 다뤄야 한다. 존재하는 출처 ID를 붙인 거짓 주장을 자동으로 판별한다고 주장하지 않는다.

`invalidated`는 candidate=null이어야 한다. `ready`/`need_evidence`와 native/형식 실패는 구분한다. 무효화 판단이나 구조·식별·출처 실패가 있으면 Moirai를 호출하지 않는다. 실패 원문과 검증 오류를 남긴다. 모델이 need_evidence를 반환해도 조회나 추가 생성 호출은 하지 않는다. 정보 부족 자체는 관찰 가능한 결과다.

## 기존 probe의 변경 지점

```diff
 type Options = {
   rpc; root; model; threadParams; verifyThread; gateway;
+  experiment?: ProbeExperiment;
 };
- baseInstructions: moiraiInstructions(role)
+ baseInstructions: selectedInstructions[role]
- instructions: moiraiInstructions(role)
+ instructions: selectedInstructions[role]
```

새 계약의 전체 인터페이스는 다음과 같다. `MoiraiRole`과 `MoiraiProbeResult`는 기존 probe 타입을 재사용한다. 이 계약은 probe 모듈에서 만들고 실험 실행기가 소비한다. 파일에 실행 콜백 자체를 직렬화하지 않으며, 지침·입력·검증 결과만 원본 기록으로 남긴다.

```ts
type ProbeExperiment = {
  instructions: Readonly<Record<MoiraiRole, string>>;
  envelope(roundId: string, role: MoiraiRole, input: string): string;
  synthesisInput(input: string, results: readonly MoiraiProbeResult[]): string;
  validateOutput(roundId: string, role: MoiraiRole, text: string): void;
};
```

`moirai-prompt-pack.ts`는 `createPromptPack(condition: "C" | "E")`를 제공한다. 반환값은 `{revision: string, instructions: Record<MoiraiRole,string>, digest: string}`이다. `moirai-judgment.ts`는 `parseJudgment(text, expected)`를 제공한다. `expected`는 `{roundId, snapshotId, sourceRefs: readonly string[], proposalId?: string, proposalIds?: readonly string[]}`이며 proposer에는 proposalId, 종합에는 proposalIds를 준다. 반환값은 033의 검증된 JSON 객체다. 순수 validator가 출력 계약 문자열도 소유한다. case의 현재 근거만 sourceRefs에 넣는다. 타입 전용 import는 이 단방향 계약을 사용하고 public index에 노출하지 않는다.

슬롯은 기존 MOIRAI_ROLES의 앞 세 순서대로 p1/p2/p3이며 proposalId는 `${roundId}-p1` 형식이다. envelope와 validator는 하나의 슬롯 발급 함수를 공유한다. Moirai에는 proposalId를 발급하지 않고 세 proposalIds를 준다.

선택 지침은 생성 시 복사·고정한다. experiment가 없으면 기존 문자열을 사용한다. experiment가 있으면 initialize에서 비어 있지 않은 ledger를 거부하고 round에서 두 번째 회차를 거부한다. 완료 기록은 `resumable: false`로 기록해 기본 R0 reader로도 재개하지 못한다. 기존 R0의 `resumable: true` 의미를 바꾸지 않는다.

`runRole`은 experiment.envelope가 만든 중립 식별과 현재 입력을 intent에 쓴다. experiment가 없으면 기존 round/role/input 포맷을 그대로 쓴다. native와 provider 완료·원문 일치 검사를 마친 뒤 raw result를 보존하고 외부 JSON을 검증한다. 검증 오류는 기존 failure-role 기록에 남겨 원문과 연결한다. 실패했는데 complete.json을 쓰지 않는다. latency는 기존 gateway의 시작·종료 시각을 소비하고 없으면 null로 남긴다. 셋 중 하나가 실패하면 기존 `Promise.allSettled` 경로로 나머지 결과도 수집하고 종합은 보류한다. Moirai payload는 experiment.synthesisInput으로 Host가 검증한 세 결과만 담는다. 최종 JSON도 같은 경계에서 검증한 뒤 기존 native/history/readback 검사를 수행한다.

## 실행기 변경 지점

```diff
- for (let round = 1; round <= 3; round++)
+ for (let round = 1; round <= (promptExperiment ? 1 : 3); round++)
```

새 옵션은 입력 검증 후에만 root 생성과 native 시작을 허용한다. 조건·사례 중 하나만 있거나 존재하지 않는 사례는 거부한다. 첫 비교 명령은 유료 live 플래그를 제공하지 않고 로컬 합성 provider를 사용한다. 기존 R0 `--live` 의미와 모델 라우팅은 그대로 둔다. 새 비교 모드와 `--live`를 함께 전달하면 거부한다.

비교기는 checkout 밖의 비어 있는 새 root를 사용하고 사례별 C/E 자식 디렉터리를 만든다. native 생성은 각 조건 4회, 합계 8회이며 재시도는 없다. 요청당 4096 출력 토큰/120초, 조건당 최대 16384 출력 토큰이다. 기존 gateway의 episode 6회 상한보다 작은 실험 상한이다. 사용하지 않은 슬롯을 옮기지 않는다. 실제 비용은 같은 한도와 다르며 reasoning usage의 가용성과 값도 별도 보존한다.

실패한 첫 조건 때문에 둘째 조건의 기록을 누락하지 않는다. 각 조건 결과에는 상태, 실제 시도 수, 완료된 역할, 원문 경로, 지침·입력 신원, usage 또는 null, latency, 종료 receipt를 남긴다. outbound attempt 원문에서 조건별 4회 이하인지 대조한다. 실패 조건을 분모에서 제거하지 않는다. 비교 manifest에는 예상한 조건·사례 수와 실제 성공/실패 수를 함께 둔다. 오류로 자식 result.json이 없으면 exit code와 stderr를 실패로 보존한다. shell 문자열 조합 없이 인자 배열로 실행한다.

각 조건은 별도 프로세스로 실행해 native home까지 분리한다. 비교기는 두 runtime manifest의 exact model, requestOptions, native executable/wrapper identity, 구현 신원이 같은지 대조한다. home별 capability fingerprint는 경로 때문에 달라질 수 있어 같다고 주장하지 않는다. 입력 신원은 실행 식별자를 제외한 고정 사례 payload의 digest로 대조한다. 불일치는 비교 실패다. CLI 분기·사례·합성 응답·요약 함수는 테스트가 import하는 QA 모듈에 두어 타입 검사한다. 기존 최상위 CLI 전체가 타입 검사된다고 주장하지 않는다.

의도한 manifest 설정과 실제 outbound를 구분한다. 각 outbound의 model, reasoning, max_output_tokens, tools, tool_choice 및 PROBE_REQUEST_OPTIONS 필드를 대조한다. C의 실제 전송 envelope와 종합 payload에 역할 이름이 없다는 것도 테스트한다. 잘못된 JSON·ID·출처·종합 ID는 in-memory probe 테스트에서 주입하며 첫 CLI에 fault 플래그를 추가하지 않는다.

비교기의 `runComparison` 함수는 내부 옵션 `commandFor(condition, caseId, childRoot): readonly string[]`를 받는다. 기본값은 현재 Bun과 moirai-native.ts 인자 배열이며 CLI로 임의 실행 파일을 받지 않는다. 테스트에서는 이 옵션으로 실제 Bun 자식 fixture를 실행한다. C 자식은 stderr에 식별 가능한 합성 오류를 쓰고 종료 코드 7로 종료하며 result.json을 만들지 않는다. E 자식은 별도 방문 기록과 합성 결과를 남긴다. 비교기를 끝까지 실행한 뒤 C의 종료 코드·stderr·결과 누락, E 실행, 분모 2개와 실패 조건 포함을 확인한다. 단순 요약 함수 테스트로 이 자식 실행 경계의 검증을 대체하지 않는다.

## 위임

실행 흐름과 프롬프트 계약은 순차 의존하지만 파일 쓰기는 나눌 수 있다. executor는 확정된 `moirai-prompt-pack.ts`, `moirai-judgment.ts`, `moirai-prompt.test.ts`만 구현하고 RED/GREEN을 반환한다. main은 probe, fixture, QA CLI/비교 실행과 해당 테스트를 소유한다. 양쪽이 합의한 타입·필드명은 본 문서에서 먼저 확정한다. 서로의 파일을 수정하지 않고 반환 diff를 main이 직접 검토한다.

## 관찰 가능한 완료 조건

| 활성화 사례 | 기대 관찰 |
| --- | --- |
| 동일 입력의 C/E | C의 세 지침은 동일, E는 역할별 원문만 다름, 종합 지침·모델·wire 옵션·한도는 동일 |
| 세 판단을 차례로 완료 | 셋 모두 완료·검증될 때까지 종합 호출 0회. 독립 판단 payload에 다른 판단의 출력 없음 |
| 단순 요청·정정·충돌 근거 | 같은 고정 자료가 양쪽에 전달되고 구조화된 결과와 종합 원문이 보존됨. 합성 응답은 인지 효과 증거가 아님 |
| JSON 파손, 잘못된 ID, 미등록/오래된 출처, 중복/누락 종합 ID | 해당 원문·오류가 실패 기록에 존재. 초기 판단 실패면 종합 호출 0회 |
| need_evidence 또는 invalidated | 추가 조회·재시도 없음. need_evidence는 결과에 보존, invalidated는 종합 보류 |
| 두 번째 회차/기존 ledger로 재개 | native 생성·turn 시작 전에 거부. 기본 R0 복구 테스트는 유지 |
| 취소·native 실패·결과 파일 누락 | 완료로 표시하지 않고 시도 수·실패·가능한 usage·소요 시간·종료 결과 보존 |
| 비교 CLI 잘못된 condition/case/root/live | 계정·provider 접근과 native 시작 전에 거부 |

합성 fixture는 이 실행 계약을 검사한다. 정답 품질, 역할 분화의 실제 효용, 모델별 최적화 성능, 사실의 참·거짓은 이번 PR의 자동 판정 대상이 아니다.

QA 검증은 E7 테스트·코드 경계에 해당한다. 실행 표면은 opt-in CLI와 probe다. 호출자가 이를 쓰지 않는 우회 경로는 제품 runtime에 남아 있으므로 제품 권한 강제라고 부르지 않는다. 최종 효과 실행 강제 계층은 이번 PR에 없다. 기존 R0의 native sandbox와 gateway tool 차단을 사용하며 그 경계를 새로 설계하지 않는다.
