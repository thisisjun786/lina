# 모이라이 코어의 판단·선택·학습·실행 계약

상태: 2026-09-11 설계 제안. [015 모이라이 에이전트 코어 설계](015_neural_preference_engine_research.md)의 세 판단 모듈을 입력·계산·결과·학습 계약으로 구체화한다. 타입·포트·파일은 제안이며 현재 Senpi QA가 이 구조를 구현했다는 뜻이 아니다. 015는 제품 목표·구조·근거를, 이 문서는 회차·판단·선택·영속화·수용 조건을 소유한다.

모이라이는 한 개인의 전망·계획 판단, 경험·가치 판단, 의도·연속성 판단을 종합한다. 라케시스의 학습된 선호는 Google Research가 소개한 **MaleCNS v1.0** 부분회로로 구현한다. 개인 대화·학습·LIFE 선택·재시작·8명 운영을 연결하며 비교 실험은 구현을 선택하는 증거로 사용한다.

## 결정과 현재 연결 지점

기존 코드 연결 지점은 `522101ff99e356b0ea6d27b4ea03ec7e599ee4b3`, 인지 확장 기준은 PR #10의 `5b22aee53f9f7c01cc508289099f662aed613140`이다. **이 설계의 선택된 대화·인지 백엔드는 새 Senpi SDK**다. PR #10에는 Senpi SDK 생성·대화·도구·취소·재개 검증과 영어 인지 프롬프트가 들어 있다. 같은 PR에 남은 ‘실행 엔진 재검토’ 문구보다 이번 Senpi 선택을 설계 기준으로 우선한다. 기존 dev의 Codex 코드와 정책은 전환 전 연결 지점을 찾는 근거이며, 이 문서가 Senpi 제품 통합 완료를 증명하지는 않는다.

| 현재 소유자 | 확인한 책임 | 제안하는 변경 |
| --- | --- | --- |
| [개인 성장 생성](../../../packages/lina-runtime/src/persona/native-growth.ts#L161) → AgentStore | 허용된 경험의 모델 해석을 성향 값으로 저장 | 지정 dimension의 생성자를 기존 해석 또는 신경 투영 중 하나로 선택 |
| [성향 합성](../../../packages/lina-core/src/agents/persona.ts#L53) → 대화·LIFE | 정체성·lock을 지키며 허용된 현재 성향 제공 | 새 신경 출처의 유효성·revision을 확인한 투영만 소비 |
| [Moirai 입력 조립](https://github.com/thisisjun786/lina/blob/5b22aee53f9f7c01cc508289099f662aed613140/scripts/qa/senpi-sdk/moirai-runner.ts#L145) | 원래 대화와 완결된 익명 조언 원문 | 원문을 보존하는 typed assessment, 공통 후보 평가, 행동 prepare/finalize 모드 |
| [제품 세션 조립](../../../packages/lina-runtime/src/session-app.ts#L500)·[SessionPort](../../../packages/lina-runtime/src/sdk-port.ts#L27) | 기존 실행 세션을 DurableRuntime에 연결 | Senpi 어댑터와 제품 회차 조정기가 내부 조언·종합을 수행하고 하나의 논리 대화 포트만 외부에 노출 |
| [대화 기록·정착](../../../packages/lina-runtime/src/runtime.ts#L182)·[출처 결합 저장](../../../packages/lina-core/src/store.ts#L300) | 응답 entry와 request의 출처 연결·settlement | 수락한 최종 응답과 학습 TraceRef 결합을 원자적으로 기록 |
| [LIFE director](../../../packages/lina-runtime/src/life/director.ts#L82)·[영속화](../../../packages/lina-core/src/world/autonomy-persistence.ts#L513) | actor·target·reflection, prepare/reconcile | 확정 결정 참조와 실행 가능 상태를 소비; 순수 재계산에서 신경 상태를 진행하지 않음 |

새 경계가 필요한 이유는 계산량·실행 언어와 상태 수명 때문이다. Host가 저장·현재성·선택·효과를 소유하고, 별도 Python 계산기는 불변 snapshot을 받아 수치 결과만 반환한다. 채널·Memory가 Python이나 실행 SDK를 직접 호출하지 않는다. 기존 성장 함수에 시뮬레이터와 DB 쓰기를 함께 넣는 안은 재시도 시 학습·추출이 중복될 수 있어 채택하지 않는다.

아래 명세는 기존 공개 API를 즉시 바꾸지 않는다. 후속 구현은 타입 버전, source proof, 저장 복구와 각 소비자를 같은 단위에서 변경한다.

Senpi 연결은 PR #10의 [세션 생성](https://github.com/thisisjun786/lina/blob/5b22aee53f9f7c01cc508289099f662aed613140/scripts/qa/senpi-sdk/live-session.ts#L72)과 [잠근 의존성](https://github.com/thisisjun786/lina/blob/5b22aee53f9f7c01cc508289099f662aed613140/scripts/qa/senpi-sdk/package.json#L13)을 출발점으로 한다. 확인한 버전은 `@code-yeongyu/senpi@2026.9.10-2`이며 `createAgentSession`, `ModelRuntime`, `SessionManager`를 제품 어댑터 안에서 사용한다. QA의 capture provider·임시 경로·고정 모델·도구 권한을 제품에 복사하지 않는다. Senpi 세션의 수명·응답·usage를 Host 포트에 대응시키고 원래 request·source 연결은 Host가 소유한다. 신경 계산기는 SDK와 독립된 포트 뒤에 둔다.

## 세 판단 모듈의 계약

분리 기준은 각 모듈이 소비하는 상태, 수행하는 계산, 검증할 결과다. 역할 프롬프트만 바꾸는 안은 경험·예측·약속이 어느 계산을 바꿨는지 분리하기 어려워 제품 목표 구조로 채택하지 않는다. 세 개의 기억·인격 저장소를 만드는 안도 한 개인의 정체성과 정정을 중복 관리하게 된다.

의존 방향은 `Host → 판단 포트 → 허용된 기억/목표/계산 포트`다. Senpi는 LLM 호출 어댑터, Python은 라케시스의 수치 계산 어댑터다. 모듈은 서로의 내부 상태를 수정하지 않는다. 기존 QA의 `proposals: string[]`에서 아래 버전 있는 판단 계약으로 옮기는 변경은 제품 Senpi 연결과 소비자 검증을 함께 요구한다.

| 판단 모듈 | 입력과 계산 | 출력과 결과 확인 |
| --- | --- | --- |
| 클로토 `prospect` | 목적·현재 세계·근거에서 LLM이 전체 행동과 후속 단계를 제안. 코드가 의존 관계·시간·자원 조건을 검사하고 허용된 검증 결과를 예상에 연결 | `Forecast`: 후보 key, 예상 결과·범위·기한·비용, 근거와 가정, 확인 방법. 실제 결과와 비교한 오차를 다음 계획 입력으로 전달 |
| 라케시스 `value` | 출처 있는 경험과 현재 동기·정서 상태를 조회. LLM이 단서를 해석하고 개인의 고정 snapshot에서 MaleCNS 반응을 계산 | `ValueAssessment`: 경험 참조, cue·probe·trace 참조, 제한된 편향과 가용성. 확인된 피드백이 귀속된 개인 가중치만 갱신 |
| 아트로포스 `continuity` | 현재 지시·목표·약속·자기모델·완료/중단 조건을 조회. 상태 전이와 자원 충돌은 코드로 검사하고 모호한 변경은 LLM이 해석 | `ContinuityAssessment`: 의도·약속 참조, 충돌 이유·심각도·대안, 변경 제안. owner의 수락과 실제 완료 결과로 상태 전이 확인 |

필수 현재 원문·정정·권한·source snapshot은 셋 모두 같다. 전문 근거에는 출처와 실제 소비한 revision을 기록한다. 각 모듈은 전체 행동 대안을 제안할 수 있고 최초 판단은 다른 모듈 출력을 보지 않고 병렬 생성한다. 라케시스만 사실을 확인하거나 아트로포스만 권한을 아는 구조로 만들지 않는다.

### 입력과 결과의 식별

```text
JudgmentSnapshot = { schemaVersion, roundId, agentId, scopeId, sourceRefs,
  instructionRevision, policyRevision, identityRevision, intentionRevision,
  observationRef, frozenNeuralRef, clockId, sequence, bindingGeneration }
Assessment = { schemaVersion, moduleKind, snapshotId, inputDigest,
  mechanismRevision, completeText, evidenceRefs, proposedOptions,
  forecasts | values | continuity, diagnostics }
```

위 표기는 필수 영역을 나타내며 `forecasts | values | continuity`는 moduleKind에 따른 구분 타입이다. `completeText`는 잘리지 않은 모듈 의견이다. 구조화된 결과를 만들 수 없으면 텍스트만으로 정상 판단을 대신하지 않는다. 모델이 주장한 계산 결과·참조는 Host가 실제 도구/계산 receipt와 대조한다. 모델·세션 ID는 진단 자료이며 판단의 권위나 별도 인격이 아니다.

Forecast의 결과·비용·기한은 각각 `Claim { claimId, kind: observed | assumption | prediction, value, unit, sourceRefs, assumptionRefs, verificationStatus, horizon }`으로 표현한다. 직접 관측한 값과 예상값을 구분하고 출처는 해당 claim의 대상·범위·시점과 일치해야 한다. 유효한 receipt 하나가 문서 전체의 사실성을 보장하지 않는다. BaselinePolicy는 catalog가 허용한 claim 종류·단위·검증 상태만 읽고, 예상값은 가정·불확실성 처리 규칙을 적용한다. LLM이 붙인 확신 수치만으로 검증 상태를 올리지 않는다.

학습된 관심은 원문 주제와 허용된 활동 catalog를 같은 snapshot에서 조회해 후보 생성 전에도 공급한다. 어떤 후보가 관심 때문에 제안됐는지 기록한다. 최초 세 의견은 아직 서로 다른 후보를 다룰 수 있으므로 바로 평균·투표·추첨하지 않는다.

### 같은 후보를 비교하는 단계

`moirai_prepare`는 세 의견과 근거에서 공통 `CanonicalOption` 집합을 제안한다. Host가 정규화한 뒤 각 모듈의 `evaluateOptions(snapshot, candidates)`를 호출한다. 클로토는 후보별 예측·계획 조건, 라케시스는 단서별 반응, 아트로포스는 의도·약속 충돌을 채운다. 후보 key·snapshot·mechanism revision이 같은 기존 결과는 재사용한다.

이미 계산 가능한 후보는 코드와 신경 조회로 평가한다. 새 후보의 예측·의미 해석이 부족하면 해당 모듈의 추가 LLM 호출과 비용을 기록한다. 최초 의견의 독립성과 이 후속 평가는 구분한다. 후속 평가에서도 다른 모듈의 결론은 입력하지 않는다. 각 `optionKey × moduleKind`에 유효 평가 또는 정책이 허용한 명시적 `unavailable` 사유가 있어야 한다. 비교할 수 없는 후보를 조용히 탈락시키거나 0점으로 취급하지 않는다. 필요한 평가가 없으면 회차를 보류한다.

새 근거가 공통 세계 사실을 바꾸면 snapshot을 무효화하고 새 회차에서 셋 모두에게 공급한다. 새 후보·효과 범위가 추가되면 candidate revision을 올려 해당 평가를 완료한 뒤 선택한다. 평가 횟수·시간·모델·수치 계산 예산과 실패를 기록하며 예산 부족을 가짜 완전성으로 숨기지 않는다.

Host는 `candidateLimit`, `maxEvaluationGenerations`, `maxAdditionalCalls`, 회차 deadline을 먼저 고정한다. 이 예산은 후보 revision이나 무효화 후 후속 회차에서도 같은 원래 요청/자율 활동 슬롯에 누적한다. `closeCandidateSet`이 후보 hash와 coverage를 확정한 뒤에는 새 후보를 같은 선택에 끼워 넣지 못한다. 확정 뒤 제안은 후속 회차에 남기고 실제 전제를 바꾸는 근거만 현재 회차를 무효화한다. 예산 소진 시 `deferred`로 끝내며 선택 RNG·outbox는 진행하지 않는다. 이미 선택한 뒤의 실패라면 기존 `held` 결정을 유지하거나 취소한다.

`AssessmentSet`은 snapshotId·candidateSetHash·모듈별 평가 해시·누락 사유를 묶는다. 모이라이는 근거·예상·선호·약속 충돌을 구분해 종합안을 제안하고 Host의 버전 있는 기준 정책이 적격 후보와 `p0`를 계산한다. 서로 다른 종류의 점수를 평균내거나 합의를 외부 증거로 세지 않는다.

### 의도 유지와 결과 환류

`IntentionRecord`는 목표·출처·수락 근거·우선순위·기한·완료/중단 조건·관련 약속·revision을 가진다. `proposed → adopted → active → completed`와 `suspended/cancelled` 전이를 명시하고 재개·취소에도 원인과 근거를 남긴다. LLM의 제안이나 자기 선언만으로 사용자 약속을 수락·해제하지 않는다. 스스로 시작하는 목표는 허용된 자율성 범위에서 Host가 채택한다. 충돌 시 대안·보류·재협의를 제안할 수 있으며 아트로포스에 단독 최종 권한은 없다.

제안 `AgentCoreStore`는 회차·판단·예측·의도 전이와 기존 owner의 출처 참조를 저장한다. 사실 기억·정체성·사용자 지시·권한 원본의 독립 writer를 만들지 않는다. 아직 일반 목표·약속 저장 API가 있다고 가정하지 않으며 기존 LIFE의 단일 행동 intent와 개인의 장기 의도를 구분한다. 다른 통합이 먼저 이 기능을 제공하면 그 소유자를 확장한다.

실제 결과는 같은 원본 outcomeId로 전달한다. 적용 키는 `(agentId, scopeId, outcomeId, consumerKind)`이며 `consumerRevision`은 receipt의 메타데이터다. 클로토는 예측 오차, 라케시스는 허용된 선호 학습, 아트로포스는 의도 상태 전이를 각각 수행한다. 각 owner가 변경과 receipt를 자기 저장소의 한 transaction으로 확정하며 같은 키·digest는 기존 결과를 반환하고 다른 digest는 충돌이다. 한 소비자의 완료가 다른 소비자의 완료를 뜻하지 않는다. 중단 뒤 미완료 소비자만 복구하고 내부 의견을 세 개의 독립 경험으로 세지 않는다. 업그레이드나 consumerRevision 변경만으로 적용을 반복하지 않는다. 정정·재해석은 원본을 연결한 명시적 새 사건과 별도의 정책을 요구한다.

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
| 회차·예측·목표·의도/약속의 수락·전이 기록 | Host의 제안 `AgentCoreStore` | 원래 지시·수락·실행 receipt를 참조; 아트로포스는 변경 제안만 반환 |
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

명시적 행동은 `3판단 → moirai_prepare → 공통 후보 평가 → Host 선택 → moirai_finalize` 순서다. 3+2는 최초 LLM 호출의 기본 골격이며 추가 평가까지 다섯 번에 끝난다고 보장하지 않는다. finalize는 prepare의 동일 원문·완결된 의견과 확정된 AssessmentSet·선택 receipt를 받는다. 추가 평가와 재시도·조회·취소·usage를 합산한다. PR #10 capture의 6회 차단선과 예전 QA 출력 제한은 제품 예산으로 복사하지 않는다. 제품 출력 원문을 자르거나 임의 출력 토큰 상한을 추가하지 않는다.

### 후보의 의미와 효과 범위

첫 행동 모드는 해당 LIFE pack이 선언한 한정된 활동 catalog를 사용한다. `CanonicalOption`은 `kind`, actor·scope, 대상 ID, 핵심 인자, 전제조건, 허용 효과 범위와 버전을 포함한다. Host가 catalog의 schema·정규화 규칙으로 만든 key가 행동 동일성의 기준이며 LLM이 만든 임의 ID를 신뢰하지 않는다.

같은 canonical key의 표면 표현은 합친다. 같은 활동의 서로 다른 방법을 허용하면 먼저 활동 그룹의 확률 질량을 정하고 방법들에 나누는 정책을 기록한다. 음악 표현 두 개와 그림 표현 하나라는 이유로 음악 확률이 두 배가 되어서는 안 된다. 자유문장 전체의 의미 동일성을 일반 파서로 증명하지 않는다. catalog 밖의 제안은 확정 실행 후보에 넣기 전 별도 정규화·검증이 필요하다.

Host는 AssessmentSet의 현재성·평가 완전성·전제조건을 검사한다. 권한·명시적 금지·강제 실행 조건은 후보의 적격성을 결정하고 약속의 우선순위 충돌은 근거를 가진 재계획 대상으로 처리한다. hard/soft 구분은 정책과 원래 지시가 정하며 LLM이 유리한 쪽으로 재분류하지 않는다.

`p0`의 단일 생성자는 Host의 `BaselinePolicy`다. 지원되는 catalog별로 목표 기여·근거가 있는 예상·자원 비용·명시적 선호·수락된 의도를 어떤 단위와 우선순위로 비교할지 고정한다. 입력 필드·출처·정규화·동률 처리·미확인 처리와 policy revision을 기록한다. 선언한 정책이 없는 catalog는 실행 후보로 채택하지 않는다. 모이라이는 해석과 계획을 제안하지만 임의 확률을 확정하지 않는다.

학습된 신경 선호는 `b`에서 한 번만 더한다. `p0`의 점수 필드에는 라케시스의 신경 값이나 이를 풀어 쓴 선호 점수를 넣지 않는다. 후보 생성에 관심이 작용하는 경로와 후보 사이의 정량 선호 반영은 구분해 기록한다. 명시적 선호를 기준 정책에 반영했다면 같은 입력을 별도의 수동 편향으로 재가산하지 않는다. Host는 적격 후보에서 다음 분포로 추출한다.

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

`commitDecision`은 observation receipt, candidate hash, 확률, 선택 ID, 기준 상태·학습 revision, Host RNG 진행과 `held` outbox intent를 한 로컬 transaction으로 기록한다. 이미 확정한 관측을 다시 진행하지 않는다. `held` 행은 실행 owner가 소비할 수 없다.

결정 키는 `(전체 EventKey, decisionSlot)`이며 `decisionSlot`은 Host가 회차 안에서 지정하고 재시도 동안 고정한다. 요청 digest는 관측 참조·정규 후보·AssessmentSet·probe·기준 정책·변조 설정을 포함한다. 같은 키·digest는 저장한 선택 receipt를 반환하며 RNG·상태·outbox를 다시 진행하지 않는다. 같은 키에 다른 digest가 오면 충돌이다. 새 결정을 정당화하는 정정·전제 변경은 새 사건 버전 또는 새 slot과 명시적 `supersedesDecisionId`로 연결한다.

Moirai finalize는 선택된 후보의 효과 범위 안에서 계획을 구체화한다. Host의 `finalizeDecision`은 finalize 원문·계획 해시, 동일 후보/AssessmentSet, 현재 source/policy/binding과 의도 revision을 확인해 `dispatchable` 전환과 outbox release를 원자적으로 기록한다. 기존 실행 owner는 released 행만 소비하고 효과 직전 현재 권한·대상·필수 약속 조건을 다시 확인한다. finalize 실패 시 같은 선택으로 재시도하며 새 결과를 얻기 위한 재추첨은 하지 않는다.

finalize 호출 키는 `(decisionId, finalizeAttemptId)`다. 같은 키·payload digest는 저장한 성공/실패 receipt를 반환하고 다른 payload는 충돌로 거부한다. 실패 뒤 재생성이 필요하면 같은 decision의 새 attempt를 사용하며, decision마다 수락된 plan digest와 released intent는 하나뿐이다. 이미 수락된 뒤 다른 계획으로 덮거나 outbox를 다시 release하지 않는다. 응답 유실 뒤에는 저장한 결과를 조회한 다음 재시도 여부를 정한다.

대상·핵심 인자·효과 범위가 바뀌면 같은 ID로 실행하지 않는다. 기존 결정을 무효화하고 이유와 `supersedesDecisionId`가 있는 새 후보 결정을 만든다. 두 개인의 상호작용에서 상대의 수락은 상대 상태의 별도 결정이다. 실행 결과가 불명확하면 기존 owner의 reconcile을 기다리며 성공·실패를 만들어 학습하지 않는다.

## 경험 학습과 지연된 결과

학습은 첫 제품 단면에 포함한다. `W0`는 고정하고 선언된 KC–MBON 등 일부 연결의 개인별 `ΔWi`만 바꾼다. 다음 식은 **초기 학습 계열의 계약**이며 MaleCNS에서 측정된 완성 학습식이라고 주장하지 않는다.

```text
ΔWi_next = projectAllowed(ΔWi_current + η * M_compartment(outcome, prediction) * trace)
```

`M_compartment`는 결과와 당시 예측을 구획별 신호로 바꾼다. 어떤 구획에서 연결이 강화·약화되는지는 세포 유형·실험 근거에 맞춰 프로필로 확정한다. 모든 DAN을 같은 양의 보상이나 모든 시냅스의 강화 신호로 취급하지 않는다. [구획별 학습 실험](https://elifesciences.org/articles/16135)과 [학습 흔적의 일반 틀](https://www.frontiersin.org/journals/neural-circuits/articles/10.3389/fncir.2018.00053/full)을 구분해 참고한다.

`LearningTrace`는 event·probe·활동 key, scope·clock, 원래 state/learning/profile revision, 활성 연결과 흔적, 당시 예측값·예측기 버전, 생성/만료 시점을 보존한다. 즉시 피드백과 지연 피드백의 시간 단위·감쇠 규칙을 선언한다. 생물학적 초 단위 흔적을 제품의 시간 단위 기억으로 그대로 연장하지 않는다. 장기 지연은 명시적인 재생/귀속 정책을 가진 별도 프로필로 다룬다.

`TraceRef`는 불변 trace blob의 ID·digest, 원래 EventKey/observation receipt·CanonicalCueKey, agent·scope·clock·profile·원본 근거 digest를 담는다. 행동은 선택한 후보의 TraceRef를 decision과 같은 transaction에 묶는다. 대화는 수락한 최종 응답 entry·request·주제별 TraceRef를 대화 저장소의 한 transaction에 묶는다. trace blob을 먼저 영속화하며 참조 실패 상태에서 응답을 수락하지 않는다. 두 저장소의 동시 commit을 가정하지 않고, 출처 결합 entry가 확정된 뒤 신경 inbox가 그 불변 결합을 중복 없이 수신한다.

결과의 대상은 다음 구분을 반드시 포함한다.

```text
OutcomeTarget = DialogueTurnRef | ActionDecisionRef
Outcome = { outcomeId, target, sourceRef, scopeId, clockId, kind,
            observedValue, confidence, supersedesOutcomeId }
```

대화 참조는 확정된 응답 receipt를, 행동 참조는 선택·실행 상태를 가리킨다. 대화에 여러 활동이 언급되면 피드백이 어느 주제의 trace에 대응하는지 확인한다. 연결이 불명확하면 학습을 보류하고 가짜 행동 decision을 만들지 않는다. 생성한 답변은 발화의 증거이며 외부 활동 완료의 증거가 아니다.

예상 결과와 실제 결과를 구분한다. 확인 가능한 활동 결과, 명시적 사용자 평가, 발견·반복·포화 신호는 출처·목적·가중치를 분리한다. 피드백 없음은 부정 보상이 아니고, 반복 선택이나 자기 감정 설명만으로 보상을 올리지 않는다. 조회만 한 미선택 후보의 흔적을 함께 강화하지 않는다.

`observeOutcome`은 target에서 저장된 TraceRef를 조회한다. 호출자가 임의 trace를 붙이지 못하게 하며 원래 결합의 agent·scope·clock·profile·근거 digest와 일치하는지, 피드백 출처와 학습 정책이 현재 유효한지 확인한 뒤 **현재 가중치**에 한 번 적용한다. 과거 snapshot을 복원해 최근 학습을 덮지 않는다. 신경 장애로 trace가 없는 무변조 결정에는 신경 학습을 적용하지 않으며 `unavailable`로 기록한다. 결과 키는 `(agentId, scopeId, outcomeId)`이고 digest에는 target·값·출처·clock·정정 관계를 포함한다. 같은 키·digest는 저장한 receipt를 반환하며 다른 payload는 충돌이다. outcome receipt·가중치/예측기 갱신·중복 방지 inbox 상태를 한 로컬 transaction으로 확정한다. 명시적 정정은 새 outcomeId와 `supersedesOutcomeId`로 연결하고 영향을 받은 epoch를 재생/격리한다.

학습 적용 순서는 Host의 scope별 증가 순번으로 정한다. 비선형 제한이 있는 업데이트는 순서를 바꾸면 결과가 다를 수 있다. 같은 선언된 순서를 재현하는 것과 모든 순서에서 같은 결과를 요구하는 것을 구분한다.

## 포트·저장·동시성

| 제안 포트 | 입력과 확정 책임 |
| --- | --- |
| `prepareEvent` | EventKey·source/clock·기준 snapshot → PreparedEvent; 활성 상태 쓰기 없음 |
| `commitObservation` | 준비 해시·예상 revision·현재 source → 관측 receipt·다음 상태·관측 RNG를 한 번 저장 |
| `probeOptions` | 관측 receipt·동일 snapshot·정규화한 단서 → 후보별 편향·잠정 trace; 활성 상태/RNG 쓰기 없음 |
| `projectState` | 허용 scope·dimension·주제 probe → 대화/LIFE용 값과 Host 전용 proof |
| `evaluateOptions` | 동일 snapshot·canonical 후보 → 세 종류 평가·근거·가용성; 계산 단계이며 저장/효과 없음 |
| `assembleAssessments / closeCandidateSet` | candidateSetHash·모듈별 평가·coverage·누적 예산 → 검증된 불변 AssessmentSet; 누락·다른 revision·확정 뒤 추가 거부 |
| `commitDecision` | 동일 receipt·candidate/assessment/probe/policy hash → Host 추출·결정 receipt·held outbox |
| `finalizeDecision` | finalize 근거·계획·동일 후보·현재 source → 검증 뒤 released outbox |
| `observeOutcome` | 두 종류 중 하나의 target·source·trace·중복 키 → 현재 학습 상태에 한 번 반영 |
| `checkpoint / restore` | 회로·encoder·상태·학습·clock·RNG·inbox/outbox의 호환 snapshot |

Host의 제안 AgentCoreStore는 회차·모듈 평가·의도 전이를 소유한다. 신경 어댑터를 교체하거나 끈 회차에도 코어 수명은 유지한다. `state/neural-preferences.sqlite`에는 신경 사건·상태 참조·조회 receipt·학습 inbox를 둔다. 선택 receipt·Host 결정 RNG·held/released outbox의 단일 writer는 AgentCoreStore이며 `commitDecision`은 그 로컬 transaction이다. 신경 관측과 trace blob은 먼저 영속화하고 코어가 불변 참조를 기록한다. 두 저장소를 가로지르는 transaction은 가정하지 않는다. 큰 상태 blob은 임시 파일 기록·동기화·원자적 이름 변경·해시 확인을 마친 뒤 DB가 참조한다. DB 확정 전에 중단된 blob은 재시작 시 미참조 파일로 구분한다. DB와 파일을 하나의 분산 transaction으로 간주하지 않는다. 역사 receipt가 참조하는 blob을 보존 정책 없이 삭제하지 않는다.

WorldStore와 AgentCoreStore 사이에는 하나의 transaction이 없다. 기존 LIFE step에 decisionId를 보존하고 outbox/inbox와 기존 prepare/reconcile로 중복을 막는다. 실제 효과가 중복되지 않는지는 해당 effect owner의 시험으로 입증한다.

checkpoint는 기존 설치/checkpoint owner가 조정한다. 대상 scope의 신규 회차·dispatch·모든 상태 writer를 막고, 진행 중 DB 쓰기를 마친 뒤 공통 증가 순번을 고정한다. 이 동안 관측·학습·의도·결정·RNG는 진행하지 않는다. 원문 저장소·WorldStore의 참조 snapshot, 신경 DB와 blob, AgentCoreStore를 차례로 저장하고 마지막에 `CheckpointManifest { checkpointId, schemaVersions, perScopeSequence, storeRevisions, profileHashes, blobDigests, pendingInboxOutbox }`를 확정한다. 대기 중 외부 결과는 inbox에서 보존하고 미확인 효과는 reconcile 대상으로 남긴다. manifest가 확정되기 전 파일 묶음은 복원 가능한 checkpoint가 아니다.

복원 시 서비스 쓰기를 막은 채 동일 manifest의 저장소·blob·원문 참조를 모두 대조한다. 서로 다른 checkpoint의 DB나 누락된 trace를 섞으면 거부하고 원본을 보존한다. 호환 검사와 pending inbox/outbox 및 실제 효과 reconcile이 끝난 뒤 회차를 재개한다. 실패한 다중 저장소 복원을 부분 성공으로 활성화하지 않는다. 실제 데이터 보존·오프라인 복원 경계는 기존 설치/checkpoint owner를 확장하며 별도 복원기를 만들지 않는다.

한 `(agent, scope)`의 관측·결정 준비·LLM 종합 또는 finalize가 끝날 때까지 회차 lease로 순서를 유지한다. 다른 일반 사건·outcome의 신경·의도·예측 상태 쓰기는 큐에서 기다린다. source 정정·권한 회수·현재 약속의 취소/변경은 이 lease를 기다리지 않고 generation을 변경해 관련 회차를 무효화한다. `commitDecision`과 `finalizeDecision` 모두 snapshot의 의도 revision과 현재 generation을 검사한다. lease 만료·취소 후 늦은 응답은 fencing token으로 거부한다. 외부 행동 결과를 기다리는 동안 회차 lease를 잡아두지 않는다.

다른 scope·개인은 독립적으로 준비할 수 있고 DB commit은 Host가 직렬화한다. `dispatchable` 이후의 정상적인 개인 상태 변화만으로 과거 선택을 다시 추첨하지 않는다. 효과 직전에는 현재 권한·근거·대상 조건을 재검증한다. 공동 세계 변경은 기존 world revision/lease 경계를 따른다.

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

첫 단위는 한 개인·한 공개 scope에서 세 판단의 상태·계산·결과 계약, MaleCNS 부분회로의 제한된 학습, 실제 Moirai 대화, 검증된 피드백, 재시작을 함께 연결한다. 단서별 학습 재독출을 통과하면 LIFE 실행 계약으로 이어간다. 원래 배선이 모든 일반 모델보다 우월해야 다음 제품 기능을 개발할 수 있다는 관문은 두지 않는다.

| 단위 | 제안 변경 위치 | 그 단위가 남길 기능과 수용 증거 |
| --- | --- | --- |
| 1. 개인 코어·대화·학습 | NEW core `agents/judgment.ts`, `judgment-store.ts`, `neural-preference.ts`; runtime `cognition/conversation.ts`, `prospect.ts`, `value.ts`, `continuity.ts`, `neural-preference/port.ts`, `client.ts`, `store.ts`, `senpi/session.ts`; MODIFY runtime `session-app.ts`, `session-engine.ts`, `host.ts`, `sdk-port.ts`, `runtime.ts`와 core `store.ts`; 별도 Python 배포 단위 | 실제 회로 artifact·학습 조회, Senpi 3+1+추가 호출 입력, 세 모듈의 계산 receipt, 의도 전이·출처 참조, 응답·trace 결합, 결과의 소비자별 복구와 file DB 재시작 |
| 2. 공통 후보·LIFE 행동 | NEW runtime `cognition/option-assessments.ts`, `baseline-policy.ts`; MODIFY `life/director.ts`, `life/model-port.ts`, core `world/autonomy-persistence.ts`와 step/identity codecs | 공통 후보별 세 평가·단일 p0·선호 중복 차단, 3+2+추가 평가 비용, held/released outbox·target 독립 선택, 보류 후 무실행·재시작 후 중복 추출 없음 |
| 3. 성장·scope | MODIFY core `agents/behavior-types.ts`, `behavior-store.ts`, `persona.ts`, runtime `persona/native-growth.ts`, `persona/hooks.ts`, `fleet/life-runtime.ts` | dimension 생성자·source proof 버전, 공개 허용 성장만 전이, 철회·정정·같은 경험 중복 학습 차단 |
| 4. 8명 운영 | MODIFY runtime `life/scheduler.ts`, fleet 신경 서비스 조립·종료, 설치/checkpoint 소유자 | per-scope 큐·fence·배치·프로세스 종료/복구, 혼합 부하와 실제 자원 측정 |

위 경로의 core/runtime은 각각 `packages/lina-core/src/`, `packages/lina-runtime/src/` 접두사다. 후속 구현 PR은 해당 시점 실제 파일과 소비자를 다시 대조한다. 단위 1의 대화 통합은 provenance를 가진 전용 `agentState` 입력만 사용하며, 기존 공유 성향 dimension 생성자 전환은 단위 3에서 수행한다. 단위 1에서도 같은 경험·dimension이 기존 성장과 신경 입력으로 중복 반영되지 않도록 입력 계약에서 생성자를 지정한다. 분리할 수 없는 dimension은 전환 전까지 신경 투영에서 제외한다. 이 순서로 처음부터 학습을 확인하면서 기존 성향 owner도 보존한다.

대조한 dev에는 PR #10의 Senpi 3+1 회차가 제품 통합돼 있지 않다. 단위 1은 새 SDK로 이 경로를 연결하는 변경을 포함한다. `session-app.ts`가 Senpi 어댑터로 내부 역할 세션과 최종 종합 세션을 조립하고, `cognition/conversation.ts`는 `SessionPort` 경계에서 하나의 논리 대화 수명을 제공한다. 기존 [SessionEngine.kind](../../../packages/lina-runtime/src/session-engine.ts#L6)의 Codex 고정 타입·생성 소비자·잠근 의존성과 엔진 정책도 해당 Senpi 전환 단위에서 함께 갱신한다. 퇴역한 구현을 복원하거나 Codex 스레드·RPC를 새 백엔드의 전제로 두지 않는다.

내부 조언은 사용자 발송·직접 효과 실행 권한을 갖지 않고, 최종 응답만 DurableRuntime의 출처 확인·entry 저장·settlement 경계로 보낸다. 필요한 근거 조회는 Host의 허용된 조회 계약으로 수행한다. 원문·완결된 내부 의견·구조화된 평가·출력 보존을 실제 Senpi 제품 전송에서 검증한다. PR #10의 익명 문자열 schema를 변경하는 마이그레이션이며 예전 QA를 제품 적합성 증거로 대신하지 않는다. Senpi에서 관찰 가능한 session/run 식별자와 Host의 회차·source 증거를 대응시키며, Codex 전용 `nativeEpoch` 의미를 이름만 바꿔 재사용하지 않는다. 다른 Senpi/Moirai 통합이 먼저 병합되면 그 소유자를 확장하며 두 어댑터·회차 조정기를 만들지 않는다. QA runner에서만 성공한 결과는 단위 1 완료가 아니다.

검증은 개발자가 선언한 정답 감정을 맞히는 시험으로 끝내지 않는다.

| 수용 질문 | 필요한 개입과 관찰 |
| --- | --- |
| 세 판단이 서로 다른 원인에 반응하는가 | 공통 입력을 고정해 경험/신경 가중치, 외부 근거, 수락된 약속을 각각 개입. 라케시스 평가, 클로토 예측, 아트로포스 충돌 판단의 예상 변화를 확인하고 사실·권한은 임의로 변하지 않는지 검사 |
| 프롬프트 분리보다 효용이 있는가 | 동일 LLM·입력·기억·총예산의 프롬프트 3+1과 전체 구조, 예측/선호/의도 메커니즘을 하나씩 끈 조건 비교. 확인된 결과·목표 지속·선호 수정·비용으로 판정하며 자기 설명은 점수가 아님 |
| 공통 후보 비교가 성립하는가 | 새 후보·평가 누락·다른 snapshot·예산 소진·p0에 선호 재주입·약속 변경의 무효화. 무평가 추첨과 이중 가산은 0건 |
| 활동별 경험이 가중치에 남았는가 | 같은 초기 두 개인에 상반된 결과, 외부 선호표·readout·`p0` 고정. 중립 사건에서 같은 활동 단서 조회, 빠른 상태 초기화·재시작·새 시드 뒤의 선택 경향 |
| 회로 내부 학습이 원인인가 | `ΔW` 교환/차단, trace-결과 연결 섞기, 무보상·반대 결과, 외부 readout 학습만 있는 조건과 비교 |
| 표현이나 후보 수가 원인인가 | 동의 표현·순서·중복 후보, 동일 활동 그룹의 방법 수 변경, catalog 밖 후보 검증 |
| 인지와 실제 효과가 보존되는가 | 원문·완결된 의견·평가 출처 보존, 상태 변경의 의미상 선택 변화, held 상태의 실행 0, 효과 범위 변경 거부, selected/finalized/executed 분포 구분 |
| 정상 복구인가 | 각 blob/DB/선택/finalize/dispatch/outcome 경계 중단, consumerRevision 변경 후 중복 결과, source 철회·lease 만료·늦은 응답, checkpoint 도중 중단·다른 DB 조합·trace 누락 거부와 같은 순번의 재현 |
| 일반 학습 모델보다 어떤 가치가 있는가 | 같은 입력·기억·느린 상태·학습 신호·조정 예산의 일반 순환망/밴딧·생물 원리 모형·재배선·MaleCNS 비교. 품질·선호 유지/수정·간섭·조정량·비용을 분리 |

후속 실행 검사는 먼저 해당 core/runtime의 신경 계약 테스트와 실제 source/built SDK 전송 검사를 추가하고, 영향을 받는 기존 테스트를 실행한다. 예를 들어 `bun test packages/lina-core/test/neural-preference.test.ts packages/lina-runtime/test/neural-preference.test.ts`는 **추가할 테스트의 실행 명령**이며 현재 파일이나 통과 결과가 아니다. 문서 변경인 이번 PR은 `bun run ci:validate`, 링크/참조/계약 대조와 `git diff --check`로 검증한다.

## 남은 결정과 검증 범위

이 문서의 세 판단 구조는 새 설계이며 이전 신경 모듈 초안의 Oracle 검토 결과를 승계하지 않는다. 문서 검토와 CI는 실제 판단 효용·회로 학습·운영 성능의 증거가 아니다.

최초 구현 전에 확정할 산출물은 실제 세포 목록·경계 조건·전달 부호, encoder의 특징 공간과 읽기 방향, 구획별 학습 상수·예측기, artifact 배포 방식, catalog별 BaselinePolicy와 의도 수락/전이 규칙이다. 이번 단계는 임의 수치로 그 빈칸을 채우지 않고 필요한 입력·검사·실패 동작을 고정한다. 첫 회로 프로필의 대상별 학습·재독출이 실패하면 원인을 입력·회로·readout·학습으로 나눠 수정하며, 말투 변화나 문서 CI 통과로 학습 성공을 대체하지 않는다.
