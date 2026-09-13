# 모이라이 엔진 구현 로드맵과 소스 재료

상태: 2026-09-13. 정본 [MOIRAI_ENGINE](../../MOIRAI_ENGINE.md)의 결정을 현재 소스에 연결한다. 이 문서는 소스 재료 표, LIFE 전환, F1–F4 의존 순서, 확정된 결정의 남은 산출물, 검증 가설을 소유한다. 모듈 정의·조정 정책·행동 catalog·의도 schema·회로 프로필은 정본이, 타입·포트·저장·복구는 [016 계약](016_neural_preference_contract.md)이, 근거는 [015](015_neural_preference_engine_research.md)가, 채널·모델 운영은 [030](../context-engines/030_moirai_refactor_plan.md)이 소유한다. 아래 경로와 타입은 구현 후보이며 구현 완료나 통과한 테스트를 뜻하지 않는다.

## 현재 구현에서 확인한 재료

기준 제품 소스는 `522101ff99e356b0ea6d27b4ea03ec7e599ee4b3`다. 표의 구현은 이 소스의 호출 경로를 뜻하며 운영 설치본의 활성화나 실모델 효용을 뜻하지 않는다. LIFE는 작성된 pack·설정·공개 범위가 있어야 동작한다.

| 기존 모듈과 근거 | 실제 기능 | 목표 구조의 위치 |
| --- | --- | --- |
| [AgentStore·페르소나](../../../packages/lina-core/src/agents/persona.ts#L56), [온보딩](../../../packages/lina-core/src/onboarding/types.ts#L3) | 작성 정체성·가치관·관심·대화 선호와 변경 가능한 성향 | 공통 자기모델. 어떤 판단도 정체성·명시적 지시의 별도 원본을 만들지 않음. `PersonaSchema` 소유자(D18) |
| [ContextStore·WorkingState](../../../packages/lina-core/src/context/types.ts#L56) | 현재 목표·결정·미해결 항목·다음 단계, 출처 있는 요약·원문 확장 | 공통 현재 문맥. 목표 메모와 수락된 장기 의도는 구분 |
| [EngineStore](../../../packages/lina-memory/src/engine/store.ts#L57), [기억 추론](../../../packages/lina-runtime/src/context/memory-consolidation.ts#L63) | 기억·출처·정정·철회, LLM 연역/귀납 제안과 전제 이력 검증 | 세 관점의 공통 경험·근거 조회. 개인 기억의 기본 검색은 문자열 기반이며 추론 이력은 논리적 참을 자동 증명하지 않음 |
| [ResourceSearch](../../../packages/lina-runtime/src/resources/search.ts#L58) | 자료 추출·요약·검색·자료 파생 기억·활동 기록 | 공통 지식 조회. 자료에서 읽은 사실과 개인이 겪은 경험의 출처를 유지 |
| [World 규칙](../../../packages/lina-core/src/world/rules.ts#L115), [공개된 세계 읽기](../../../packages/lina-runtime/src/world.ts#L81) | 장소·사건·조건·효과와 참여자별 접근 범위 | 도메인 상태·규칙의 소유자. 클로토의 허용된 예측에 활용 |
| [LIFE 욕구·목표](../../../packages/lina-core/src/world/autonomy-types.ts#L16), [사건 선택](../../../packages/lina-core/src/world/events.ts#L25) | 욕구 drift, 목표 우선순위·진행률, 성향·습관·반복 패널티를 반영한 사건/참여자 선택 | 욕구·목표 원본은 재사용. 기존 개인 선택 부분은 아래 LIFE 전환 계약으로 분리 |
| [Ensemble 어댑터](../../../packages/lina-runtime/src/life/social/execution.ts#L104) | 규칙 기반 사회적 의향, 작성된 행동 그래프 탐색, 상대 반응·효과 계산 | 공통 사회 도메인 서비스. 라케시스는 의향 근거, 클로토는 허용된 결과 가정에 활용 |
| [NativePersonaGrowth](../../../packages/lina-runtime/src/persona/native-growth.ts#L25), [BehaviorStore](../../../packages/lina-core/src/agents/behavior-store.ts#L75) | 유효한 기억을 성향·습관으로 해석하고 대화·LIFE에 투영 | 공통 성향 소유자. reflection/neural 생성자를 dimension별로 지정 |
| [TaskManager](../../../packages/lina-codex/src/tasks.ts#L139), [작업 도구](../../../packages/lina-runtime/src/tools/codex-tasks.ts#L25) | 지속되는 개발 작업, 지시·중단·인계·결과 통지 | 실행 소유자. catalog v1의 `task.*` effect owner. D22에 따라 Codex app-server RPC를 유지하고 작업 ID·receipt·권한 계약은 유지. 프로세스 종료를 목표 달성으로 간주하지 않음 |
| [이미지 작업](../../../packages/lina-runtime/src/images/jobs.ts#L39), [LIFE 게시](../../../packages/lina-runtime/src/life/publication.ts#L302) | 생성·편집·취소·복구, 게시·답글·아바타 연결 | 표현·실행 소유자. 무엇을 표현할지의 개인 판단은 모이라이에 요청 |
| [AgentFleet](../../../packages/lina-runtime/src/fleet/manager.ts#L39), [세션 조립](../../../packages/lina-runtime/src/session-app.ts#L173) | 개인별 세션·저장소, 문맥·기억·성장·도구 연결 | 공통 구성점. 모이라이 회차 조정기와 Codex 역할 thread을 설치 |
| [실행 통제](../../../packages/lina-runtime/src/execution.ts#L50), [DurableRuntime](../../../packages/lina-runtime/src/runtime.ts#L20) | 요청·응답 기록, 실행 권한·취소·복구 | 확정된 판단을 실제 효과로 넘기는 Host. 판단 저장과 효과 저장 책임 구분 |
| [웹](../../../packages/lina-web/src/server.ts#L53), [Discord](../../../packages/lina-channels/src/discord-bridge.ts#L24) | 외부 입력·최종 응답 전달 | 채널. 내부 세 의견을 세 사용자 메시지로 전송하지 않음. Telegram은 현재 stub |
| [모델 서비스](../../../packages/lina-opencodex/src/services.ts#L323), [체크포인트](../../../packages/lina-runtime/src/checkpoint-cli.ts#L18) | 모델 라우팅과 전문 호출, 오프라인 상태 캡처·새 경로 복원 | 공통 인프라. D22에 따라 OpenCodex Hub의 카탈로그·계정 소유권과 `lina-opencodex` 어댑터를 유지하고 검증된 프리셋을 적용. checkpoint는 엔진 저장소를 기존 설치/복구 책임 아래 편입 |

현재 대화의 기본 경로는 `입력 → 개인 세션 → 문맥·페르소나·기억 조회 → LLM/도구 → 응답 정착 → 기억·성향 후처리`다. LIFE는 `사건/참여자 선택 → director → actor → 필요 시 target → Ensemble → reflection → 상태 확정`이다. 두 경로 모두 근거와 상태를 보존하지만, 세 관점이 공통 후보를 판단하는 제품 회차는 아직 없다.

별도 구현은 섞어 쓰지 않고 다음 기준으로 참조한다.

| 코드 기준 | 상태와 재사용 범위 |
| --- | --- |
| [현재 MoiraiProbe](../../../packages/lina-codex/src/moirai-probe.ts#L67) | Codex QA 전용 3판단+종합·이력 대조. 제품 채널·도메인 포트는 연결되지 않음. QA 코드를 제품 조정기로 복제하지 않음 |
| [PR #10 Senpi](https://github.com/thisisjun786/lina/blob/5b22aee53f9f7c01cc508289099f662aed613140/scripts/qa/senpi-sdk/README.md) | 병합된 비교용 SDK QA. `createAgentSession`·`ModelRuntime`·`SessionManager` 사용 예와 세션·취소·재개 검증. 역할 프롬프트는 이전 렌즈(라케시스=근거, 아트로포스=상황 선택)이므로 F2에서 정본의 목표로 재작성(D13) |
| [PR #8 채택 커널](https://github.com/thisisjun786/lina/blob/ab9f1f073eca80ecef8dda0b0f7d338f4d6cb35c/scripts/qa/adoption-kernel/types.ts#L24) | PR은 미병합 종료. `Purpose`·`Adoption(understanding \| plan \| intention)`·`Judgment(method, expectation)`·`ToolReceipt`·`ProposalAction(answer \| adopt \| tool \| defer \| noop)`의 의미를 정본의 `IntentionRecord`와 catalog v1로 이전. Frame·DB·독립 평가 통과는 전제하지 않음 |
| [PR #11 프롬프트 방법론](https://github.com/thisisjun786/lina/blob/25346f15287a96d7e95e8c3e07c51fff1899f66f/docs/plans/platform/014_model_tuning_methodology_research.md) | 병합된 방법론. 작성 순서·A/B/C 진단·비교 자동화·누출 점검을 정본 D20이 채택. 그 문서의 역할 표(라케시스=분석가, 아트로포스=결정자)와 "실행 엔진은 Codex" 문장, 030의 옛 anchor 링크는 병합 시 정본에 맞춰 갱신 필요 |
| PR #8 이후 로컬 검증 후보 `0cdfd43` | 프로세스 복구·실패 결과 검증을 추가한 별도 후보. 제품 의존성으로 채택하지 않고 후속 설계 때 공개 가능한 리비전과 결과를 다시 확인 |
| [PR #5 UI](https://github.com/thisisjun786/lina/pull/5) | 별도 UI·공통 client·Electron 구현. 인지 원본을 UI 패키지로 옮기지 않음. 엔진 완성 뒤 고도화 |

## LIFE와 기존 성향 계산의 전환

정본 D09에 따라 사건 발생과 개인의 행동 선택을 분리한다. 현재 `selectLifeEvent`는 욕구·목표·성향까지 반영해 사건/참여자를 뽑는다. 목표 구조에서는 World/LIFE가 시간·인과·장소·공개 범위·활동 가능 조건에서 상황과 참여 기회를 제공하고, 개인의 자발적 선택은 세 모듈과 모이라이 선택 정책이 담당하며 Host가 실행·기록한다. 기존 함수를 그대로 호출한 뒤 같은 성향으로 두 번째 선택을 하는 안은 채택하지 않는다.

후속 pack/step 버전에 `decisionMode: legacy | moirai`를 둔다. legacy 기록은 원래 알고리즘과 난수로 재현한다. moirai 모드의 기회 선택은 환경·인과·quiet·참여 일정 규칙을 사용하고, 기존 개인 욕구·목표·성향·습관 가중치는 개인 판단의 입력으로 옮긴다. 어느 사건이 외부에서 발생하고 어느 활동이 개인이 고르는 대상인지는 pack의 기회/행동 구분으로 선언한다. 같은 step에서 두 모드를 혼합하지 않는다. 전환 후 분포가 달라지는 것은 명시적인 정책 변경이며 과거 결과를 다시 추첨하지 않는다.

| 현재 LIFE 경로 | 목표 경로 |
| --- | --- |
| 사건/참여자 선택 | World의 기회 제시. 개인 선호로 행동을 확정하는 부분은 분리 |
| director | 상황 설명·공개 가능한 맥락 구성. 개인 의도 선택 권한 없음 |
| actor | 해당 개인의 모이라이 행동 회차로 교체 |
| target | 상대 개인의 별도 모이라이 수락/거절 회차. 원래 개인의 하위 투표로 처리하지 않음 |
| Ensemble | 작성 규칙의 가능 조건·사회적 의향·결과 서비스 유지. 의향 계산과 최종 행동/효과 적용 포트를 분리 |
| reflection | 세계 경험·믿음·허용 성장 해석 유지. 실제 결과를 공통 outcome 계약으로 전달 |
| publication·image | 게시 여부·내용 의도의 개인 선택은 모이라이, 공개 검사·렌더링·전송은 기존 owner |

Ensemble의 행동 그래프가 개인이 통제하는 서로 다른 행동을 선택한다면 그 terminal/binding을 공통 후보에 올리고 확정된 선택을 실행한다. 세계의 반응·상대의 결정·확률적 결과는 별도 결과로 기록한다. 최종 선택 뒤 Ensemble이 다른 개인 행동으로 바꿔 실행하는 경로는 허용하지 않는다. 전체 비공개 World 상태로 계산한 의향·예측값을 개인 판단에 넘기지 않으며, 숨은 조건은 공개 가능한 실패/불확실성 계약으로 처리한다.

성향 축은 D18에 따라 AgentStore의 `PersonaSchema`가 소유한다. 현재 NativePersonaGrowth는 LifeDefinition의 축에 의존하므로, 기존 값·범위·출처를 유지하는 전환이 선행해야 하며 숨은 기본 세계를 만들어 의존성을 감추지 않는다. 신경에서 투영된 성향을 다시 LIFE 가중치·Ensemble 의향·`p0`에 넣어 `b`와 합산하지 않는다.

## 후속 설계와 구현의 의존 순서

아래는 이후 작업의 지도다. core/runtime 접두사는 각각 `packages/lina-core/src/`, `packages/lina-runtime/src/`다. 각 단계의 성공은 파일 생성이나 QA runner 성공이 아니라 실제 제품 입력·계산 receipt·다음 회차의 변화·실행 결과·복구로 확인한다.

| 단계 | 변경 후보와 전후 차이 | 해당 단계에서 확인할 결과 |
| --- | --- | --- |
| F1 공통 계약·소유권 | core `agents/judgment*.ts`, `context/read-projection.ts`, `agents/behavior-types.ts`·`PersonaSchema`; catalog `personal.v1`과 policy revision 2. PR #14의 계약에 D23 보완 | 원본·지시·WorkingState revision 분리, 목표 참조·정책·대화/행동 기록의 복원, 출력 잘림 표시, 비실행 deferred, 과거 policy revision 1 재생. 공통 계약 구현은 제품 연결 완료를 뜻하지 않음 |
| F2 세 메커니즘·Codex·회로 | NEW runtime `cognition/install.ts`, `conversation.ts`, `prospect.ts`, `value.ts`, `continuity.ts`, `option-assessments.ts`, `arbitration-policy.ts`, `codex/session.ts`, `neural-preference/{port,client,store}.ts`, `prompts/{common,clotho,lachesis,atropos,moirai}.ts`; MODIFY 기존 `lina-codex` RPC·SessionPort 연결과 `session-app.ts`, `runtime.ts`, core `store.ts`; Python 계산 artifact와 회로 프로필 v1 | World 없는 한 개인의 세 판단+종합, catalog 행동 확정, MaleCNS 관측·조회·학습, 의도 유지·결과 환류·재시작. Codex 역할 격리·dynamicTools·approval·생성 토큰 예산·잘림·부분 평가 보완의 실제 제품 검사와 회로 qualified 검사 |
| F3 World/LIFE 행동 확장 | NEW 도메인 투영 포트(`projectConsequences`); EXTEND F2의 공통 후보·선택 정책을 LIFE catalog에 적용; MODIFY core `world/events.ts`, pack/step types·codecs·`autonomy-persistence.ts`, runtime `life/director.ts`, 사회 계산/실행 포트·게시/이미지 연결 | 사건 기회와 개인 선택 분리, legacy 재현, LIFE catalog의 선언된 조정 정책, 세 후보 평가·단일 선택·상대의 독립 결정·실제 owner 효과의 일치 |
| F4 성장·공개 범위·운영 | MODIFY BehaviorStore/Persona 투영, Fleet·후처리·모델 프리셋·scheduler·설치/checkpoint 소비자, AGENTS/README; NEW `scripts/qa/moirai-evals/` Codex 비교 harness와 고정 검증군; 기존 OpenCodex 모델 소비자에 검증 프리셋 경계 적용 | 성향 중복 가산·비밀 scope 유출 없음, 8명 비동기·RAM/VRAM/지연·다중 저장소 복원·Python/Codex 프로세스 장애 검사, D20 첫 개선 루프 완주. Codex/OpenCodex를 유지한 설치본에서 대화·작업·프로바이더 연결 검증 |

F1에서 의미·정체성·공개 범위와 중복 반영 방지를 먼저 정한다. F2에서 별도 `agentState`로 신경 반응을 제공하더라도 기존 성향과 겹치는 dimension은 제외하거나 생성자 전환을 함께 수행한다. F4까지 근거·격리 검사를 미루지 않는다. 프리셋의 역할·티어·입력/출력 계약도 F2의 실제 Codex 전송에 적용하고 F4에서 운영 전환을 검증한다. 030의 이전 R 번호는 이 지도에 대응시키며 별도 개발 루프로 실행하지 않는다.

새 필드의 후속 구현은 생성 → 직렬화 → 역직렬화/이전 값 → 모든 소비자를 함께 명시한다. `ObjectiveProfile`·`ResolutionRecord`·`SelectionSpec`·`DialogueJudgmentRef`·`IntentionRecord`는 생성·판단 입력·캐시 key·ledger·복원·종합 소비자를 함께 연결한다. `decisionMode`는 pack/설정 입력·builder, 저장 schema/step digest, codec·legacy decoder, 사건 선택·director·재생·UI 상태 소비자까지 포함한다. `NeuralProjectionRef`는 생성·DB/manifest·복원·Persona/LIFE 소비자 전부를, Codex thread/turn 식별자는 생성·binding 저장·재개·취소·usage 소비자를 대조해야 한다.

F1의 `Purpose`·`Understanding`·`Plan` 의미와 typed Forecast/Claim, `NeuralProjectionRef`의 회로 상태·학습 revision 결합은 아직 부분 계약이다. 원래 기능을 삭제하지 않으며 F2 메커니즘을 연결하기 전에 생성·저장·복원·소비자를 완성한다. AgentStore의 PersonaSchema 권위와 기존 데이터 이전은 아래 F4 범위를 따른다.

## 확정된 결정과 남은 산출물

이전 초안의 미정 항목은 정본의 [D13–D19](../../MOIRAI_ENGINE.md#확정된-결정-목록)로 확정했다. 남은 것은 결정이 아니라 산출물이다.

| 이전 미정 항목 | 확정 | 남은 산출물과 단계 |
| --- | --- | --- |
| 개인의 첫 행동 catalog | D15 `personal.v1` | F1: schema·정규화 규칙·전제/효과 필드의 코드 정의. F2: TaskManager·JudgmentStore effect 연결 |
| 기회/행동 분류 | D09 원칙, LIFE catalog는 F3 선언 | F3: 기존 LIFE pack 전체의 family·actor·terminal 분류와 분포 변화 기록 |
| 의도의 최소 schema | D16 `IntentionRecord` v1 | F1: 직렬화·전이 검증. F2: 약속·자율 목표의 충돌·완료·철회 시나리오 |
| 성향 축의 소유권 | D18 AgentStore `PersonaSchema` | F1: schema 정의. F4: 기존 Behavior receipt·projection의 데이터 이전 |
| 회로/의미 인터페이스 | D14 회로 프로필 v1 | F2: body 목록·부호·상수·해시 추출, encoder/readout 구현, `qualified` 검사 |
| 목표별 판단·종합 정책 | D17 `personal.v1` 조정 정책 | F1: policy revision 2와 revision 1 과거 재생. F2: ResolutionRecord/SelectionSpec 재현 검증. 효용 비교는 아래 가설 |
| 제품 세션·저장 경계 | D19 저장소 셋과 Python 계산기 하나 | F2: JudgmentStore·NeuralPreferenceStore·outbox/inbox·checkpoint manifest 편입 |
| 프롬프트 작성·개선 | D20 프롬프트 자산·다섯 층·8단계 루프 | F2: 자산 revision·층 해시·wire 검사. F4: 비교 harness·독립 judge·고정 검증군·첫 루프 완주 |
| 개발 작업 실행 엔진·프로바이더 관리 | D22 Codex app-server + OpenCodex | F2: 기존 어댑터의 역할·도구·승인·예산·재개 실검사. F4: 기존 데이터 보존과 검증 프리셋·새 엔진 저장소의 설치/복구 검사 |

다음 작업은 정본 → 016 → 이 문서 → 030 순서로 읽고, PR #14와 D22·D23의 F1 보완을 확인한 뒤 F2 계약과 연결을 구현한다. 판단을 바꿀 때는 D 번호와 이유를 남기고 연관 계약도 함께 갱신한다. F2 제품 구현·실모델 검증은 해당 작업의 범위에서 수행한다.

## 검증할 가설과 반례

| 가설 | 개입과 관찰 | 실패하면 다시 볼 설계 |
| --- | --- | --- |
| 각 모듈이 고유 목표로 추천 | 같은 사실·후보에서 미래 성과·선호 충족·약속 유지가 충돌하는 사례와 일치하는 사례를 대조. 목표별 추천·이득/손실·종합 시 양보 추적 | 모두 같은 목표를 최적화하거나 차이를 강제하면 목표 프로필·평가·종합 연결 재설계 |
| 경험이 이후 판단을 개선 | 예측과 실제 결과, 같은 활동의 상반된 경험, 완료·불가능한 목표를 다음 회차에 공급 | 저장은 됐지만 잘못된 방법 반복 시 기억 조회·적용 조건·결과 귀속 점검 |
| 선택이 개인 상태를 반영 | 동일 후보·기준 정책에서 개인 가중치 교환/차단, 후보 순서·동의어·중복 변화 | encoder/readout·후보 수만 효과를 설명하면 회로 기여 주장 철회 |
| 지속성이 상황 적응과 공존 | 재시작·새 모델에서도 약속 유지, 원래 전제 철회 시 재고 | 고착 또는 무근거 취소가 반복되면 의도 전이·수락 규칙(D16) 수정 |
| 조정 정책이 상황을 구분 | 같은 후보를 `user_request`·`autonomous`·`transition`으로 돌려 순서·`λ`가 선언대로 적용되는지, 약속 보호가 취향 반대와 구분되는지 | 상황 판정이 LLM에 끌려가거나 약속 보호가 우회되면 D17 재설계 |
| 통합이 선택을 중복하지 않음 | 동일 event/dimension을 성장·LIFE·Ensemble·신경 경로로 추적하고 selected/finalized/executed 비교 | 다른 행동 재선택·중복 편향·가짜 성공 피드백은 통합 결함 |
| 실패에도 결과를 정직하게 유지 | 신경 장애는 명시적 무변조, 필수 판단 누락은 보류, source 철회는 무효화, unknown 효과는 reconcile | 누락을 중립/성공으로 대체하거나 재추첨하면 해당 경계 수정 |

같은 고유 목표를 가진 구조화된 세 모듈과 프롬프트 3+1을 비교해 메커니즘 기여를 확인한다. 고유 목표의 기여는 동일 목표를 반복하는 3+1과 별도로 비교한다. 또한 같은 총자원의 단일 에이전트 재검토를 비교한다. 회로의 추가 기여는 일반 순환망·문맥 밴딧·재배선 조건과 별도로 비교한다. 외부 결과·목표 지속·선호 수정·총비용을 평가하고 모델의 자기보고나 합의율만으로 성공을 정하지 않는다. 비교는 제품 방향을 개선할 근거이며 제품 개발의 유일한 산출물로 한정하지 않는다.
