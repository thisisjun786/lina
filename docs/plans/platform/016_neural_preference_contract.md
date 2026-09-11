# 신경 선호 엔진의 사건·조회·학습·실행 계약

상태: 2026-09-11 설계 제안. [015 연구·제품 방향](015_neural_preference_engine_research.md)을 구현 가능한 계약으로 구체화한다. 이 문서의 타입·포트·파일은 제안이며 신경 서비스, 데이터 추출, 학습 실험, 제품 활성화가 완료됐다는 뜻이 아니다. 015는 채택 이유·근거·제품 범위를, 이 문서는 사건 처리·계산·영속화·수용 조건을 소유한다.

이 설계의 입력 데이터는 Google Research가 소개한 **MaleCNS v1.0**이다. 고정된 MaleCNS 부분회로, 개인별 학습, 실제 대화와 LIFE의 선택, 재시작과 8명 운영을 하나의 제품 경로로 만든다. 일반 학습 모델과의 비교는 구현 선택의 근거이며 전체 기능을 첫 비교 실험으로 제한하지 않는다.

## 결정과 현재 연결 지점

기존 코드 연결 지점은 `522101ff99e356b0ea6d27b4ea03ec7e599ee4b3`, 인지 확장 기준은 PR #10의 `5b22aee53f9f7c01cc508289099f662aed613140`이다. **이 설계의 선택된 대화·인지 백엔드는 새 Senpi SDK**다. PR #10에는 Senpi SDK 생성·대화·도구·취소·재개 검증과 영어 인지 프롬프트가 들어 있다. 같은 PR에 남은 ‘실행 엔진 재검토’ 문구보다 이번 Senpi 선택을 설계 기준으로 우선한다. 기존 dev의 Codex 코드와 정책은 전환 전 연결 지점을 찾는 근거이며, 이 문서가 Senpi 제품 통합 완료를 증명하지는 않는다.

| 현재 소유자 | 확인한 책임 | 제안하는 변경 |
| --- | --- | --- |
| [개인 성장 생성](../../../packages/lina-runtime/src/persona/native-growth.ts#L161) → AgentStore | 허용된 경험의 모델 해석을 성향 값으로 저장 | 지정 dimension의 생성자를 기존 해석 또는 신경 투영 중 하나로 선택 |
| [성향 합성](../../../packages/lina-core/src/agents/persona.ts#L53) → 대화·LIFE | 정체성·lock을 지키며 허용된 현재 성향 제공 | 새 신경 출처의 유효성·revision을 확인한 투영만 소비 |
| [Moirai 입력 조립](https://github.com/thisisjun786/lina/blob/5b22aee53f9f7c01cc508289099f662aed613140/scripts/qa/senpi-sdk/moirai-runner.ts#L145) | 원래 대화와 완결된 익명 조언 원문 | 버전 있는 상태 입력과 별도 행동 prepare/finalize 모드 |
| [제품 세션 조립](../../../packages/lina-runtime/src/session-app.ts#L500)·[SessionPort](../../../packages/lina-runtime/src/sdk-port.ts#L27) | 기존 실행 세션을 DurableRuntime에 연결 | Senpi 어댑터와 제품 회차 조정기가 내부 조언·종합을 수행하고 하나의 논리 대화 포트만 외부에 노출 |
| [대화 기록·정착](../../../packages/lina-runtime/src/runtime.ts#L182)·[출처 결합 저장](../../../packages/lina-core/src/store.ts#L300) | 응답 entry와 request의 출처 연결·settlement | 수락한 최종 응답과 학습 TraceRef 결합을 원자적으로 기록 |
| [LIFE director](../../../packages/lina-runtime/src/life/director.ts#L82)·[영속화](../../../packages/lina-core/src/world/autonomy-persistence.ts#L513) | actor·target·reflection, prepare/reconcile | 확정 결정 참조와 실행 가능 상태를 소비; 순수 재계산에서 신경 상태를 진행하지 않음 |

새 경계가 필요한 이유는 계산량·실행 언어와 상태 수명 때문이다. Host가 저장·현재성·선택·효과를 소유하고, 별도 Python 계산기는 불변 snapshot을 받아 수치 결과만 반환한다. 채널·Memory가 Python이나 실행 SDK를 직접 호출하지 않는다. 기존 성장 함수에 시뮬레이터와 DB 쓰기를 함께 넣는 안은 재시도 시 학습·추출이 중복될 수 있어 채택하지 않는다.

아래 명세는 기존 공개 API를 즉시 바꾸지 않는다. 후속 구현은 타입 버전, source proof, 저장 복구와 각 소비자를 같은 단위에서 변경한다.

Senpi 연결은 PR #10의 [세션 생성](https://github.com/thisisjun786/lina/blob/5b22aee53f9f7c01cc508289099f662aed613140/scripts/qa/senpi-sdk/live-session.ts#L72)과 [잠근 의존성](https://github.com/thisisjun786/lina/blob/5b22aee53f9f7c01cc508289099f662aed613140/scripts/qa/senpi-sdk/package.json#L13)을 출발점으로 한다. 확인한 버전은 `@code-yeongyu/senpi@2026.9.10-2`이며 `createAgentSession`, `ModelRuntime`, `SessionManager`를 제품 어댑터 안에서 사용한다. QA의 capture provider·임시 경로·고정 모델·도구 권한을 제품에 복사하지 않는다. Senpi 세션의 수명·응답·usage를 Host 포트에 대응시키고 원래 request·source 연결은 Host가 소유한다. 신경 계산기는 SDK와 독립된 포트 뒤에 둔다.

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
| 작성 정체성·명시적 선호·권한·약속 | 기존 AgentStore·ConversationStore·실행 정책 | 신경 학습은 원본을 변경하지 못함 |
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

일반 대화는 원래 대화와 세 완결된 익명 영어 조언을 보존하고, 별도 상태 자료를 Moirai의 최종 입력에 추가한다. 세 조언은 행동 후보 세 개가 아니다. Moirai는 자료를 참고해 사실·의도·약속을 판단하고 사용자 언어로 답한다. 상태 수치가 진실·지시·권한이 되지 않으며 특정 자연어 답변 확률도 보장하지 않는다.

명시적 행동 모드는 조언 3회 → `moirai_prepare` → Host 선택 → `moirai_finalize`의 기본 5호출이다. 두 Moirai 단계 모두 동일 원문·조언·근거를 받는다. 기존 4호출 모드와 입력 schema·프롬프트·wire 검사를 구분하고 재시도·추가 조회·취소·usage도 기록한다. PR #10 capture의 6회 차단선은 새 호출을 숨길 여유분이 아니다.

### 후보의 의미와 효과 범위

첫 행동 모드는 해당 LIFE pack이 선언한 한정된 활동 catalog를 사용한다. `CanonicalOption`은 `kind`, actor·scope, 대상 ID, 핵심 인자, 전제조건, 허용 효과 범위와 버전을 포함한다. Host가 catalog의 schema·정규화 규칙으로 만든 key가 행동 동일성의 기준이며 LLM이 만든 임의 ID를 신뢰하지 않는다.

같은 canonical key의 표면 표현은 합친다. 같은 활동의 서로 다른 방법을 허용하면 먼저 활동 그룹의 확률 질량을 정하고 방법들에 나누는 정책을 기록한다. 음악 표현 두 개와 그림 표현 하나라는 이유로 음악 확률이 두 배가 되어서는 안 된다. 자유문장 전체의 의미 동일성을 일반 파서로 증명하지 않는다. catalog 밖의 제안은 확정 실행 후보에 넣기 전 별도 정규화·검증이 필요하다.

Host는 허용된 후보에서 기준 정책 `p0`와 조회 편향으로 추출한다.

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

결정 키는 `(전체 EventKey, decisionSlot)`이며 `decisionSlot`은 Host가 회차 안에서 지정하고 재시도 동안 고정한다. 요청 digest는 관측 참조·정규 후보·probe·기준 정책·변조 설정을 포함한다. 같은 키·digest는 저장한 선택 receipt를 반환하며 RNG·상태·outbox를 다시 진행하지 않는다. 같은 키에 다른 digest가 오면 충돌이다. 새 결정을 정당화하는 정정·전제 변경은 새 사건 버전 또는 새 slot과 명시적 `supersedesDecisionId`로 연결한다.

Moirai finalize는 선택된 후보의 효과 범위 안에서 계획을 구체화한다. Host의 `finalizeDecision`은 finalize 원문·계획 해시와 동일 후보/근거, 현재 source/policy/binding을 확인해 `dispatchable` 전환과 outbox release를 원자적으로 기록한다. 기존 실행 owner는 released 행만 소비하고 효과 직전 현재 권한·대상 revision을 다시 확인한다. finalize 실패 시 같은 선택으로 재시도하며 새 결과를 얻기 위한 재추첨은 하지 않는다.

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
| `commitDecision` | 동일 receipt·candidate/probe/policy hash → Host 추출·결정 receipt·held outbox |
| `finalizeDecision` | finalize 근거·계획·동일 후보·현재 source → 검증 뒤 released outbox |
| `observeOutcome` | 두 종류 중 하나의 target·source·trace·중복 키 → 현재 학습 상태에 한 번 반영 |
| `checkpoint / restore` | 회로·encoder·상태·학습·clock·RNG·inbox/outbox의 호환 snapshot |

Host의 신규 `state/neural-preferences.sqlite`에 사건·상태 참조·조회 receipt·결정·결과 inbox·효과 outbox를 둔다. 큰 상태 blob은 임시 파일 기록·동기화·원자적 이름 변경·해시 확인을 마친 뒤 DB가 참조한다. DB 확정 전에 중단된 blob은 재시작 시 미참조 파일로 구분한다. DB와 파일을 하나의 분산 transaction으로 간주하지 않는다. 역사 receipt가 참조하는 blob을 보존 정책 없이 삭제하지 않는다.

WorldStore와 신경 DB 사이에는 하나의 transaction이 없다. 기존 LIFE step에 decisionId를 보존하고 outbox/inbox와 기존 prepare/reconcile로 중복을 막는다. 실제 효과가 중복되지 않는지는 해당 effect owner의 시험으로 입증한다.

한 `(agent, scope)`의 관측·결정 준비·LLM 종합 또는 finalize가 끝날 때까지 회차 lease로 순서를 유지한다. 다른 일반 사건·outcome의 신경 쓰기는 큐에서 기다린다. source 정정·권한 회수는 이 lease를 기다리지 않고 generation을 변경해 진행 중 회차를 무효화할 수 있다. lease 만료·취소 후 늦은 응답은 fencing token으로 거부한다. 외부 행동 결과를 기다리는 동안 회차 lease를 잡아두지 않는다.

다른 scope·개인은 독립적으로 준비할 수 있고 DB commit은 Host가 직렬화한다. `dispatchable` 이후의 정상적인 개인 상태 변화만으로 과거 선택을 다시 추첨하지 않는다. 효과 직전에는 현재 권한·근거·대상 조건을 재검증한다. 공동 세계 변경은 기존 world revision/lease 경계를 따른다.

현실 공통 scope와 LIFE scope는 각각의 `clockId`·단위·마지막 적용 시점·증가 순번을 가진다. 시계 역행은 오류다. 느린 `m`은 해당 시계 경과분을 한 번 감쇠한다. 유휴가 프로필의 한계를 넘으면 빠른 전위·발화·지연 버퍼를 휴지 상태로 초기화하고 학습 가중치는 유지한다. 재시작 자체를 초기화 사유로 삼지 않는다. 호환 프로필 없는 checkpoint는 격리하고 원본을 보존한다.

8명은 정체성 수이며 실제 상태 수는 공통 scope와 활성 세계 scope의 합이다. Python 상주 계산기는 불변 그래프를 공유하고 준비된 요청만 배치한다. 학습 마스크·개인 가중치·상태·각 RNG stream은 분리한다. 단일 Python 프로세스가 종료되면 여러 개인의 신경 계산이 함께 멈출 수 있다. 논리적 개인 격리가 프로세스 장애 격리까지 보장하지는 않는다.

## 실패와 검증할 행동

| 실패 지점 | 허용된 처리 |
| --- | --- |
| 신경 계산 시간 초과·NaN·발화 폭주·포화 | 아직 준비만 된 상태를 폐기, 명시적 무변조 경로. 이미 확정된 관측은 유지하며 원래 receipt와 연결 |
| 신경 조회 실패·예산 초과 | 후보의 일부 실패를 0 편향으로 숨기지 않음. 해당 결정 전체의 변조를 끄거나 선언된 재처리 정책 사용 |
| 조언 불완전·미수신 | 종합 중지. 신경 장애의 무변조 경로와 구분 |
| source/권한/lease 무효화 | 해당 회차·준비/held 효과를 무효화. `p0`로 우회 실행 금지 |
| finalize 실패 | held 상태 유지·같은 선택으로 제한된 재시도 또는 취소; 실행 없음 |
| 효과 전송 결과 불명 | reconcile; 영수증 확인 전 성공/실패 보상 없음 |
| 학습 근거 철회 | 관련 투영 보류, checkpoint 재생 또는 epoch 격리; 감사 기록 유지 |

신경 계산 장애에만 적용하는 무변조 모드는 자연어 경로에서는 해당 회차의 신경 자료를 생략하고, 행동 경로에서는 동일 적격 후보와 검증된 `p0`로 선택한다. 동일 요청의 확정 결과를 보존하고 늦은 Python 결과를 덧붙이지 않는다. 회차/큐/재시도/저장/진단 공간의 한도는 설정으로 관리한다.

관측 자체가 실패한 무변조 결정은 실제 관측 receipt 대신 `ObservationUnavailableRef(EventKey, failureReceiptId)`를 저장한다. 이 참조도 source·권한 검사를 요구하지만 신경 상태가 진행됐다는 뜻은 아니다. 결정 키·단일 추출·finalize/효과 계약은 그대로 적용하고 TraceRef는 비워 둔다.

최초 측정은 CPU 부분회로에서 수행한다. 신경 추가 지연 p95 100ms·deadline 250ms, 전체 평균 2건/초와 8건 동시 도착은 초안의 **미측정 목표**다. 활동별 조회 비용과 가소성 비용까지 포함해 재산정하며 이 수치를 LLM 출력·추론 제한으로 쓰지 않는다. API/LLM 시간, IPC, 관측, 단서별 조회, 큐, 저장을 분리 측정한다. GPU 지원은 동일 프로필·부하에서 실제 RAM/VRAM·처리량·확률/상태 오차를 측정한 뒤 결정한다.

## 구현 단위와 완료 증거

첫 단위는 한 개인·한 공개 scope에서 MaleCNS 부분회로의 제한된 학습, 실제 Moirai 대화, 검증된 피드백, 재시작을 함께 연결한다. 단서별 학습 재독출을 통과하면 LIFE 실행 계약으로 이어간다. 원래 배선이 모든 일반 모델보다 우월해야 다음 제품 기능을 개발할 수 있다는 관문은 두지 않는다.

| 단위 | 제안 변경 위치 | 그 단위가 남길 기능과 수용 증거 |
| --- | --- | --- |
| 1. 자료·회로 및 개인 대화 | NEW `packages/lina-core/src/agents/neural-preference.ts`, runtime `neural-preference/port.ts`, `client.ts`, `store.ts`, `cognition/conversation.ts`, `senpi/session.ts`; MODIFY runtime `session-app.ts`, `session-engine.ts`, `host.ts`, `sdk-port.ts`, `runtime.ts`와 core `store.ts`의 응답·trace 결합 계약; 별도 Python 배포 단위 | 실제 dataset artifact/hash·부분회로·단서별 학습 조회, 제품 Senpi 경로의 3+1 입력, 응답·trace의 durable 결합, outcome, file DB 재시작. Python 경로·배포 방식은 추출 artifact와 함께 확정 |
| 2. LIFE 행동 | MODIFY `life/director.ts`, `life/model-port.ts`, core `world/autonomy-persistence.ts`와 step/identity codecs | canonical 후보·5호출·held/released outbox·target 독립 선택, 보류 후 무실행·재시작 후 중복 추출 없음 |
| 3. 성장·scope | MODIFY core `agents/behavior-types.ts`, `behavior-store.ts`, `persona.ts`, runtime `persona/native-growth.ts`, `persona/hooks.ts`, `fleet/life-runtime.ts` | dimension 생성자·source proof 버전, 공개 허용 성장만 전이, 철회·정정·같은 경험 중복 학습 차단 |
| 4. 8명 운영 | MODIFY runtime `life/scheduler.ts`, fleet 신경 서비스 조립·종료, 설치/checkpoint 소유자 | per-scope 큐·fence·배치·프로세스 종료/복구, 혼합 부하와 실제 자원 측정 |

위 MODIFY 경로의 core/runtime 접두사는 앞 열 문맥에 따른다. 후속 구현 PR은 해당 시점 실제 파일과 소비자를 다시 대조한다. 단위 1의 대화 통합은 provenance를 가진 전용 `agentState` 입력만 사용하며, 기존 공유 성향 dimension 생성자 전환은 단위 3에서 수행한다. 단위 1에서도 같은 경험·dimension이 기존 성장과 신경 입력으로 중복 반영되지 않도록 입력 계약에서 생성자를 지정한다. 분리할 수 없는 dimension은 전환 전까지 신경 투영에서 제외한다. 이 순서로 처음부터 학습을 확인하면서 기존 성향 owner도 보존한다.

대조한 dev에는 PR #10의 Senpi 3+1 회차가 제품 통합돼 있지 않다. 단위 1은 새 SDK로 이 경로를 연결하는 변경을 포함한다. `session-app.ts`가 Senpi 어댑터로 내부 역할 세션과 최종 종합 세션을 조립하고, `cognition/conversation.ts`는 `SessionPort` 경계에서 하나의 논리 대화 수명을 제공한다. 기존 [SessionEngine.kind](../../../packages/lina-runtime/src/session-engine.ts#L6)의 Codex 고정 타입·생성 소비자·잠근 의존성과 엔진 정책도 해당 Senpi 전환 단위에서 함께 갱신한다. 퇴역한 구현을 복원하거나 Codex 스레드·RPC를 새 백엔드의 전제로 두지 않는다.

내부 조언은 사용자 발송·직접 효과 실행 권한을 갖지 않고, 최종 응답만 DurableRuntime의 출처 확인·entry 저장·settlement 경계로 보낸다. 필요한 근거 조회는 Host의 허용된 조회 계약으로 수행한다. PR #10의 원문·익명 영어 조언·출력 정책을 실제 Senpi 제품 전송에서도 검증한다. Senpi에서 관찰 가능한 session/run 식별자와 Host의 회차·source 증거를 대응시키며, Codex 전용 `nativeEpoch` 의미를 이름만 바꿔 재사용하지 않는다. 다른 Senpi/Moirai 통합이 먼저 병합되면 그 소유자를 확장하며 두 어댑터·회차 조정기를 만들지 않는다. QA runner에서만 성공한 결과는 단위 1 완료가 아니다.

검증은 개발자가 선언한 정답 감정을 맞히는 시험으로 끝내지 않는다.

| 수용 질문 | 필요한 개입과 관찰 |
| --- | --- |
| 활동별 경험이 가중치에 남았는가 | 같은 초기 두 개인에 상반된 결과, 외부 선호표·readout·`p0` 고정. 중립 사건에서 같은 활동 단서 조회, 빠른 상태 초기화·재시작·새 시드 뒤의 선택 경향 |
| 회로 내부 학습이 원인인가 | `ΔW` 교환/차단, trace-결과 연결 섞기, 무보상·반대 결과, 외부 readout 학습만 있는 조건과 비교 |
| 표현이나 후보 수가 원인인가 | 동의 표현·순서·중복 후보, 동일 활동 그룹의 방법 수 변경, catalog 밖 후보 검증 |
| 인지와 실제 효과가 보존되는가 | 원문·익명 영어 조언 보존, 상태 변경의 의미상 선택 변화, held 상태의 실행 0, 효과 범위 변경 거부, selected/finalized/executed 분포 구분 |
| 정상 복구인가 | 각 blob/DB/선택/finalize/dispatch/outcome 경계 중단, 중복 요청·결과, source 철회·lease 만료·늦은 응답, 같은 순번의 재현 |
| 일반 학습 모델보다 어떤 가치가 있는가 | 같은 입력·기억·느린 상태·학습 신호·조정 예산의 일반 순환망/밴딧·생물 원리 모형·재배선·MaleCNS 비교. 품질·선호 유지/수정·간섭·조정량·비용을 분리 |

후속 실행 검사는 먼저 해당 core/runtime의 신경 계약 테스트와 실제 source/built SDK 전송 검사를 추가하고, 영향을 받는 기존 테스트를 실행한다. 예를 들어 `bun test packages/lina-core/test/neural-preference.test.ts packages/lina-runtime/test/neural-preference.test.ts`는 **추가할 테스트의 실행 명령**이며 현재 파일이나 통과 결과가 아니다. 문서 변경인 이번 PR은 `bun run ci:validate`, 링크/참조/계약 대조와 `git diff --check`로 검증한다.

## 검토 반영과 남은 결정

Oracle가 검토한 이전 344행 초안의 공백은 실행 release를 finalize 뒤로 이동, 관측과 행동 확정 분리, 단서별 조회, 결과 target 구분, 후보 의미/효과 범위 고정으로 보완했다. Oracle는 MaleCNS로 변경한 이 문서나 새 조회 프로필을 검토하지 않았다. 후속 독립 문서 검토도 실제 학습 효과나 운영 성능의 증거는 아니다.

최초 구현 전에 확정할 산출물은 실제 세포 목록·경계 조건·전달 부호, encoder의 특징 공간과 읽기 방향, 구획별 학습 상수·예측기, artifact 배포 방식이다. 이번 단계는 임의 수치로 그 빈칸을 채우지 않고 필요한 입력·검사·실패 동작을 고정한다. 첫 회로 프로필의 대상별 학습·재독출이 실패하면 원인을 입력·회로·readout·학습으로 나눠 수정하며, 말투 변화나 문서 CI 통과로 학습 성공을 대체하지 않는다.
