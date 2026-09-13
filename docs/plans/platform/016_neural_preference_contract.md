# 모이라이 코어의 판단·선택·학습·실행 계약

상태: 2026-09-13 확정 계약(D22·D23 반영). 정본 [MOIRAI_ENGINE](../../MOIRAI_ENGINE.md)의 세 판단 모듈·조정 정책·행동 catalog·의도 schema·회로 프로필을 입력·계산·결과·학습·저장·복구 계약으로 구체화한다. F1 공통 레코드·파서·정책·저장소는 구현됐고 F2 포트·메커니즘·제품 연결은 남아 있다. Senpi QA는 제품 통합 증거가 아니다. [015](015_neural_preference_engine_research.md)는 근거와 출처를, [017](017_moirai_module_composition.md)은 소스 재료·F1–F4 로드맵·검증 가설을 소유한다.

모이라이는 한 개인 안에서 서로 다른 목표를 추구하는 세 판단을 종합한다. 클로토는 미래 성과·성장 가능성, 라케시스는 자신의 욕구·선호 충족, 아트로포스는 채택한 목표·약속·정체성의 연속성을 우선한다. 라케시스의 학습된 선호는 Google Research가 소개한 **MaleCNS v1.0** 부분회로로 구현한다. 개인 대화·학습·LIFE 선택·재시작·8명 운영을 연결하며 비교 실험은 구현을 선택하는 증거로 사용한다.

## 결정과 현재 연결 지점

현재 F1 계약 기준은 PR #14의 `13ff9b2f0b243d1b7adaa6eabd59d4ad66272da8`이다. **대화·인지·개발 작업 백엔드는 Codex, 프로바이더 관리는 OpenCodex**로 유지한다(D22). PR #10의 Senpi QA는 비교 자료로 보존하며 제품 어댑터의 출발점이나 통합 완료 증거로 취급하지 않는다. F2는 기존 Codex RPC·SessionPort·TaskManager 경계에 typed 판단을 연결한다.

| 현재 소유자 | 확인한 책임 | 제안하는 변경 |
| --- | --- | --- |
| [개인 성장 생성](../../../packages/lina-runtime/src/persona/native-growth.ts#L161) → AgentStore | 허용된 경험의 모델 해석을 성향 값으로 저장 | 지정 dimension의 생성자를 기존 해석 또는 신경 투영 중 하나로 선택 |
| [성향 합성](../../../packages/lina-core/src/agents/persona.ts#L53) → 대화·LIFE | 정체성·lock을 지키며 허용된 현재 성향 제공 | 새 신경 출처의 유효성·revision을 확인한 투영만 소비 |
| [Moirai 입력 조립](https://github.com/thisisjun786/lina/blob/5b22aee53f9f7c01cc508289099f662aed613140/scripts/qa/senpi-sdk/moirai-runner.ts#L145) | 원래 대화와 완결된 익명 조언 원문 | 원문을 보존하는 typed assessment, 공통 후보 평가, 행동 prepare/finalize 모드 |
| [제품 세션 조립](../../../packages/lina-runtime/src/session-app.ts#L500)·[SessionPort](../../../packages/lina-runtime/src/sdk-port.ts#L27) | 기존 실행 세션을 DurableRuntime에 연결 | Codex 어댑터와 제품 회차 조정기가 내부 조언·종합을 수행하고 하나의 논리 대화 포트만 외부에 노출 |
| [대화 기록·정착](../../../packages/lina-runtime/src/runtime.ts#L182)·[출처 결합 저장](../../../packages/lina-core/src/store.ts#L300) | 응답 entry와 request의 출처 연결·settlement | 수락한 최종 응답·DialogueJudgmentRef·학습 TraceRef 결합을 대화 owner가 원자적으로 기록 |
| [LIFE director](../../../packages/lina-runtime/src/life/director.ts#L82)·[영속화](../../../packages/lina-core/src/world/autonomy-persistence.ts#L513) | actor·target·reflection, prepare/reconcile | 확정 결정 참조와 실행 가능 상태를 소비; 순수 재계산에서 신경 상태를 진행하지 않음 |

새 경계가 필요한 이유는 계산량·실행 언어와 상태 수명 때문이다. 모이라이가 판단·목표 조정·선택 규칙을 소유하고 Host가 현재성·권한 검사·선택 원자 기록·효과 인계를 맡는다. 그리고 별도 Python 계산기는 불변 snapshot을 받아 수치 결과만 반환한다. 채널·Memory가 Python이나 실행 SDK를 직접 호출하지 않는다. 기존 성장 함수에 시뮬레이터와 DB 쓰기를 함께 넣는 안은 재시도 시 학습·추출이 중복될 수 있어 채택하지 않는다.

아래 명세는 기존 공개 API를 즉시 바꾸지 않는다. 후속 구현은 타입 버전, source proof, 저장 복구와 각 소비자를 같은 단위에서 변경한다.

Codex 연결은 기존 `lina-codex/src/session.ts`, `rpc.ts`, `tasks.ts`와 제품 `SessionPort`를 재사용한다. R0의 `moirai-probe*`는 역할 thread·재개·출처 검사의 참고 자료다. QA capture provider·임시 경로·고정 모델·도구 권한을 제품에 복사하지 않는다. Codex thread/turn 수명·응답·usage를 Host 포트에 대응시키고 원래 request·source 연결은 Host가 소유한다. 신경 계산기는 실행 SDK와 독립된 포트 뒤에 둔다.

## 세 판단 모듈의 계약

분리 기준은 각 모듈의 고유 목표와 답을 비교하는 기준이다. 목표 정의는 [정본의 세 판단 모듈](../../MOIRAI_ENGINE.md#세-판단-모듈)을 따른다. 상태·계산·결과 확인 방법은 그 목표를 판단하는 수단이다. 세 모듈에 같은 목표를 주고 근거만 달리 읽히는 구조나 계획/점수/승인 기능만 분업하는 구조로 축소하지 않는다. 기억·정정·권한 원본은 공유한다.

의존 방향은 `Host → 판단 포트 → 허용된 기억/목표/계산 포트`다. Codex는 LLM 호출 어댑터, Python은 라케시스의 수치 계산 어댑터다. 모듈은 서로의 내부 상태를 수정하지 않는다. 기존 QA의 `proposals: string[]`에서 아래 버전 있는 판단 계약으로 옮기는 변경은 제품 Codex 연결과 소비자 검증을 함께 요구한다.

```text
PromptAsset = { promptId, revision, role, layerHashes: { common, role, model },
  objectiveProfileRef?, presetRef, evidenceRefs }
PromptExperiment = { experimentId, revision, baseline: PromptAsset[], candidate: PromptAsset[],
  presetRef, cases: { caseId, revision, inputDigest, split: dev | holdout, category }[],
  repetitions, orderRule, judge: { kind, revision, rubricRef }, adoptionCriteria }
PromptRun = { runId, attemptId, configuration: baseline | candidate, caseId, repetition,
  wireCaptureRef, outcomeRefs, judgeScore | unscorable, usage, elapsed, terminationReason }
```

새 `mechanismRevision`은 프롬프트 자산 revision·encoder/readout 버전·정책 코드 버전을 canonical JSON으로 묶어 만든 `sha256:<64자리 소문자 hex>`다. F2 메커니즘 owner가 내용을 구성한다. F1 파서는 형식과 입력 해시 결합을 확인하며, 기존 숫자 revision은 과거 기록의 원래 바이트·해시로 읽는다. 숫자 문자열이나 태그 없는 해시는 허용하지 않는다. 역할 자산의 역할 계약 층은 `ObjectiveProfile`에서 생성하므로 프로필 revision 변경은 자산 revision 변경이다. 자산 변경은 새 revision과 새 binding generation으로만 적용하고 진행 회차의 프롬프트를 바꾸지 않는다. 실험은 완전한 쌍만 품질 비교에 넣고 누락·중복·장애·`unscorable`을 별도 분모로 보고하며, `split: holdout` 사례는 결과를 보고 수정한 순간 `dev`로 이동한다. 절차·층 구조·독립성 조건은 [정본 D20](../../MOIRAI_ENGINE.md#역할-프롬프트와-개선-루프)이 소유한다.

| 판단 모듈·고유 목표 | 입력과 계산 | 출력과 결과 확인 |
| --- | --- | --- |
| 클로토 `prospect`: 미래 성과 | 목적·현재 세계·근거에서 LLM이 전체 행동과 후속 단계를 제안. 코드가 의존 관계·시간·자원 조건을 검사하고 허용된 검증 결과를 예상에 연결 | `Forecast`: 후보 key, 예상 결과·범위·기한·비용, 근거와 가정, 확인 방법. 실제 결과와 비교한 오차를 다음 계획 입력으로 전달 |
| 라케시스 `value`: 욕구·선호 충족 | 출처 있는 경험과 현재 동기·정서 상태를 조회. LLM이 단서를 해석하고 개인의 고정 snapshot에서 MaleCNS 반응을 계산 | `ValueAssessment`: 경험 참조, cue·probe·trace 참조, 제한된 편향과 가용성. 확인된 피드백이 귀속된 개인 가중치만 갱신 |
| 아트로포스 `continuity`: 의도·연속성 유지 | 현재 지시·목표·약속·자기모델·완료/중단 조건을 조회. 상태 전이와 자원 충돌은 코드로 검사하고 모호한 변경은 LLM이 해석 | `ContinuityAssessment`: 의도·약속 참조, 충돌 이유·심각도·대안, 변경 제안. owner의 수락과 실제 완료 결과로 상태 전이 확인 |

모든 출력은 전문 계산 결과와 함께 자기 목표의 후보별 이득·손실·불확실성·추천 이유를 가진다. 타 모듈 목표의 이득을 공통 최적화 보상으로 복사하지 않는다. 같은 사실에 다른 추천을 내는 것은 정상이며, 일치와 불일치를 강제하지 않는다.

필수 현재 원문·정정·권한·source snapshot은 셋 모두 같다. 전문 근거에는 출처와 실제 소비한 revision을 기록한다. 각 모듈은 전체 행동 대안을 제안할 수 있고 최초 판단은 다른 모듈 출력을 보지 않고 병렬 생성한다. 라케시스만 사실을 확인하거나 아트로포스만 권한을 아는 구조로 만들지 않는다.

### 입력과 결과의 식별

```text
JudgmentSnapshot = { schemaVersion, roundId, agentId, scopeId, sourceRefs,
  workingRevision, instructionRevision, policyRevision, identityRevision,
  domainRevisions, intentionRevision, objectiveProfileRefs,
  observationRef, frozenNeuralRef, situation, clockId, sequence, bindingGeneration }
Assessment = { schemaVersion, moduleKind, snapshotId, inputDigest,
  objectiveRef, mechanismRevision, completeText, evidenceRefs, proposedOptions,
  objectiveAssessments, recommendedOptionKeys,
  forecasts | values | continuity, diagnostics }
```

`ObjectiveProfile`은 moduleKind·objectiveId·revision·고유 목표·후보 비교 기준·재고 조건을 가진다. 모듈의 상위 판단 목표이며 LIFE의 특정 GoalState나 수락한 IntentionRecord와 구분한다. 정의·revision·개인별 활성 참조의 단일 writer는 `JudgmentStore`의 판단 설정 영역이다. snapshot은 세 프로필의 불변 참조를 고정한다. 과거 회차·결과가 참조하는 정의는 복원 가능한 상태로 보존한다. LLM이 회차 중 목표를 바꾸거나 합의에 맞춰 셋의 목표를 같게 만들 수 없다. 정당한 프로필 변경은 revision을 올리고 영향을 받는 회차·캐시를 무효화한다.

`objectiveAssessments`는 후보별 자기 목표의 이득·손실·불확실성·근거와 상대적 선호를 담는다. 숫자 점수는 단위·비교 규칙이 있을 때만 사용한다. 판단·후속 평가·종합·결과 처리·재생 모두 objectiveRef를 보존하며 다른 목표 revision의 결과를 섞지 않는다.

`workingRevision`은 현재 문맥의 revision이고 `instructionRevision`은 원본 request·현재 지시의 revision이다. 서로 대신하지 않는다. 도메인별 공개된 읽기 결과와 원본 참조를 조립하고 읽기 전후 버전·확정 직전 현재성을 확인한다. 여러 DB를 원자적으로 읽는다고 가정하지 않는다.

위 표기는 필수 영역을 나타내며 `forecasts | values | continuity`는 moduleKind에 따른 구분 타입이다. `completeText`는 생성된 모듈 의견의 제한된 읽기 결과다(D23). 새 `buildAssessment`는 설명문이 4,000 UTF-16 code unit을 넘으면 surrogate pair를 보존하며 자르고 `diagnostics.readoutTruncation`에 원래 길이·상한·원문 SHA-256을 남긴다. 이 상한은 토큰 수가 아니다. 저장된 레코드의 파서는 절대로 자르거나 해시를 다시 쓰지 않는다. 잘린 원문은 보관하지 않으므로 이 해시는 생성 시점의 주장된 출처이며 파서가 대조할 수 있는 검증된 내용이 아니다. 원문 대조가 필요한 소비자는 생성 단계에서 원문을 따로 보존해야 한다. 구조화된 결과를 만들 수 없으면 텍스트만으로 정상 판단을 대신하지 않는다. 모델이 주장한 계산 결과·참조는 Host가 실제 도구/계산 receipt와 대조한다. 모델·세션 ID는 진단 자료이며 판단의 권위나 별도 인격이 아니다.

클로토의 `projectConsequences`는 해당 개인에게 공개된 도메인 상태와 선언된 규칙만 사용하는 제안 조회 포트다. 실제 World 진행이나 비공개 상태의 정답 복사를 예측으로 사용하지 않는다. `forecastId`, `optionKey`, 관측 항목·시점과 `predictionMethodRevision`을 실제 결과에 연결한다.

Forecast의 결과·비용·기한은 각각 `Claim { claimId, kind: observed | assumption | prediction, value, unit, sourceRefs, assumptionRefs, verificationStatus, horizon }`으로 표현한다. 직접 관측한 값과 예상값을 구분하고 출처는 해당 claim의 대상·범위·시점과 일치해야 한다. 유효한 receipt 하나가 문서 전체의 사실성을 보장하지 않는다. BaselinePolicy는 catalog가 허용한 claim 종류·단위·검증 상태만 읽고, 예상값은 가정·불확실성 처리 규칙을 적용한다. LLM이 붙인 확신 수치만으로 검증 상태를 올리지 않는다.

학습된 관심은 원문 주제와 허용된 활동 catalog를 같은 snapshot에서 조회해 후보 생성 전에도 공급한다. 어떤 후보가 관심 때문에 제안됐는지 기록한다. 공통 탐색 자료로 받은 관심이 클로토·아트로포스의 상위 목표를 선호 충족으로 바꾸지는 않는다. 최초 세 의견은 아직 서로 다른 후보를 다룰 수 있으므로 바로 평균·투표·추첨하지 않는다.

### 같은 후보를 비교하는 단계

`moirai_prepare`는 세 의견과 근거에서 공통 `CanonicalOption` 집합을 제안한다. Host가 정규화한 뒤 각 모듈의 `evaluateOptions(snapshot, candidates)`를 호출한다. 각자는 자기 목표에 따른 후보별 추천과 이유를 채우고 클로토의 예측, 라케시스의 경험·단서 반응, 아트로포스의 의도·약속 충돌을 근거로 붙인다. 후보 key·snapshot·objectiveRef·mechanism revision이 같은 기존 결과는 재사용한다.

이미 계산 가능한 후보는 코드와 신경 조회로 평가한다. 새 후보의 예측·의미 해석이 부족하면 해당 모듈의 추가 LLM 호출과 비용을 기록한다. 최초 의견의 독립성과 이 후속 평가는 구분한다. 후속 평가에서도 다른 모듈의 결론은 입력하지 않는다. 각 `optionKey × moduleKind`에 유효 평가 또는 정책이 허용한 명시적 `unavailable` 사유가 있어야 한다. 비교할 수 없는 후보를 조용히 탈락시키거나 0점으로 취급하지 않는다. 필요한 평가가 없거나 남은 후보의 평가가 `unavailable`이면 policy revision 2는 순위를 만들지 않고 보류한다. Host는 같은 요청의 예산 안에서 보완하며 저장된 Assessment를 덮어쓰지 않는다. 이미 기록한 회차를 재개하지 않고 필요하면 새 회차를 만든다. revision 1의 모듈 전체 제외 방식은 과거 재생에만 남긴다.

새 근거가 공통 세계 사실을 바꾸면 snapshot을 무효화하고 새 회차에서 셋 모두에게 공급한다. 새 후보·효과 범위가 추가되면 candidate revision을 올려 해당 평가를 완료한 뒤 선택한다. 평가 횟수·시간·모델·수치 계산 예산과 실패를 기록하며 예산 부족을 가짜 완전성으로 숨기지 않는다.

Host는 `candidateLimit`, `maxEvaluationGenerations`, `maxAdditionalCalls`, 회차 deadline을 먼저 고정한다. 이 예산은 후보 revision이나 무효화 후 후속 회차에서도 같은 원래 요청/자율 활동 슬롯에 누적한다. `closeCandidateSet`이 후보 hash와 coverage를 확정한 뒤에는 새 후보를 같은 선택에 끼워 넣지 못한다. 확정 뒤 제안은 후속 회차에 남기고 실제 전제를 바꾸는 근거만 현재 회차를 무효화한다. 예산 소진 시 `deferred`로 끝내며 선택 RNG·outbox는 진행하지 않는다. 후보 또는 평가가 불완전한 행동 회차도 비실행 종료 기록을 저장할 수 있다. 이때 `SelectionSpec`·순위·양보·충돌 판정은 없고, `holdReason`에 종료 원인을 남긴다. 제공된 후보 근거와 현재성 검사는 그대로 수행한다.

세 Assessment가 모두 도착했어도 판단 불가가 남으면 policy revision 2의 결과는 `held`다. 예산까지 끝났다면 Host는 이 결과의 `status`만 `deferred`, `holdReason`만 공통 상수 `EVALUATION_BUDGET_EXHAUSTED`로 바꿔 최초 종료 기록을 저장할 수 있다. 나머지 필드는 정책 재생 결과와 같아야 하고 `SelectionSpec`은 없다. 예산 소진 전환은 revision 2의 규칙이므로 revision 1로 재생한 `held`는 전환하지 않고 재시도 가능한 상태로 남긴다. 이미 저장한 `held` 회차를 수정하거나 재개하지 않는다. 이미 선택한 뒤의 실패라면 기존 `held` 결정을 유지하거나 취소한다.

증거가 불완전한 회차의 비실행 종료 기록도 policy revision 2의 규칙이다. revision 1 회차는 재시도 가능한 `held`로만 끝나며 새 종료 상태로 닫지 않는다. 종료 기록의 `holdReason`은 `EVALUATION_BUDGET_EXHAUSTED`여야 한다. 예산이 남아 있으면 회차를 열어 두고 보완하며, 다른 사유의 중단은 `held`로 남긴다. 기록을 남기면 그 회차에는 더 이상 평가를 저장할 수 없으므로 남은 보완 기회를 임의로 버리지 않는다. 정책 재생이 불가능하므로 revision 2의 `deferred` 기록은 스스로 증명할 수 있는 값만 담는다. 판단 순서는 선언된 정책의 해당 상황 순서와 같아야 하고, 모듈별 추천은 실제 저장된 Assessment의 `recommendedOptionKeys`와 같아야 하며 평가가 없는 모듈은 비어 있어야 한다. 제외·기권·충돌·순위·양보는 후보 집합과 완결된 평가에서만 나오므로 비운다. 기존 `held` 기록의 서술 필드 범위는 PR #14 계약을 유지하며, 과거 바이트·해시를 보존하기 위해 별도 버전 규칙 없이 좁히지 않는다. `held` 경로는 정책 선언을 조회하지 않는다. 이 binary가 모르는 catalog·revision으로 기록된 과거 행 하나가 저장소의 다른 읽기까지 막지 않아야 한다.

`AssessmentSet`은 snapshotId·candidateSetHash·objectiveProfileRefs·모듈별 평가 해시·누락 사유를 묶는다. Host는 현재성·필수 조건으로 적격 후보를 확인한다. 모이라이의 종합 기능은 LLM 해석과 `ArbitrationPolicy`를 포함하며, 각자의 추천을 유지한 채 목표 충돌을 조정한다. 종합 LLM이나 Host가 선언된 정책 밖의 임의 우선순위를 적용하지 않는다.

`ResolutionRecord`는 `mode: dialogue | action` 구분, roundId·snapshotId·objectiveProfileRefs·최초 세 Assessment의 불변 참조·policy revision·각 모듈의 추천·충돌한 요구·우선/양보한 이유·종합 근거를 보존한다. action 모드에는 닫힌 공통 후보의 AssessmentSet 참조를 추가한다. dialogue 모드는 최초 세 의견을 종합하며 action용 후보 목록·coverage·SelectionSpec을 요구하지 않는다. 충돌이 없으면 일치로 명시한다. 판단이 다르다는 이유만으로 셋의 동의를 다시 요구하지 않으며, 선언된 대화 종합 규칙 또는 행동 catalog 정책으로 조정할 수 없을 때만 보류한다. 서로 다른 목표의 점수 평균이나 다수결을 기본값으로 가정하지 않고 합의를 외부 증거로 세지 않는다. 대화 3+1도 목표별 추천과 종합 이유를 남기되 토큰 추첨용 SelectionSpec을 만들지는 않는다.

주관적 반대·취향·약속의 우선순위 의견은 종합할 근거이며 단독 veto가 아니다. 현재 권한 위반·필수 근거 누락·객관적인 실행 조건 실패는 Host가 적용한다. 모듈이 보류를 제안했다는 이유만으로 모든 후보를 폐기하지 않는다.

### 의도 유지와 결과 환류

`IntentionRecord`는 목표·출처·수락 근거·우선순위·기한·완료/중단 조건·관련 약속·revision을 가진다. `proposed → adopted → active → completed`와 `suspended/cancelled` 전이를 명시하고 재개·취소에도 원인과 근거를 남긴다. LLM의 제안이나 자기 선언만으로 사용자 약속을 수락·해제하지 않는다. 스스로 시작하는 목표는 허용된 자율성 범위에서 Host가 채택한다. 충돌 시 대안·보류·재협의를 제안할 수 있으며 아트로포스에 단독 최종 권한은 없다.

`Purpose`는 목적·성공 조건, `Understanding`은 근거와 적용 조건을 가진 지속적 이해, `Plan`은 방법·단계, `Intention`은 채택된 수행 의도다. QA 채택 커널에서 이 의미와 철회·결과 연결을 가져오되 제품 schema와 현재 owner에 맞춘다. WorkingState의 목표 메모나 TaskManager의 실행 상태로 이 구분을 대체하지 않는다.

제안 `JudgmentStore`는 회차·판단·예측·이해/계획/의도 채택·전이와 기존 owner의 출처 참조를 저장한다. QA `KernelStore`와 나란히 운영하거나 QA DB를 통째로 복사하지 않는다. 사실 기억·정체성·사용자 지시·권한 원본의 독립 writer를 만들지 않는다. 아직 일반 목표·약속 저장 API가 있다고 가정하지 않으며 기존 LIFE의 단일 행동 intent와 개인의 장기 의도를 구분한다. 다른 통합이 먼저 이 기능을 제공하면 그 소유자를 확장한다.

실제 결과는 같은 원본 outcomeId로 전달하되, 소비자는 당시 objectiveRef에 따라 자기 목표의 결과를 평가한다. 최종안 채택·모듈 합의·같은 수치 보상을 모두의 성공으로 복사하지 않는다. 목표별 결과 평가는 사실 outcome의 원본을 바꾸지 않는다. 적용 키는 `(agentId, scopeId, outcomeId, consumerKind)`이며 `consumerRevision`은 receipt의 메타데이터다. 클로토는 예측 오차, 라케시스는 허용된 선호 학습, 아트로포스는 의도 상태 전이를 각각 수행한다. 각 owner가 변경과 receipt를 자기 저장소의 한 transaction으로 확정하며 같은 키·digest는 기존 결과를 반환하고 다른 digest는 충돌이다. 한 소비자의 완료가 다른 소비자의 완료를 뜻하지 않는다. 중단 뒤 미완료 소비자만 복구하고 내부 의견을 세 개의 독립 경험으로 세지 않는다. 업그레이드나 consumerRevision 변경만으로 적용을 반복하지 않는다. 정정·재해석은 원본을 연결한 명시적 새 사건과 별도의 정책을 요구한다.

## 데이터와 회로 프로필

공식 [다운로드 안내](https://male-cns.janelia.org/download/)의 neuPrint dataset ID는 `male-cns:v1.0`이고 bulk 경로는 `gs://flyem-male-cns/v1.0/connectome-data/flat-connectome/`다. v1.0 배포일은 2026-06-08이며 [릴리스 기록](https://male-cns.janelia.org/release/)과 2026-09-03의 [Google 발표](https://research.google/blog/a-connectomics-milestone-mapping-the-complete-male-fruit-fly-brain/)를 구분한다.

최초 추출은 curated body annotations, neuron-level neurotransmitter predictions, aggregate connection graph를 사용한다. 공식 파일은 각각 `body-annotations-male-cns-v1.0-minconf-0.5.feather`, `body-neurotransmitters-male-cns-v1.0.feather`, `connectome-weights-male-cns-v1.0-minconf-0.5.feather`다. API에는 인증이 필요하며 공개 bulk 경로도 제공된다. 설치 시 전체 EM 영상·형태 메쉬·개별 시냅스 좌표를 필수로 받지 않는다. 실제 추출 전 열 이름·ID 형식·누락·중복·필터 범위를 검사한다.

데이터의 연결 수·전달물질 예측은 계산용 유효 가중치·시정수·학습 규칙과 다르다. 미분류 segment를 뉴런으로 세거나 anatomical synapse 수를 집계 간선 수로 보고하지 않는다. [데이터 제공자](https://www.janelia.org/project-team/flyem/male-cns-connectome)의 CC-BY 4.0 고지와 변형 기록을 유지하고 실행기 코드의 라이선스는 별도로 확인한다.

회로 프로필은 다음 항목이 채워지고 검사되기 전에는 `draft`다. `qualified`는 그 프로필의 선언된 실험을 통과했다는 뜻이며 인간 감정의 재현이나 모든 작업의 효용을 보장하지 않는다.

| 프로필 영역 | 고정할 내용 |
| --- | --- |
| 자료 식별 | dataset·release·원본 URL·객체 버전 또는 export 시점·파일 SHA-256, annotation/NT/edge 각각의 해시 |
| 추출 | 실제 body ID 목록·세포 유형·좌우·ROI, 버섯체 KC/MBON/DAN과 입력·억제·피드백 경계, 포함·제외 이유 |
| 계산 그래프 | 공유 `W0`, 학습 마스크, 전달 부호의 근거와 불확실성, 접촉 수→가중치 변환·단위·범위 |
| 시간과 안정성 | 뉴런 방정식·상수·배경 구동·잡음, `dt`, `K_observe`, `K_probe`, 과활성·침묵·포화 판정 |
| 의미 인터페이스 | encoder·활동 catalog·정규화 버전, 입력 집단, readout 집단·시간창·부호·고정 투영 |
| 학습 | 구획별 modulation·가소성 방향·학습률·범위·eligibility·예측기·만료·정정/재생 규칙 |
| 제품 시간 | scope별 clock·단위·idleGapLimit·느린 상태 감쇠·trace 유효 기간 |
| 재현·이전 | RNG 알고리즘·stream 구분, 수치 허용오차, checkpoint schema와 프로필 이전 정책 |

첫 대상은 MaleCNS의 버섯체 계열이며 정확한 세포 목록은 추출 산출물로 확정한다. 성체 hemibrain/FlyWire의 기능 문헌은 세포 유형을 대조하는 근거로 쓰고 다른 개체의 ID·가중치·checkpoint를 이식하지 않는다. 암컷 pC1d/e–aIPg의 지속 활동 결과를 수컷의 기본 감정 회로로 채택하지 않는다. 필요한 지속성은 먼저 명시적인 제품 상태로 구현하며, 재귀 회로 확대는 해당 수컷 세포·경계·동역학을 확인한 별도 프로필이다.

## 상태 소유권과 공개 범위

| 데이터 | 단일 쓰기 소유자 | 소비 규칙 |
| --- | --- | --- |
| 작성 정체성·명시적 선호·현재 지시·권한 | 기존 AgentStore·ConversationStore·실행 정책 | 판단 모듈과 신경 학습은 원본을 변경하지 못함 |
| ObjectiveProfile 정의·revision·개인별 활성 참조 | Host의 제안 `JudgmentStore` 판단 설정 영역 | 활성화와 commit/finalize에서 정확한 참조 비교; 역사 정의와 회차 참조 보존 |
| 회차·예측·목표·의도/약속의 수락·전이 기록 | Host의 제안 `JudgmentStore` | 원래 지시·수락·실행 receipt를 참조; 아트로포스는 변경 제안만 반환 |
| 사실 기억·세계 사건·관계 원본 | 기존 EngineStore·WorldStore | 출처가 유효한 관측만 신경 입력으로 전달 |
| `h`, 느린 `m`, 개인 `ΔW`, 학습 흔적·예측기 | Host의 제안 `NeuralPreferenceStore` | Python은 계산 결과를 제안하며 직접 저장하지 않음 |
| 대화·LIFE가 읽는 성향 | 기존 성향 합성 owner | `dimensionSource`로 reflection/neural 중 하나 선택; 같은 dimension의 두 생성 결과를 합산하지 않음 |

`dimensionSource`는 새 버전의 owner 설정이다. 기존 LIFE origin 합성 규칙을 몰래 대체하지 않는다. 신경 origin을 선택한 dimension은 그 origin의 기존 모델 해석을 중지하고, 동일 경험이 reflection·neural·승격 stream에서 중복 가산되지 않도록 원본 사건 ID를 보존한다. 명시적 선호를 `p0`에 적용했다면 신경 편향에 같은 항목을 다시 더하지 않도록 경로를 선언한다.

기존 behavior receipt가 신경 출처를 이미 지원한다고 가정하지 않는다. 후속 source 계약에 `NeuralProjectionRef`를 추가해 profile·state/learning revision·허용 dimension·값·원본 경험과 source proof의 digest를 묶는다. Host가 현재성을 확인하고 기존 합성 owner가 값만 투영한다. 원시 신경 데이터와 비밀 원문은 모델 입력에 전달하지 않는다.

상태 키는 `(agentId, scopeId)`다. 개인 공통 scope는 승격을 허용한 경험만 받는다. 비밀이 있는 세계는 신경 상태·가중치·학습 흔적까지 별도 scope에 둔다. 일반 대화는 비밀 scope의 숫자를 바로 읽지 않는다. 세계 간 성장 전달은 출처가 있는 승격 사건이며 동일 원본의 중복 학습을 막는다. 같은 배선을 써도 개인·범위별 가중치와 기록은 공유하지 않는다.

## 사건 관측과 활동별 조회

### 관측은 한 번 확정한다

Host는 `EventKey = (agentId, scopeId, eventId, eventVersion)`로 입력을 식별한다. 같은 key와 같은 payload는 같은 처리 결과를 돌려주며, 같은 key의 다른 payload는 충돌이다. 정정은 원본과 `supersedes`로 연결된 새 사건 버전이다.

`PreparedEvent`는 입력/encoder/profile 해시, source/policy/binding generation, clock·sequence·관측 시점, 기준 state revision·가중치 snapshot, 다음 상태 blob·진단을 묶는다. 준비 계산은 활성 상태를 변경하지 않는다.

```text
received → prepared → observation_committed
               └─ 현재성 실패 → invalidated
```

Host는 현재성·기준 revision을 확인하고 관측 receipt·다음 상태·관측 RNG 진행량을 신경 DB의 한 transaction에서 확정한다. 유효한 입력을 관측했다는 사실은 LLM 응답 성공과 별개다. 조언이 불완전하거나 이후 행동이 취소되어도 유효하게 확정한 관측을 자동으로 되감지 않는다. 준비만 된 작업은 폐기해도 상태·난수가 진행되지 않는다.

뒤늦은 source 정정은 단순 행동 취소와 다르다. 해당 출처에 의존한 신경 투영을 즉시 보류하고 유효 checkpoint와 사건 이력으로 재생하거나 영향을 받은 학습 epoch를 격리한다. 수치 업데이트를 역산해 정확히 지울 수 있다고 가정하지 않는다. 재생 완료 전 부적격 상태를 대화에 투영하지 않는다.

재생을 제공하는 프로필은 보존이 허용된 canonical encoded input·단서·결과 payload, 적용 순번, encoder·프로필과 난수 상태를 checkpoint 이후 이력에 보관한다. 해시만으로 입력을 복원하지 않는다. 삭제 정책이나 데이터 누락으로 재생할 수 없으면 해당 epoch를 격리하고 새 상태에서 시작하며 이전 선호를 복구했다고 표시하지 않는다.

### 후보와 주제는 같은 snapshot에서 조회한다

기본 조회 프로필은 **단서별 임시 계산**이다. 공통 활동 벡터 하나가 모든 대상의 장기 취향을 담는다고 가정하지 않는다. 관측 확정 직후의 동일한 snapshot에 활동·대상 특징을 넣어 학습된 반응을 조회한다.

```text
cue_a = encodeCue(canonicalOption_a, encoderVersion)
q_a, trace_a = probe(W0 + ΔWi, frozenState, cue_a, K_probe, probeNoise_a)
b_a = boundedReadout(q_a)                         # [-1, 1]
```

조회에서는 가소성을 끄고 임시 신경 버퍼만 진행한다. 조회한 분기의 다음 상태를 활성 상태로 채택하지 않는다. 결과는 편향·진단과 잠정 학습 흔적이며, 조회 자체를 경험이나 보상으로 저장하지 않는다. 선택·관련 피드백이 확정된 대상의 흔적만 학습에 사용할 수 있다. 공통 `z`만 사용하는 더 싼 readout은 대상별 학습 재독출 시험을 통과한 별도 프로필로 허용한다.

`CanonicalCueKey`는 `topic` 또는 `option` 구분, catalog/encoder 버전, 정규화한 활동·대상·특징을 포함한다. 대화의 주제와 행동 후보 모두 이 단서 식별자를 가진다. `probeNoise`는 `(scopeRngRoot, 전체 EventKey, CanonicalCueKey, profileRevision, probeStream)`에서 파생한다. `eventVersion`만 같고 `eventId`가 다른 사건은 서로 다른 난수 공간을 쓴다. 후보 배열 순서나 배치 위치를 쓰지 않고, Host의 최종 선택 RNG도 소비하지 않는다. 캐시 key는 위 식별자와 observation receipt·frozen state/weights·cue·readout 해시를 포함한다. 같은 snapshot의 다른 후보를 연속 자극해 순서가 상태를 바꾸는 방식은 사용하지 않는다.

일반 대화는 현재 원문에 등장한 주제와 허용된 활동 catalog 중 관련 단서를 조회하고, 별도 `agentState`에 느린 상태·허용된 대상별 반응을 넣는다. 조회하지 않은 주제는 `unavailable`이며 중립이나 싫어함으로 해석하지 않는다. 후보 생성 후 새 단서가 생기면 동일 snapshot에서 추가 조회한다. 별도 의미 해석 LLM이 필요하면 그 호출도 기록하며 기본 호출 수에 숨기지 않는다.

관측과 조회는 `K_observe`, `K_probe`로 따로 예산을 가진다. 최대 단서 수·동의어 합치기·누락 처리·조회 순서 정책은 프로필에 고정한다. 업무 부하 때문에 단서나 계산 단계를 조용히 줄이지 않는다. 단서 수가 예산을 넘으면 명시적으로 나누어 처리하거나 해당 회차를 무변조로 처리하고 누락 진단을 남긴다.

## 대화·후보·행동 확정

일반 대화는 원래 대화·완결된 내부 의견 원문·구조화된 평가·상태 참조를 Moirai에 전달한다. 기본 LLM 수명은 3판단+1종합이며 모듈 계산과 추가 조회 비용을 별도 기록한다. PR #10의 익명 영어 텍스트 비교는 QA 대조군으로 보존하되 제품 계약은 mechanism별 typed assessment로 전환한다. 상태 수치가 진실·지시·권한이 되지 않으며 특정 자연어 답변 확률도 보장하지 않는다. 실행 효과를 만드는 제안은 아래 행동 확정을 거친다.

명시적 행동은 `3판단 → moirai_prepare → 공통 후보 평가 → 모이라이 조정·선택 정책 → Host 선택 기록 → moirai_finalize` 순서다. 3+2는 최초 LLM 호출의 기본 골격이며 추가 평가까지 다섯 번에 끝난다고 보장하지 않는다. finalize는 prepare의 동일 원문·완결된 의견과 확정된 AssessmentSet·선택 receipt를 받는다. 추가 평가와 재시도·조회·취소·usage를 합산한다. PR #10 capture의 6회 차단선과 예전 QA 출력 제한은 제품 예산으로 복사하지 않는다. D23에 따라 제품 프리셋에 역할별 생성 토큰 예산을 선언하고 실제 Codex/OpenCodex 전송에서 적용 여부를 검증한다. 생성 완료 뒤 자르기는 생성 시간·비용 제한을 대신하지 않는다. `buildDialogueResolution`은 새 종합문을 4,000, 이유문을 1,000 UTF-16 code unit으로 제한하고 선택적 `readoutTruncations`에 원래 길이·상한·원문 해시를 남긴다. 기존 필드가 없는 기록에는 이 필드를 추가하지 않는다. 사용자 원문·정정·권한과 구조화된 행동·근거는 이 문장 자르기 대상이 아니다. 생성 한도로 필수 구조가 불완전하면 보완하거나 보류하며 정상 판단으로 표시하지 않는다.

### 후보의 의미와 효과 범위

World 없는 F2의 채택·약속 변경은 개인용 catalog를 사용하고, 첫 LIFE 행동 모드는 해당 pack의 한정된 활동 catalog로 확장한다. 각 catalog의 schema·가능 효과·확인 방법은 F1/F2에서 정한다. 일반 대화의 약속 수락·취소나 도구·게시·세계 변경도 지속 효과를 만들면 이 행동 계약으로 승격한다. 모듈의 `answer` 분류만으로 채택·실행 검사를 생략하지 않는다. `CanonicalOption`은 `kind`, actor·scope, 대상 ID, 핵심 인자, 전제조건, 허용 효과 범위와 catalog 버전을 포함한다. LIFE 후보에는 pack/step의 `decisionMode` 참조를 추가한다. 개인이 통제하는 Ensemble terminal/binding이 다른 행동을 뜻하면 후보 동일성에도 포함한다. Host가 catalog의 schema·정규화 규칙으로 만든 key가 행동 동일성의 기준이며 LLM이 만든 임의 ID를 신뢰하지 않는다.

LIFE의 기회 제시·개인 선택과 `legacy | moirai` 전환은 [017 D09](017_moirai_module_composition.md#life와-기존-성향-계산의-전환)를 따른다. moirai 모드에서 기존 개인 가중치로 먼저 행동을 뽑거나, 확정 뒤 Ensemble이 다른 개인 행동으로 재선택하지 않는다. 상대의 독립 결정과 세계의 확률적 결과는 개인 행동 선택과 구분해 기록한다.

같은 canonical key의 표면 표현은 합친다. 같은 활동의 서로 다른 방법을 허용하면 먼저 활동 그룹의 확률 질량을 정하고 방법들에 나누는 정책을 기록한다. 음악 표현 두 개와 그림 표현 하나라는 이유로 음악 확률이 두 배가 되어서는 안 된다. 자유문장 전체의 의미 동일성을 일반 파서로 증명하지 않는다. catalog 밖의 제안은 확정 실행 후보에 넣기 전 별도 정규화·검증이 필요하다.

Host는 AssessmentSet의 현재성·평가 완전성·전제조건을 검사한다. 권한·명시적 금지·강제 실행 조건은 후보의 적격성을 결정하고 약속의 우선순위 충돌은 근거를 가진 재계획 대상으로 처리한다. hard/soft 구분은 정책과 원래 지시가 정하며 LLM이 유리한 쪽으로 재분류하지 않는다.

`p0`의 단일 생성자는 모이라이 `ArbitrationPolicy` 안의 `BaselinePolicy`다. 클로토의 미래 성과, 라케시스의 비신경 욕구·명시적 선호, 아트로포스의 연속성 평가를 구분해 읽고, catalog별 조정 규칙으로 기준 분포를 만든다. 신경 편향은 아래 `b`에서만 정량 반영하며 라케시스의 나머지 평가를 누락하지 않는다. 입력 필드·출처·비교 단위·우선 조건·양보·동률·미확인 처리를 policy revision에 고정한다. 개인 catalog의 구체적인 순서·ratio·λ·판단 불가 처리는 정본 D17·D23과 policy revision 2가 소유한다. 선언한 정책이 없는 catalog는 실행하지 않는다.

선택 전 `SelectionSpec`에 snapshot·AssessmentSet·objectiveProfileRefs·ResolutionRecord·policy revision·적격 후보 hash·`p0`·`b`·`λ`를 고정한다. 조정의 논리적 소유권은 모이라이에 있고, Host는 같은 입력과 정책에서 재현되는지 검증하고 정책의 선택 함수를 실행한다. 임의 LLM 확률이나 Host의 별도 가치 기준으로 대체하지 않는다. 선택 전 근거를 보존하고 사후 설명으로 덮지 않는다.

학습된 신경 선호는 `b`에서 한 번만 더한다. `p0`의 점수 필드에는 라케시스의 신경 값이나 이를 풀어 쓴 선호 점수를 넣지 않는다. 후보 생성에 관심이 작용하는 경로와 후보 사이의 정량 선호 반영은 구분해 기록한다. 명시적 선호를 기준 정책에 반영했다면 같은 입력을 별도의 수동 편향으로 재가산하지 않는다. Host는 모이라이 정책이 고정한 적격 후보와 다음 분포로 추출하고 RNG 진행을 원자적으로 기록한다.

```text
logWeight(a) = log(p0(a)) + λ * b_a
p(a) = exp(logWeight(a) - logsumexp(logWeight))
selected = sample(p, hostDecisionRng)
```

후보·`p0`·`λ`·모든 편향은 고정된 해시로 묶는다. `p0`는 유한한 비음수이고 적어도 한 후보에 양수 질량이 있어야 한다. 제외 후보는 0으로 남으며 잘못된 정책을 조용히 균등 분포로 바꾸지 않는다. 후보가 없으면 허용된 보류/확인 경로로 전환하고, 하나면 그 후보로 확정하며 불필요한 선택 난수를 소비하지 않는다. `λ`는 유한한 비음수로 활동별 재량 안에서 선택한다. LLM 점수를 보정된 성공 확률로 쓰지 않는다.

`b∈[-1,1]`이면 두 후보의 odds 변조 한계는 `exp(2λ)`다. 이는 **추출된 후보의 분포**에 관한 성질이다. 뒤의 finalize 거부·권한 변경·실행 실패 때문에 최종 실행 분포는 달라질 수 있다. 후보 포함률, 선택률, finalize 거부율, 실행률과 취소 원인을 따로 기록한다.

### 선택과 실행 가능 상태를 분리한다

```text
selected → finalized_and_validated → dispatchable → dispatched → outcome_pending
   └─ 검토 실패/정정 → invalidated                       └─ 실패/불명 → reconcile
```

`commitDecision`은 JudgmentStore transaction 안에서 snapshot/SelectionSpec의 objectiveProfileRefs가 그 저장소의 현재 활성 참조와 정확히 같은지 검사한 뒤 observation receipt, candidate hash, 확률, 선택 ID, 기준 상태·학습 revision, Host RNG 진행과 `held` outbox intent를 함께 기록한다. 불일치하면 회차를 무효화하고 선택 RNG·outbox를 진행하지 않는다. 이미 확정한 관측을 다시 진행하지 않는다. `held` 행은 실행 owner가 소비할 수 없다.

결정 키는 `(전체 EventKey, decisionSlot)`이며 `decisionSlot`은 Host가 회차 안에서 지정하고 재시도 동안 고정한다. 요청 digest는 관측 참조·정규 후보·AssessmentSet·objectiveProfileRefs·ResolutionRecord·SelectionSpec·probe·기준 정책·변조 설정을 포함한다. 같은 키·digest는 저장한 선택 receipt를 반환하며 RNG·상태·outbox를 다시 진행하지 않는다. 같은 키에 다른 digest가 오면 충돌이다. 새 결정을 정당화하는 정정·전제 변경은 새 사건 버전 또는 새 slot과 명시적 `supersedesDecisionId`로 연결한다.

Moirai finalize는 선택된 후보의 효과 범위 안에서 계획을 구체화한다. Host의 `finalizeDecision`은 finalize 원문·계획 해시, 동일 후보/AssessmentSet, 현재 source/policy/binding·의도 revision과 JudgmentStore의 현재 objectiveProfileRefs를 같은 transaction에서 확인해 `dispatchable` 전환과 outbox release를 원자적으로 기록한다. 목표 참조가 달라졌으면 기존 held 결정을 무효화하고 새 release·RNG 진행을 하지 않는다. 이미 기록한 선택 RNG를 되감거나 같은 결정으로 재추첨하지 않는다. 기존 실행 owner는 released 행만 소비하고 효과 직전 현재 권한·대상·필수 약속 조건을 다시 확인한다. finalize 실패 시 같은 선택으로 재시도하며 새 결과를 얻기 위한 재추첨은 하지 않는다.

finalize 호출 키는 `(decisionId, finalizeAttemptId)`다. 같은 키·payload digest는 저장한 성공/실패 receipt를 반환하고 다른 payload는 충돌로 거부한다. 실패 뒤 재생성이 필요하면 같은 decision의 새 attempt를 사용하며, decision마다 수락된 plan digest와 released intent는 하나뿐이다. 이미 수락된 뒤 다른 계획으로 덮거나 outbox를 다시 release하지 않는다. 응답 유실 뒤에는 저장한 결과를 조회한 다음 재시도 여부를 정한다.

대상·핵심 인자·효과 범위가 바뀌면 같은 ID로 실행하지 않는다. 기존 결정을 무효화하고 이유와 `supersedesDecisionId`가 있는 새 후보 결정을 만든다. 두 개인의 상호작용에서 상대의 수락은 상대 상태의 별도 결정이다. 실행 결과가 불명확하면 기존 owner의 reconcile을 기다리며 성공·실패를 만들어 학습하지 않는다.

## 경험 학습과 지연된 결과

학습은 첫 제품 단면에 포함한다. `W0`는 고정하고 선언된 KC–MBON 등 일부 연결의 개인별 `ΔWi`만 바꾼다. 다음 식은 **초기 학습 계열의 계약**이며 MaleCNS에서 측정된 완성 학습식이라고 주장하지 않는다.

```text
ΔWi_next = projectAllowed(ΔWi_current + η * M_compartment(outcome, prediction) * trace)
```

`M_compartment`는 결과와 당시 예측을 구획별 신호로 바꾼다. 어떤 구획에서 연결이 강화·약화되는지는 세포 유형·실험 근거에 맞춰 프로필로 확정한다. 모든 DAN을 같은 양의 보상이나 모든 시냅스의 강화 신호로 취급하지 않는다. [구획별 학습 실험](https://elifesciences.org/articles/16135)과 [학습 흔적의 일반 틀](https://www.frontiersin.org/journals/neural-circuits/articles/10.3389/fncir.2018.00053/full)을 구분해 참고한다.

`LearningTrace`는 event·probe·활동 key, scope·clock, 원래 state/learning/profile revision, 활성 연결과 흔적, 당시 예측값·예측기 버전, 생성/만료 시점을 보존한다. 즉시 피드백과 지연 피드백의 시간 단위·감쇠 규칙을 선언한다. 생물학적 초 단위 흔적을 제품의 시간 단위 기억으로 그대로 연장하지 않는다. 장기 지연은 명시적인 재생/귀속 정책을 가진 별도 프로필로 다룬다.

`TraceRef`는 불변 trace blob의 ID·digest, 원래 EventKey/observation receipt·CanonicalCueKey, agent·scope·clock·profile·원본 근거 digest를 담는다. 행동은 선택한 후보의 TraceRef를 decision과 같은 transaction에 묶는다. 대화는 아래 DialogueJudgmentRef를 먼저 영속화하고 수락한 최종 응답 entry·request·주제별 TraceRef와 함께 대화 저장소의 한 transaction에 묶는다. trace blob과 판단 참조의 영속화를 먼저 마치며 참조 실패 상태에서 응답을 수락하지 않는다. 두 저장소의 동시 commit을 가정하지 않고, 출처 결합 entry가 확정된 뒤 결과 소비자 inbox가 그 불변 결합을 중복 없이 수신한다.

`DialogueJudgmentRef`는 JudgmentStore의 불변 회차 자료를 가리킨다. roundId·snapshotId·objectiveProfileRefs와 역사 정의, 최초 세 Assessment·dialogue ResolutionRecord·policy revision·request/source digest를 모두 복원할 수 있어야 한다. 응답 수락의 중복 키는 `(agentId, scopeId, requestId, responseSlot)`이며 Host가 responseSlot을 지정하고 재시도 동안 고정한다. payload digest는 응답·DialogueJudgmentRef·TraceRefs·원본 request를 포함한다. 같은 키·digest는 기존 응답 receipt를 반환하고 다른 digest는 충돌이다.

Host의 `acceptDialogue`는 목표 활성 참조 변경과 응답 수락을 같은 짧은 commit barrier로 순서화한다. 현재 objectiveProfileRefs·source·policy·generation을 확인하고, JudgmentStore의 불변 판단 자료 준비와 대화 저장소의 참조 결합을 마친 뒤 barrier를 해제한다. LLM 호출 동안에는 이 barrier를 잡지 않는다. 목표 불일치이면 새 응답 수락·학습 전달을 하지 않는다. 중단 뒤 준비만 된 판단 자료는 미수락으로 남기고, 수락된 응답이 있으면 그 receipt로 결합과 결과 전달만 복구한다. 회차를 재생성하거나 답변을 재발송해 복구했다고 처리하지 않는다.

결과의 대상은 다음 구분을 반드시 포함한다.

```text
OutcomeTarget = DialogueTurnRef | ActionDecisionRef
Outcome = { outcomeId, target, sourceRef, scopeId, clockId, kind,
            observedValue, confidence, supersedesOutcomeId }
```

대화 참조는 확정된 응답 receipt와 거기에 결합된 DialogueJudgmentRef를, 행동 참조는 선택·실행 상태를 가리킨다. 대화에 여러 활동이 언급되면 피드백이 어느 주제의 trace에 대응하는지 확인한다. 연결이 불명확하면 학습을 보류하고 가짜 행동 decision을 만들지 않는다. 생성한 답변은 발화의 증거이며 외부 활동 완료의 증거가 아니다.

예상 결과와 실제 결과를 구분한다. 확인 가능한 활동 결과, 명시적 사용자 평가, 발견·반복·포화 신호는 출처·목적·가중치를 분리한다. 피드백 없음은 부정 보상이 아니고, 반복 선택이나 자기 감정 설명만으로 보상을 올리지 않는다. 조회만 한 미선택 후보의 흔적을 함께 강화하지 않는다.

결과의 목표별 해석은 target의 불변 회차 참조에서 당시 objectiveProfileRefs·Assessment·ResolutionRecord를 읽는다. 현재 목표 설정으로 과거 판단을 다시 작성하지 않는다. 역사 자료가 없으면 해석을 보류한다. 현재 상태로 학습을 적용하는 것은 현재 출처·학습 정책과 목표 프로필 간 적용 호환성을 별도로 확인하며, 허용되지 않은 경우 당시 결과 해석만 보존한다.

`observeOutcome`은 target에서 저장된 TraceRef를 조회한다. 호출자가 임의 trace를 붙이지 못하게 하며 원래 결합의 agent·scope·clock·profile·근거 digest와 일치하는지, 피드백 출처와 학습 정책이 현재 유효한지 확인한 뒤 **현재 가중치**에 한 번 적용한다. 과거 snapshot을 복원해 최근 학습을 덮지 않는다. 신경 장애로 trace가 없는 무변조 결정에는 신경 학습을 적용하지 않으며 `unavailable`로 기록한다. 결과 키는 `(agentId, scopeId, outcomeId)`이고 digest에는 target·값·출처·clock·정정 관계를 포함한다. 같은 키·digest는 저장한 receipt를 반환하며 다른 payload는 충돌이다. outcome receipt·가중치/예측기 갱신·중복 방지 inbox 상태를 한 로컬 transaction으로 확정한다. 명시적 정정은 새 outcomeId와 `supersedesOutcomeId`로 연결하고 영향을 받은 epoch를 재생/격리한다.

학습 적용 순서는 Host의 scope별 증가 순번으로 정한다. 비선형 제한이 있는 업데이트는 순서를 바꾸면 결과가 다를 수 있다. 같은 선언된 순서를 재현하는 것과 모든 순서에서 같은 결과를 요구하는 것을 구분한다.

## 포트·저장·동시성

| 제안 포트 | 입력과 확정 책임 |
| --- | --- |
| `judge` | 공통 snapshot·objectiveRef·허용 근거 → 자기 목표의 완결된 의견·전체 추천·계산 참조; 다른 모듈 출력과 직접 효과 없음 |
| `projectConsequences` | 개인에게 공개된 도메인 상태·후보·가정 → 예상 효과·모르는 조건·근거; 실제 세계 쓰기 없음 |
| `prepareEvent` | EventKey·source/clock·기준 snapshot → PreparedEvent; 활성 상태 쓰기 없음 |
| `commitObservation` | 준비 해시·예상 revision·현재 source → 관측 receipt·다음 상태·관측 RNG를 한 번 저장 |
| `probeOptions` | 관측 receipt·동일 snapshot·정규화한 단서 → 후보별 편향·잠정 trace; 활성 상태/RNG 쓰기 없음 |
| `projectState` | 허용 scope·dimension·주제 probe → 대화/LIFE용 값과 Host 전용 proof |
| `evaluateOptions` | 동일 snapshot·objectiveRef·canonical 후보 → 자기 목표의 추천·이득/손실·전문 근거·가용성; 저장/효과 없음 |
| `resolveObjectives` | mode·snapshot·objectiveProfileRefs·최초 세 Assessment·종합 정책 → ResolutionRecord; action에만 AssessmentSet·적격 후보를 요구하고 SelectionSpec 반환. dialogue는 SelectionSpec 없음; 상태/RNG 쓰기 없음 |
| `acceptDialogue` | dialogue 판단 참조·원문·응답·TraceRefs·중복 키 → 현재 목표/근거 검사와 불변 판단 준비 후 대화 owner가 응답·참조를 원자 기록; 저장소 간 중단은 receipt 대조로 복구 |
| `assembleAssessments / closeCandidateSet` | candidateSetHash·모듈별 평가·coverage·누적 예산 → 검증된 불변 AssessmentSet; 누락·다른 revision·확정 뒤 추가 거부 |
| `commitDecision` | 동일 receipt·candidate/assessment/objective/probe/policy·SelectionSpec hash → 정책의 추출 함수·RNG·결정 receipt·held outbox 원자 기록 |
| `finalizeDecision` | finalize 근거·계획·동일 후보·현재 source → 검증 뒤 released outbox |
| `observeOutcome` | 두 종류 중 하나의 target·source·trace·중복 키 → 현재 학습 상태에 한 번 반영 |
| `checkpoint / restore` | 회로·encoder·상태·학습·clock·RNG·inbox/outbox의 호환 snapshot |

Host의 제안 JudgmentStore는 회차·모듈 평가·의도 전이를 소유한다. 신경 어댑터를 교체하거나 끈 회차에도 코어 수명은 유지한다. `state/neural-preferences.sqlite`에는 신경 사건·상태 참조·조회 receipt·학습 inbox를 둔다. 선택 receipt·Host 결정 RNG·held/released outbox의 단일 writer는 JudgmentStore이며 `commitDecision`은 그 로컬 transaction이다. 신경 관측과 trace blob은 먼저 영속화하고 코어가 불변 참조를 기록한다. 두 저장소를 가로지르는 transaction은 가정하지 않는다. 큰 상태 blob은 임시 파일 기록·동기화·원자적 이름 변경·해시 확인을 마친 뒤 DB가 참조한다. DB 확정 전에 중단된 blob은 재시작 시 미참조 파일로 구분한다. DB와 파일을 하나의 분산 transaction으로 간주하지 않는다. 역사 receipt가 참조하는 blob을 보존 정책 없이 삭제하지 않는다.

WorldStore와 JudgmentStore 사이에는 하나의 transaction이 없다. 기존 LIFE step에 decisionId를 보존하고 outbox/inbox와 기존 prepare/reconcile로 중복을 막는다. 실제 효과가 중복되지 않는지는 해당 effect owner의 시험으로 입증한다.

checkpoint는 기존 설치/checkpoint owner가 조정한다. 대상 scope의 신규 회차·dispatch·모든 상태 writer를 막고, 진행 중 DB 쓰기를 마친 뒤 공통 증가 순번을 고정한다. 이 동안 관측·학습·의도·결정·RNG는 진행하지 않는다. 원문 저장소·WorldStore의 참조 snapshot, 신경 DB와 blob, JudgmentStore를 차례로 저장하고 마지막에 `CheckpointManifest { checkpointId, schemaVersions, perScopeSequence, storeRevisions, profileHashes, blobDigests, pendingInboxOutbox }`를 확정한다. 대기 중 외부 결과는 inbox에서 보존하고 미확인 효과는 reconcile 대상으로 남긴다. manifest가 확정되기 전 파일 묶음은 복원 가능한 checkpoint가 아니다.

복원 시 서비스 쓰기를 막은 채 동일 manifest의 저장소·blob·원문 참조를 모두 대조한다. 서로 다른 checkpoint의 DB나 누락된 trace를 섞으면 거부하고 원본을 보존한다. 호환 검사와 pending inbox/outbox 및 실제 효과 reconcile이 끝난 뒤 회차를 재개한다. 실패한 다중 저장소 복원을 부분 성공으로 활성화하지 않는다. 실제 데이터 보존·오프라인 복원 경계는 기존 설치/checkpoint owner를 확장하며 별도 복원기를 만들지 않는다.

한 `(agent, scope)`의 관측·결정 준비·LLM 종합 또는 finalize가 끝날 때까지 회차 lease로 순서를 유지한다. 다른 일반 사건·outcome의 신경·의도·예측 상태 쓰기는 큐에서 기다린다. source 정정·권한 회수·현재 약속의 취소/변경·목표 프로필 활성 참조 변경은 긴 회차 lease를 기다리지 않고 관련 회차를 무효화한다. 목표 참조 변경은 JudgmentStore의 짧은 쓰기/응답 수락 barrier에서 순서화한다. `commitDecision`과 `finalizeDecision` 모두 snapshot의 의도 revision·현재 generation·JudgmentStore의 현재 objectiveProfileRefs와 정확한 일치를 검사한다. `acceptDialogue`도 같은 목표 현재성 조건을 확인한다. lease 만료·취소 후 늦은 응답은 fencing token으로 거부한다. 외부 행동 결과를 기다리는 동안 회차 lease를 잡아두지 않는다.

다른 scope·개인은 독립적으로 준비할 수 있고 DB commit은 Host가 직렬화한다. `dispatchable` 이후의 정상적인 개인 상태 변화만으로 과거 선택을 다시 추첨하지 않는다. 효과 직전에는 현재 권한·근거·대상 조건을 재검증한다. 공동 세계 변경은 기존 world revision과 확정 경계를 따른다. 긴 LLM 호출 동안 전체 World 쓰기를 막는 전역 잠금을 새로 도입하지 않는다.

현실 공통 scope와 LIFE scope는 각각의 `clockId`·단위·마지막 적용 시점·증가 순번을 가진다. 시계 역행은 오류다. 느린 `m`은 해당 시계 경과분을 한 번 감쇠한다. 유휴가 프로필의 한계를 넘으면 빠른 전위·발화·지연 버퍼를 휴지 상태로 초기화하고 학습 가중치는 유지한다. 재시작 자체를 초기화 사유로 삼지 않는다. 호환 프로필 없는 checkpoint는 격리하고 원본을 보존한다.

8명은 정체성 수이며 실제 상태 수는 공통 scope와 활성 세계 scope의 합이다. Python 상주 계산기는 불변 그래프를 공유하고 준비된 요청만 배치한다. 학습 마스크·개인 가중치·상태·각 RNG stream은 분리한다. 단일 Python 프로세스가 종료되면 여러 개인의 신경 계산이 함께 멈출 수 있다. 논리적 개인 격리가 프로세스 장애 격리까지 보장하지는 않는다.

## 실패와 검증할 행동

| 실패 지점 | 허용된 처리 |
| --- | --- |
| 신경 계산 시간 초과·NaN·발화 폭주·포화 | 아직 준비만 된 상태를 폐기, 명시적 무변조 경로. 이미 확정된 관측은 유지하며 원래 receipt와 연결 |
| 신경 조회 실패·예산 초과 | 후보의 일부 실패를 0 편향으로 숨기지 않음. 해당 결정 전체의 변조를 끄거나 선언된 재처리 정책 사용 |
| 모듈 의견 불완전·미수신·구조 파싱 실패 | 종합 중지. 신경 장애의 무변조 경로와 구분 |
| 공통 후보 평가 누락·다른 snapshot·해시 불일치 | 선택 중지·유효 평가 재사용 후 부족분 보완 또는 보류 |
| BaselinePolicy 미지원·의도 수락 근거 누락 | 후보 확정 중지. 기본값이나 LLM 합의로 우회하지 않음 |
| source/권한/lease 무효화 | 해당 회차·준비/held 효과를 무효화. `p0`로 우회 실행 금지 |
| finalize 실패 | held 상태 유지·같은 선택으로 제한된 재시도 또는 취소; 실행 없음 |
| 효과 전송 결과 불명 | reconcile; 영수증 확인 전 성공/실패 보상 없음 |
| 학습 근거 철회 | 관련 투영 보류, checkpoint 재생 또는 epoch 격리; 감사 기록 유지 |

신경 계산 장애에만 적용하는 무변조 모드는 자연어 경로에서는 해당 회차의 신경 자료를 생략하고, 행동 경로에서는 동일 적격 후보와 검증된 `p0`로 선택한다. 동일 요청의 확정 결과를 보존하고 늦은 Python 결과를 덧붙이지 않는다. 회차/큐/재시도/저장/진단 공간의 한도는 설정으로 관리한다.

관측 자체가 실패한 무변조 결정은 실제 관측 receipt 대신 `ObservationUnavailableRef(EventKey, failureReceiptId)`를 저장한다. 이 참조도 source·권한 검사를 요구하지만 신경 상태가 진행됐다는 뜻은 아니다. 결정 키·단일 추출·finalize/효과 계약은 그대로 적용하고 TraceRef는 비워 둔다.

최초 측정은 CPU 부분회로에서 수행한다. 신경 추가 지연 p95 100ms·deadline 250ms, 전체 평균 2건/초와 8건 동시 도착은 초안의 **미측정 목표**다. 활동별 조회 비용과 가소성 비용까지 포함해 재산정하며 이 수치를 LLM 출력·추론 제한으로 쓰지 않는다. API/LLM 시간, IPC, 관측, 단서별 조회, 큐, 저장을 분리 측정한다. GPU 지원은 동일 프로필·부하에서 실제 RAM/VRAM·처리량·확률/상태 오차를 측정한 뒤 결정한다.

## 구현 단위와 완료 증거

후속 변경 순서·파일 후보·의존 관계는 [017의 F1–F4 지도](017_moirai_module_composition.md#후속-설계와-구현의-의존-순서) 하나로 관리한다. F1에서 원본 참조·채택·판단의 계약을 정하고, F2에서 World 없는 한 개인의 세 메커니즘·Codex 대화·학습·결과·복구를 연결한다. F2는 대화 중 채택·약속 변경에 필요한 공통 후보·선택·finalize도 포함한다. F3는 이를 LIFE 행동 catalog로 확장하고 기회/행동을 분리하며, F4는 성장 투영·공개 범위·운영 전환이다. 개인정보·정정·중복 반영 방지는 F1/F2부터 적용한다.

F1의 공통 계약은 제품 회차 조정기에 아직 연결되지 않았다. `session-app.ts`와 제안 `cognition/install.ts`가 Host 조정기·Codex 역할 thread를 조립하고 `cognition/conversation.ts`가 `SessionPort`에 하나의 논리 대화 수명을 제공한다. 회차 ledger·채택·실행 권한은 어댑터 내부로 숨기지 않는다. `SessionEngine.kind`의 Codex 선택, TaskManager RPC와 OpenCodex 프로바이더 owner는 D22에 따라 유지한다. F2에서 역할 격리·도구 권한·출력 예산의 실제 전송과 재개를 검증한다.

ObjectiveProfile·ResolutionRecord·SelectionSpec·DialogueJudgmentRef는 F1에서 의미·생성/직렬화/복원 계약을 정하고 F2의 판단 입력·후보 평가·종합·캐시·선택 기록·결과 소비자에 연결한다. 실제 도입 때 이전 schema와의 변환·누락 처리도 함께 검증한다.

내부 조언은 사용자 발송·직접 효과 실행 권한을 갖지 않고, 최종 응답만 DurableRuntime의 출처 확인·entry 저장·settlement 경계로 보낸다. 필요한 근거 조회는 Host의 허용된 조회 계약으로 수행한다. 필수 원문·정정·권한과 구조화된 판단이 실제 Codex 전송에 남는지 검사한다. 설명문의 출력 예산·잘림 표시도 전송과 저장에서 각각 확인한다. Codex thread/turn·nativeEpoch와 Lina round/request 식별자를 구분하고, 실제 재개·취소·늦은 응답 분리를 검증한다.

검증은 개발자가 선언한 정답 감정을 맞히는 시험으로 끝내지 않는다.

| 수용 질문 | 필요한 개입과 관찰 |
| --- | --- |
| 각 모듈이 자기 목표로 판단하는가 | 같은 사실·후보에서 미래 성과/선호/약속이 충돌·일치하는 사례, 목표 프로필 변경과 입력 누락을 대조. 목표별 추천·조정 이유가 남고 목표 변경에 기존 평가·캐시가 무효화되는지 확인 |
| 세 판단이 서로 다른 원인에 반응하는가 | 공통 입력을 고정해 경험/신경 가중치, 외부 근거, 수락된 약속을 각각 개입. 라케시스 평가, 클로토 예측, 아트로포스 충돌 판단의 예상 변화를 확인하고 사실·권한은 임의로 변하지 않는지 검사 |
| 프롬프트 분리보다 효용이 있는가 | 동일 LLM·입력·기억·총예산에서 동일 목표 3+1과 고유 목표 3+1 비교. 고유 목표를 유지한 프롬프트 3+1과 전체 구조, 예측/선호/의도 메커니즘을 하나씩 끈 조건 비교. 확인된 결과·목표 지속·선호 수정·비용으로 판정하며 자기 설명은 점수가 아님 |
| 공통 후보 비교가 성립하는가 | 새 후보·평가 누락·다른 snapshot·예산 소진·p0에 선호 재주입·약속 변경의 무효화. 무평가 추첨과 이중 가산은 0건 |
| 활동별 경험이 가중치에 남았는가 | 같은 초기 두 개인에 상반된 결과, 외부 선호표·readout·`p0` 고정. 중립 사건에서 같은 활동 단서 조회, 빠른 상태 초기화·재시작·새 시드 뒤의 선택 경향 |
| 회로 내부 학습이 원인인가 | `ΔW` 교환/차단, trace-결과 연결 섞기, 무보상·반대 결과, 외부 readout 학습만 있는 조건과 비교 |
| 표현이나 후보 수가 원인인가 | 동의 표현·순서·중복 후보, 동일 활동 그룹의 방법 수 변경, catalog 밖 후보 검증 |
| 목표 변경·대화 복구가 보존되는가 | 평가 뒤 commit 직전/선택 뒤 finalize 직전 목표 활성 참조 변경 시 무효화·추가 RNG/release 없음. 대화 판단 저장 뒤 응답 결합 전/응답 수락 뒤 inbox 전달 전 중단을 각각 복원하고, 목표 revision 변경 뒤 피드백은 당시 목표·판단으로 귀속. dialogue에 action SelectionSpec·공통 후보 coverage를 요구하지 않음 |
| 목표 충돌과 선택 책임이 보존되는가 | 모듈 추천이 다른 채 종합 가능, 타 모듈의 목표로 평가 덮기 거부, ResolutionRecord/SelectionSpec 변경 감지, Host 임의 우선순위·신경 이중 가산·불일치 재추첨 없음 |
| 인지와 실제 효과가 보존되는가 | 원문·완결된 의견·평가 출처 보존, 상태 변경의 의미상 선택 변화, held 상태의 실행 0, 효과 범위 변경 거부, selected/finalized/executed 분포 구분 |
| 정상 복구인가 | 각 blob/DB/선택/finalize/dispatch/outcome 경계 중단, consumerRevision 변경 후 중복 결과, source 철회·lease 만료·늦은 응답, checkpoint 도중 중단·다른 DB 조합·trace 누락 거부와 같은 순번의 재현 |
| 일반 학습 모델보다 어떤 가치가 있는가 | 같은 입력·기억·느린 상태·학습 신호·조정 예산의 일반 순환망/밴딧·생물 원리 모형·재배선·MaleCNS 비교. 품질·선호 유지/수정·간섭·조정량·비용을 분리 |

후속 실행 검사는 먼저 해당 core/runtime의 신경 계약 테스트와 실제 source/built SDK 전송 검사를 추가하고, 영향을 받는 기존 테스트를 실행한다. 예를 들어 `bun test packages/lina-core/test/neural-preference.test.ts packages/lina-runtime/test/neural-preference.test.ts`는 **추가할 테스트의 실행 명령**이며 현재 파일이나 통과 결과가 아니다. 문서 변경인 이번 PR은 `bun run ci:validate`, 링크/참조/계약 대조와 `git diff --check`로 검증한다.

## 남은 결정과 검증 범위

이 문서의 세 판단 구조는 새 설계이며 이전 신경 모듈 초안의 Oracle 검토 결과를 승계하지 않는다. 문서 검토와 CI는 실제 판단 효용·회로 학습·운영 성능의 증거가 아니다.

최초 구현 전에 확정할 산출물은 실제 세포 목록·경계 조건·전달 부호, encoder의 특징 공간과 읽기 방향, 구획별 학습 상수·예측기, artifact 배포 방식, catalog별 BaselinePolicy와 의도 수락/전이 규칙이다. 이번 단계는 임의 수치로 그 빈칸을 채우지 않고 필요한 입력·검사·실패 동작을 고정한다. 첫 회로 프로필의 대상별 학습·재독출이 실패하면 원인을 입력·회로·readout·학습으로 나눠 수정하며, 말투 변화나 문서 CI 통과로 학습 성공을 대체하지 않는다.
