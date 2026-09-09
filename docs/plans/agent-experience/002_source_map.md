# 핵심 경험 순환의 소스 지도

기준 소스: PR7 `329b6cb002deeabba3684e25dd9b45149dd59b0d`. 아래 경로와 줄 번호는 이 Git 객체의 것이다. 현재 작업 사본이나 미래 PR head의 줄 번호로 읽지 않는다. 소스·설계 문서의 읽기 검토이며 기능 실행·모델 품질·배포를 검증한 결과가 아니다.

## 구조 지도

```text
lina-runtime/session-app
  ├─ context/hooks → ContextCoordinator → ContextStore
  ├─ CompanionMemory → journal + EngineStore → MemoryConsolidation
  │                                      └→ NativePersonaGrowth → AgentStore.behavior
  ├─ persona/hooks → composePersonaPrompt ← 현재 허용된 공통 성향
  └─ world context → 용도별 recall / currentPersona

lina-runtime/life/runner → director / WorldStore.prepare·accept
lina-runtime/life/work-bridge ← lina-codex 작업 결과·outbox
                            → WorldStore.admitWorkInput
```

상위 조립과 실행 흐름은 `lina-runtime`, 원본 데이터의 검증·저장은 각 domain owner, Codex RPC는 `lina-codex`, 모델 라우팅은 `lina-opencodex`가 맡는다. 새 설계에서도 이 방향을 유지한다. `lina-core`나 `lina-memory`가 runtime coordinator를 import하는 방향은 만들지 않는다.

영향 범위는 한 파일이 아니라 런타임·기억·개인 성장·세계·작업이 만나는 패키지 간 경계다. 이번 설계는 공개 export, HTTP 경로, Codex 도구 이름 또는 저장 스키마를 변경하지 않는다.

## 코드에서 확인한 연결

| 기능 | 고정 소스 근거 | 설계에 주는 제약 |
| --- | --- | --- |
| 대화 관찰 후 추론·성장 호출 | [companion.ts:316](https://github.com/thisisjun786/lina/blob/329b6cb002deeabba3684e25dd9b45149dd59b0d/packages/lina-runtime/src/context/companion.ts#L316) | 기존 수명 안에서 관찰→consolidation→personaGrowth를 실행함. 별도 동일 목적 타이머를 추가하지 않음 |
| 성장 생산자와 일반 대화 연결 | [session-app.ts:355](https://github.com/thisisjun786/lina/blob/329b6cb002deeabba3684e25dd9b45149dd59b0d/packages/lina-runtime/src/session-app.ts#L355) | NativePersonaGrowth를 생성하고 installPersona에 currentPersona와 nativeState를 전달함 |
| 현재 성장 입력의 제한 | [growth-source.ts:18](https://github.com/thisisjun786/lina/blob/329b6cb002deeabba3684e25dd9b45149dd59b0d/packages/lina-runtime/src/persona/growth-source.ts#L18) | supported 상태의 self interest/preference만 해당 경로에 들어감. 일반 능력·기분·관계 해석을 이미 지원한다고 할 수 없음 |
| 세계 정의가 없을 때 성장 중단 | [native-growth.ts:35](https://github.com/thisisjun786/lina/blob/329b6cb002deeabba3684e25dd9b45149dd59b0d/packages/lina-runtime/src/persona/native-growth.ts#L35) | 정의·profile·adaptive·memory 조건이 없으면 해당 성장 생산자가 반환함. 모든 대화의 성장과 동일시하지 않음 |
| 근거 현재성 확인 | [growth-source.ts:28](https://github.com/thisisjun786/lina/blob/329b6cb002deeabba3684e25dd9b45149dd59b0d/packages/lina-runtime/src/persona/growth-source.ts#L28) | ID뿐 아니라 원본 내용·권한·profile·definition의 현재성을 검사함 |
| 과거 성장 receipt의 적격 투영 | [behavior-store.ts:271](https://github.com/thisisjun786/lina/blob/329b6cb002deeabba3684e25dd9b45149dd59b0d/packages/lina-core/src/agents/behavior-store.ts#L271) | 부적격 근거의 값을 제거하는 기존 소유자를 유지해야 함 |
| 공통 성향을 실제 프롬프트에 반영 | [persona.ts:267](https://github.com/thisisjun786/lina/blob/329b6cb002deeabba3684e25dd9b45149dd59b0d/packages/lina-core/src/agents/persona.ts#L267) | currentPersona의 worldView와 composedBehavior를 사용함. ‘엔진들이 전혀 연결되지 않았다’는 출발점은 틀림 |
| 발송 전 인격·근거 검사 | [persona/hooks.ts:107](https://github.com/thisisjun786/lina/blob/329b6cb002deeabba3684e25dd9b45149dd59b0d/packages/lina-runtime/src/persona/hooks.ts#L107) | 입력 합성 이후 근거 변경을 새 공통 캐시가 가려서는 안 됨 |
| recall과 실제 context 직렬화 | [context/hooks.ts:13](https://github.com/thisisjun786/lina/blob/329b6cb002deeabba3684e25dd9b45149dd59b0d/packages/lina-runtime/src/context/hooks.ts#L13) | before_agent_start와 context hook의 기존 소비 경로를 추적해야 함 |
| 일반 대화의 세계 공개 제한 | [world.ts:80](https://github.com/thisisjun786/lina/blob/329b6cb002deeabba3684e25dd9b45149dd59b0d/packages/lina-runtime/src/world.ts#L80) | shared-growth 노출과 명시적 world recall이 분리됨. 단일 관점은 단일 공개 범위가 아님 |
| LIFE 준비·현재성·확정 | [life/runner.ts:159](https://github.com/thisisjun786/lina/blob/329b6cb002deeabba3684e25dd9b45149dd59b0d/packages/lina-runtime/src/life/runner.ts#L159) | prepareLifeStep, guard, acceptLifeStep 및 terminal replay를 새 조정자가 우회하지 않음 |
| 작업 결과를 LIFE로 전달 | [life/work-bridge.ts:41](https://github.com/thisisjun786/lina/blob/329b6cb002deeabba3684e25dd9b45149dd59b0d/packages/lina-runtime/src/life/work-bridge.ts#L41), [동기 검증 경계:82](https://github.com/thisisjun786/lina/blob/329b6cb002deeabba3684e25dd9b45149dd59b0d/packages/lina-runtime/src/life/work-bridge.ts#L82) | receipt ID·버전·참가자·권한·수정 근거를 가진 허용된 입력만 전달함 |
| 추론 전제의 적격성과 순환 방지 | [reasoning.ts:101](https://github.com/thisisjun786/lina/blob/329b6cb002deeabba3684e25dd9b45149dd59b0d/packages/lina-memory/src/engine/reasoning.ts#L101) | 일반적 의미 평가가 기존 근거 검증을 대체하지 않음 |

소유권 설명은 [개인 성장 투영 계약](https://github.com/thisisjun786/lina/blob/329b6cb002deeabba3684e25dd9b45149dd59b0d/docs/plans/context-engines/031_persona_projection.md#L5)과 대조했다. 초기 030 문서와 충돌하면 031의 구체화된 계약을 읽는다. 미래 기능을 설명한 오래된 문서의 시제보다 현재 코드와 적용되는 상세 계약을 우선한다.

## 기존 연결과 필요한 계약

이미 존재하는 것은 관찰·추론·제한된 개인 성장·프롬프트 투영, LIFE의 준비·확정·복구, 작업 결과의 세계 전달이다. 이를 하나의 순환으로 부르는 것만으로 새 기능이 생기지는 않는다.

핵심 계약은 **직접 결과와 품질 근거에서 얻은 조건부 이해가 실제 후속 선택에 소비되는 연결**이다. 당시 목적·방법·예상, 주체 역할·영역·원경험, 정정 수락 시점, 미완료 의무의 복원도 함께 필요하다. 정확한 저장 타입과 소비 API는 확인 전이며, 기존 코드가 이미 이 계약을 충족하는지도 첫 사례에서 판별한다.

범용 coordinator·통합 cycle DB·일반 목표 저장소는 전제하지 않는다. 조건부 이해가 기존 기록에서 계산 가능하면 투영을 사용한다. 보존 자체는 필수이며, 재시작 뒤 근거와 당시 판단을 복원할 수 없다면 해당 소유자에 최소 기록이 필요하다.

## 직접 결과와 복구의 확인 범위

| 고정 소스 | 확인한 내용 | 설계에 적용할 경계 |
| --- | --- | --- |
| [companion.ts:404](https://github.com/thisisjun786/lina/blob/329b6cb002deeabba3684e25dd9b45149dd59b0d/packages/lina-runtime/src/context/companion.ts#L404) | 관찰 입력을 첫 사용자 발언과 최종 assistant 답변으로 제한 | 이 경로만으로 작업 영수증·품질 검증이 직접 학습 근거가 된다고 보지 않음 |
| [companion.ts:296](https://github.com/thisisjun786/lina/blob/329b6cb002deeabba3684e25dd9b45149dd59b0d/packages/lina-runtime/src/context/companion.ts#L296) | 학습 비활성화 시 반환 | 필수 정정을 선택적 학습에만 연결하지 않음. 전체 정정 경로의 부재를 뜻하지 않음 |
| [companion.ts:322](https://github.com/thisisjun786/lina/blob/329b6cb002deeabba3684e25dd9b45149dd59b0d/packages/lina-runtime/src/context/companion.ts#L322) | queue reconciliation은 mind·preferences receipt를 확인하고 성장 오류는 따로 기록 | 이 queue의 완료를 모든 새 후속 처리의 완료로 재사용하지 않음 |
| [work-bridge.ts:129](https://github.com/thisisjun786/lina/blob/329b6cb002deeabba3684e25dd9b45149dd59b0d/packages/lina-runtime/src/life/work-bridge.ts#L129) | 세계 입력 수락 후 원본 현재성을 확인하고 전달 acknowledge | 세계 수락과 개인 해석 완료를 구별 |

이들은 확인한 경로의 제약이다. 다른 경로를 포함한 PR7 전체의 런타임 결함이나 복구 실패를 판정한 결과는 아니다.

## 구현 전 조사

조사의 우선 범위는 **전체 채택 상태의 쓰기·도구 실행·최종 발송 진입점과 그 능력을 보유한 객체**다. 생산자는 제안을 내고 trusted host의 효과 포트가 기존 owner 검증을 거쳐 확정하도록 전환할 수 있는지 확인한다. 세계 정의 없는 에이전트의 방법 이해 사례는 이 계약의 검증 수단이며 전체 범위를 제한하지 않는다. 기존 성장 생산자의 세계 의존 조건도 일반 핵심 기능의 전제로 사용하지 않는다.

| 조사 대상 | 확정해야 할 답 | 보존할 책임 |
| --- | --- | --- |
| 작업 결과 생산·조회 경로, `packages/lina-runtime/src/life/work-bridge.ts`의 입력 계약 | 당시 판단·시도·수행 역할·원본 결과·별도 품질 근거를 세계 경유 없이 읽을 실제 API | 실행 소유권·영수증·현재성. task 생산자 위치는 추가 확인 |
| `packages/lina-runtime/src/context/companion.ts`, `packages/lina-memory/src/engine/types.ts`, `packages/lina-memory/src/engine/store.ts` | 조건부 해석의 표현·근거·적격성·정정 수락, 미소비 결과의 재열거와 소비 완료 저장 | 메모리 원본·출처·기존 queue. 구체 타입의 수용 여부는 추가 확인 |
| `packages/lina-runtime/src/session-app.ts`, `packages/lina-runtime/src/context/hooks.ts` | 후속 작업의 실제 판단 입력에 포함·생략을 기록할 위치와 입력 의존 집합 | 세션 수명·컨텍스트 예산·용도별 공개 범위 |
| `packages/lina-runtime/src/persona/hooks.ts`, `packages/lina-runtime/src/world.ts` | 확장 시 정정된 근거를 발송 직전 재검증하고 허구 공개 범위를 지킬 경계 | 현재 persona 투영·발송 권한 |
| `packages/lina-runtime/src/persona/native-growth.ts`, `packages/lina-core/src/agents/persona.ts`, `packages/lina-runtime/src/life/runner.ts` | 확장 시 원경험의 이중 기여와 철회된 값의 부활을 막을 계약 | 첫 단위에서 의미 변경 없음. 관심·선호 성장과 LIFE 복구 유지 |

이 표는 조사 범위이며 patch list가 아니다. 실제 변경 전후 코드·직렬화·복원·소비 경로를 확정한 뒤 구현 대상을 고른다. 후속 아키텍처 문서 반영도 구현 상태에 맞춰 수행한다. 기획 위치는 [제품 계획](../../PLANNING.md)에 연결한다.

## 근거의 한계

정적 호출과 소유권을 확인했다. 전체 TaskManager/outbox 생산자, 기억 타입의 확장 가능성, 실제 입력에서의 선택 품질, 프로세스 중단·재시작, 장기 동작은 아직 검증하지 않았다. 조건별 실험은 [핵심 설계의 수용 기준](001_design.md#수용-기준)을 따른다. 프롬프트에 정보가 들어간다는 사실만으로 적절한 행동 변화나 주관적 경험을 주장하지 않는다.
