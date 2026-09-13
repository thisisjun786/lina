# 018 — 페르소나 고정·성장 작성 계약

상태: 2026-09-14. 이 문서는 페르소나 작성자가 "무엇을 고정으로 적고 무엇을 성장에 맡기는가"를 판단하는 계약을 소유한다. 확인한 소스는 `c5e9810`이다. 타입·포트·저장·복구는 [016 계약](016_neural_preference_contract.md), 구현 순서는 [017 로드맵](017_moirai_module_composition.md), 성장 해석과 합성은 [031 성장 투영](../context-engines/031_persona_projection.md), 프롬프트 조립 영역과 예산은 [PERSONA_CONTEXT](../../PERSONA_CONTEXT.md)가 계속 소유한다. 여기서는 그 계약들이 이미 정한 것을 다시 적지 않는다.

## 상태와 범위

F1에서 확정하는 것은 의미와 작성 형식이다. 층의 우선순위, 고정·성장의 선언 방법, 각 필드의 소유자, 불완전한 입력의 처리, 작성에서 소비까지의 연결 지도를 정한다.

F1에서 확정하지 않는 것은 배선이다. 개인별 잠금 목록을 담을 저장 필드, 그 값을 읽는 정체성 자료 생성기, `NativePersonaGrowth`가 `LifeDefinition` 대신 schema를 읽는 전환, 기존 성장 데이터의 이전은 모두 후속 작업이다.

이 문서를 확정해도 개별 캐릭터의 성격·잠금·수치가 정해지지 않는다. 아래 예시는 구조를 검증하기 위한 것이고 실제 인물 설정이 아니다.

## 층 모델과 우선순위

한 개인의 현재 행동은 여러 층이 겹쳐 만들어진다. 위 행이 아래 행을 이긴다. 아래 층은 위 층을 다시 쓰지 못한다.

| 층 | 내용 | 현재 소유 타입 | 근거 |
| --- | --- | --- | --- |
| 잠금과 권한 | `evolution`과 축별 잠금이 성장을 막고, 공개 허용 목록은 공유·투영 범위를 정한다. 역할이 다르다 | [`IdentityProfilePolicy`](../../../packages/lina-core/src/world/life-types.ts#L121), [`ProjectionPolicy`](../../../packages/lina-core/src/world/life-types.ts#L38) | [manual 단락](../../../packages/lina-core/src/agents/persona.ts#L96), [성장 차단](../../../packages/lina-core/src/world/growth.ts#L40), [사회 효과 차단](../../../packages/lina-core/src/world/social-effect-state.ts#L127) |
| 작성 정체성 | 이름·역할·성격·말투·전기·외형·관심사, 확정된 온보딩 장(가치·기질·관심·관계·표현), 대화 방식과 예시 | [`AgentProfile`](../../../packages/lina-core/src/agents/types.ts#L3), [확정 장](../../../packages/lina-core/src/onboarding/types.ts#L3), [대화 설정](../../../packages/lina-core/src/agents/conversation.ts#L26) | [핵심 권위 문구](../../../packages/lina-core/src/agents/persona.ts#L38), [세 출처를 함께 렌더링](../../../packages/lina-core/src/agents/persona.ts#L167) |
| 검증된 성장 | 근거가 확인된 현재 성향 값 | [`SharedPersonaView`](../../../packages/lina-core/src/world/views.ts#L253), 개인 투영 | [공유 성향 권위 문구](../../../packages/lina-core/src/agents/persona.ts#L53) |
| 초기 기질 | 축별 시작값 | [`PersonaDimension.initial`](../../../packages/lina-core/src/agents/persona-schema.ts#L43) | 같은 문구가 초기 기질을 "출발점"으로 규정 |
| 일시 상태 | 기분과 최근 관심·선호·관계 메모 | [`Dynamics`](../../../packages/lina-core/src/agents/types.ts#L19) | [변동 맥락 문구](../../../packages/lina-core/src/agents/persona.ts#L48) |

검증된 성장은 **자기가 올라간 축에서만** 초기 기질을 대체한다. 작성 정체성의 성격 문장은 숫자로 대체되지 않는다. 두 가지가 모두 "작성한 것"이지만 성격은 표현의 기준이고 초기 기질은 축의 시작값이다.

작성 정체성은 한 곳에서 오지 않는다. `corePrompt`는 `AgentProfile` 필드와 대화 방식·예시, 확정된 온보딩 장을 한 블록에 렌더링하고 그 전체를 완전한 작성 정체성이라고 선언한다([조립 지점](../../../packages/lina-core/src/agents/persona.ts#L167)). 대화 설정은 ConversationStore에서, 확정 장은 OnboardingStore에서 온다([훅 배선](../../../packages/lina-runtime/src/persona/hooks.ts#L65), [확정 장 공급](../../../packages/lina-runtime/src/fleet/manager.ts#L355)). 셋 다 작성물이고 학습이 덮어쓰지 못한다.

층 안의 순서는 이렇다. `AgentProfile` 필드가 안정된 기준점이다. 확정 장은 덧붙인 작성 설정이며 겪은 일이 아니다([표시 문구](../../../packages/lina-core/src/agents/persona.ts#L186)). 대화 예시는 허구의 문체 참고여서 현재 요청과 정한 말투보다 뒤에 온다([예시 표시](../../../packages/lina-core/src/agents/persona.ts#L160)).

## 명시적 대화 선호의 범위

사용자가 직접 말한 대화 선호는 위 순서에 끼워 넣지 않는다. 적용 범위가 다르기 때문이다.

이 선호는 사용자에게 말을 거는 방식에만 적용되고 에이전트의 정체성·권한·잠긴 축을 바꾸지 않는다. 같은 항목에 새 요청이 오면 이전 요청을 대체하고, 현재 대화의 지시가 저장된 선호보다 앞선다. 실행 중인 문구가 이미 그렇게 되어 있다([대화 선호 지침](../../../packages/lina-runtime/src/persona/conversation.ts#L59)).

학습된 사용자 자료는 참고이며 페르소나 권위가 아니다. 계층별 전달·수명·충돌 처리의 전체 표는 [PERSONA_CONTEXT의 입력 계약](../../PERSONA_CONTEXT.md#lina의-정규화된-입력-계약)이 소유한다. 두 문서가 함께 뒷받침하지 않는 전면적인 순서는 여기서 단정하지 않는다.

## 고정과 성장의 선언

"고정"과 "성장"은 새 개념이 아니라 기존 두 가지의 조합이다.

`evolution`이 `manual`이면 그 개인의 성장이 전부 막힌다. 공유 축만이 아니라 비공개 축의 LIFE 성장도 거부된다([성장 정책](../../../packages/lina-core/src/world/life-transition.ts#L294)). `adaptive`이면 축별 잠금 목록에 적힌 축만 잠긴다. 나머지 축은 변할 자격이 생길 뿐이고 실제로 변한다는 보장은 아니다. 각 경로가 근거·범위·현재성 검사를 따로 건다. 판정 순서는 manual이 먼저다([`lockedFor`](../../../packages/lina-core/src/agents/persona-schema.ts#L289)).

프롬프트 산문은 강제력이 없다. 성격 문장에 "쉽게 변하지 않는다"라고 적어도 잠기지 않고, "경험에 따라 달라진다"라고 적어도 잠긴 축이 열리지 않는다. 강제는 위 표의 잠금과 권한 층이 한다.

## 필드 소유권

세 가지를 구분해서 읽어야 한다.

**현재 생산자.** 축의 id·label·범위·기본 시작값과 공개 허용 목록은 [`LifeDefinition`](../../../packages/lina-core/src/world/life-types.ts#L45)이 제공한다. 성장 제어 설정 중 개인별로 실재하는 필드는 [`AgentProfile.evolution`](../../../packages/lina-core/src/agents/types.ts#L13) 하나다. 축별 잠금 목록은 저장된 값이 아니라 Fleet가 `evolution`에서 합성한다([생성 지점](../../../packages/lina-runtime/src/fleet/life-runtime.ts#L78)). `source`는 파생이 `reflection`으로 고정한다([고정 지점](../../../packages/lina-core/src/agents/persona-schema.ts#L328)).

**의도된 소유권.** [D18](../../MOIRAI_ENGINE.md#확정된-결정-목록)대로 `PersonaSchema`의 소유자는 AgentStore다. World는 자기 축을 schema의 dimension에 대응시킨다. 이 절이 D18을 바꾸지 않는다.

**미구현 저장.** 개인별 잠금 목록과 `source`를 담을 저장 필드는 아직 없다. 그래서 현재 제품에서는 개인별 선택 잠금을 작성할 방법이 없고, 실질적으로 전부 잠그거나 전부 여는 두 선택만 가능하다. 이 배선은 후속 작업이다.

## 작성 입력과 검증

작성자가 개인별로 정하는 값은 `evolution`과 축별 잠금 목록 세 개다.

잠금 id는 어느 세계 정의의 축인지와 함께 읽어야 한다. 축 id는 세계마다 정의되고 전역 이름공간이 없어서([축 정의](../../../packages/lina-core/src/world/life-types.ts#L26)), 한 세계에서 유효한 잠금이 다른 세계에서는 이름만 같은 다른 축을 잠글 수 있다. 그래서 검사는 세계 단위로 한다. 표현 방식은 아래 미해결 항목이고, 그전까지 작성자는 선택 잠금 초안에 어느 세계·정의의 축인지 함께 적고 다른 세계로 옮겨 쓰는 이식 가능한 개인 정책으로 취급하지 않는다. 소유권은 AgentStore에 둔다.

아래 두 가지는 **작성 경계에 요구하는 규칙이며 현재 구현된 동작이 아니다.** 없는 잠금 id는 거부해야 하지만 지금 파서는 정의를 인자로 받지 않고 그대로 통과시킨다([현재 파서](../../../packages/lina-core/src/world/identity-policy.ts#L67)). 잠금 목록을 생략하면 빈 목록으로 읽어야 하지만 지금은 파싱이 실패한다([목록 파서](../../../packages/lina-core/src/world/life-json.ts#L31)). 참여자 확인은 이미 거부한다([참여자 검사](../../../packages/lina-core/src/agents/persona-schema.ts#L310)).

빈 잠금 목록은 "아직 안 정함"이 아니라 "추가로 잠근 축이 없다"는 뜻이다.

**공개 허용 목록으로 성장을 막지 않는다.** 두 장치는 보는 곳이 다르다. 네이티브 개인 성향 해석은 허용 목록으로 대상 축을 고르고 목록 밖 축의 출력을 거부하지만 축별 잠금은 읽지 않는다([selector 구성](../../../packages/lina-runtime/src/persona/native-growth.ts#L51), [출력 검사](../../../packages/lina-core/src/agents/behavior-validation.ts#L275)). 반면 LIFE의 성장 검증·적용과 사회 효과는 `evolution`과 잠금만 보고 허용 목록을 보지 않는다([성장 검증](../../../packages/lina-core/src/world/growth.ts#L40), [전이 적용](../../../packages/lina-core/src/world/life-transition.ts#L294), [사회 효과](../../../packages/lina-core/src/world/social-effect-state.ts#L127)). LIFE 회고에 넘기는 자기 성향에도 허용 목록 필터가 없다([회고 입력](../../../packages/lina-core/src/world/autonomy-views.ts#L221)). 그래서 허용 목록에서 뺀 축도 LIFE 경로로는 계속 변할 수 있다. 비공개이면서 성장하는 축은 정상 조합이다.

`source`는 AgentStore의 owner 설정이며 현재는 `reflection` 하나만 쓴다. [`DIMENSION_SOURCES`](../../../packages/lina-core/src/agents/behavior-types.ts#L176)에 `neural`이 선언돼 있지만 [형태만 선언된 후속 대상](../../../packages/lina-core/src/agents/behavior-types.ts#L183)이다. 작성 표면은 [016의 상태 소유권 절](016_neural_preference_contract.md#상태-소유권과-공개-범위)과 함께 F2에서 정한다.

개인 성향 값을 담는 두 번째 수정 가능한 원본은 만들지 않는다. 잠금은 정책이고 값이 아니다. 값은 계속 receipt와 세계 상태로만 흐른다.

## 근거와 공개 범위

근거는 작성하는 항목이 아니다. 성향이 왜 그 값인지는 해석 receipt와 사건 id가 만든다([성장 근거 검사](../../../packages/lina-core/src/world/growth.ts#L44)). 작성자가 항목마다 근거 문장을 적지 않는다.

공개 범위도 항목별로 적지 않는다. 어떤 축을 공유하는지는 `projection`의 허용 목록이, 무엇을 드러낼지는 그 정책의 공개 항목이 소유한다. 파생은 허용 목록에 있는 축만 schema에 넣는다([필터 지점](../../../packages/lina-core/src/agents/persona-schema.ts#L321)). 허용 목록은 공유·투영 범위와 네이티브 해석의 대상을 정할 뿐 LIFE 전체의 성장 금지 정책을 대신하지 않는다.

## 불완전 입력의 의미

정체성 자료가 온전하지 않은 다섯 경우를 구분한다.

| 경우 | 처리 | 뜻 |
| --- | --- | --- |
| 자료를 아예 주지 않음 | 허용. 참조한 프로필이 없다고 기록하고 전 축을 잠그지 않음 | "정책을 조회하지 않았다". 이 결과는 성장·사회 입력으로 쓰지 않는다 |
| 자료는 줬는데 대상 개인이 없음 | **거부** | 자료 오류다. 정책 부재로 접지 않는다 |
| `adaptive`, 잠금 목록 비어 있음 | 허용. 추가로 잠근 축이 없음 | "이 개인에게 더 잠글 축은 없다". 변화의 발생을 보장하지는 않는다 |
| `manual` | 허용. 잠금 목록과 무관하게 전 축 잠금 | "고정" |
| 프로필 revision이 성장 기록 이후 바뀜 | 아래 참조 | 관찰되는 것만 기록한다 |

두 번째 경우를 거부하는 이유는 형제 소비자가 이미 그렇게 하기 때문이다. [LIFE 공유 투영](../../../packages/lina-core/src/world/views.ts#L252), [현재 페르소나 투영](../../../packages/lina-core/src/world/views.ts#L416), [성장 적용](../../../packages/lina-core/src/world/growth.ts#L34), [사회 효과 규칙](../../../packages/lina-core/src/world/autonomy-rules.ts#L208)이 모두 대상 프로필이 없으면 실패한다. 제공된 자료는 참여자 전원에 대한 주장이므로 대상이 빠진 것은 부재가 아니라 결함이다. 운영 생산자도 참여자 전원을 넣거나 그 전에 실패한다([참여자 수집](../../../packages/lina-runtime/src/fleet/life-runtime.ts#L71)).

revision이 바뀐 경우는 현재 관찰되는 것만 적는다. 파생은 호출자가 준 revision을 그대로 쓰고, 참조한 프로필 revision만 남긴다([기록 지점](../../../packages/lina-core/src/agents/persona-schema.ts#L372)). 프로필을 갱신해도 schema를 다시 파생하는 경로는 없다. 그 뒤 그 schema를 새로 파생할지, 현재 투영에서 뺄지, 재생 전용으로 읽을지는 아직 정하지 않았다. 다른 owner에 비슷한 선례가 있지만([receipt 적격성](../../../packages/lina-core/src/agents/behavior-store.ts#L284), [투영 revision 대조](../../../packages/lina-core/src/agents/persona.ts#L72)) 그 규칙을 `PersonaSchema`로 옮기지 않는다.

## 작성에서 소비까지의 연결표

| 단계 | 현재 | 확인 위치 | 남은 일 |
| --- | --- | --- | --- |
| 작성 입력 | `evolution`만 지정 가능. 축별 잠금을 적을 입력이 없고 온보딩은 `evolution`을 작성 대상에서 제외 | [프로필 검증](../../../packages/lina-core/src/agents/validation.ts#L111), [온보딩 제외](../../../packages/lina-runtime/src/fleet/intro-prompt.ts#L32) | 잠금 입력 추가 |
| 저장 | `agent_profiles`에 `evolution` 열. 잠금 열 없음 | [schema](../../../packages/lina-core/src/agents/agent-schema.ts#L11) | 잠금 저장 추가 |
| 정체성 자료 | `evolution`에서 전 축 또는 빈 목록을 합성 | [생성 지점](../../../packages/lina-runtime/src/fleet/life-runtime.ts#L78) | 저장된 잠금을 읽도록 전환 |
| `PersonaSchema` 파생 | 허용 축에 `initial`·범위·`locked`·`source` 부여 | [파생 함수](../../../packages/lina-core/src/agents/persona-schema.ts#L301) | 제품 호출자 지정 |
| 일반 대화 | manual이면 비우고 아니면 검증된 현재 값을 투영 | [투영 경계](../../../packages/lina-core/src/agents/persona.ts#L56) | schema 소비로 전환 |
| LIFE | 성장과 사회 효과가 manual·잠금을 각각 확인 | [성장](../../../packages/lina-core/src/world/growth.ts#L40), [사회 효과](../../../packages/lina-core/src/world/social-effect-state.ts#L127) | 유지 |

파생 함수에는 아직 제품 호출자가 없다. 배럴에서 내보내고 테스트가 호출할 뿐이다. 계약이 정의됐다는 것과 제품이 그 계약을 따른다는 것은 다르다.

## 대표 예시

아래는 구조 검증용이며 실제 인물 설정이 아니다. 축과 값은 [PersonaSchema 회귀 픽스처](../../../packages/lina-core/test/persona-schema.test.ts#L27)를 그대로 쓴다. 공유 축은 `warmth`·`curiosity`·`tea`·`trust` 네 개다.

고정으로 쓴 개인은 `evolution`이 `manual`이다. 네 축이 모두 잠기고 학습이 값을 바꾸지 못한다.

선택 잠금으로 쓴 개인은 `evolution`이 `adaptive`이고 `lockedTraitIds`가 `["warmth"]`다. `warmth`만 잠기고 `curiosity`·`tea`·`trust`는 변할 자격이 있다. 실제 변화는 각 경로의 근거·범위·현재성 검사를 통과해야 일어난다.

자료를 주지 않으면 네 축 모두 잠기지 않고 참조한 프로필이 없다고 기록된다. 세 결과는 digest가 서로 다르다. 이 픽스처에서 각각 `b7ade1a1`, `87fb41e7`, `aa57cfc0`로 시작한다. 64자 digest의 앞 8자이고 축의 label 하나만 바꿔도 달라지므로 다른 예시의 기대값으로 쓰지 않는다.

대상 개인이 없는 자료를 주면 파생이 실패한다. 참여자가 아닌 개인을 요청했을 때의 실패와는 메시지가 다르다. 이것은 이 문서가 채택한 규칙이며 별도 PR에서 적용된다. 이 문서가 기준으로 삼은 소스에서는 아직 거부하지 않고, 참조한 프로필이 없다고 기록된 잠금 해제 schema가 나온다.

## 프롬프트 작성 규칙과 착수 판정

성격과 말투는 산문으로 쓰고 수치는 축에 쓴다. 산문에 "친밀도 7" 같은 값을 적지 않는다.

잠근 축에 성장을 약속하지 않고, 열어 둔 축을 불변으로 묘사하지 않는다. 둘이 어긋나면 강제되는 쪽은 잠금이고 산문은 지켜지지 않는다.

상대별 태도는 축 단위로만 잠근다. 특정 상대에 대해서만 잠그는 표현은 현재 없다.

이 계약으로 **개별 페르소나 프롬프트 작성을 시작할 수 있다.** 작성자는 성격·말투·전기를 산문으로 쓰고, 공유 축과 비공개 축을 가리지 않고 각 축을 고정으로 둘지 성장으로 둘지 정하고, 성장으로 둔 축의 시작값과 범위를 세계 정의에서 확인하면 된다.

전제는 남는다. 개인별 선택 잠금을 제품에 저장할 방법이 아직 없으므로, 지금 작성한 선택 잠금은 문서상의 의도로 남고 배선이 끝나야 실제로 적용된다. 그 전까지 제품에서 실효가 있는 선택은 `manual`과 `adaptive` 둘뿐이다.

## 기각한 대안

개인별 잠금을 `LifeDefinition`에 참여자별로 넣는 안은 기각한다. 페르소나 정책의 소유권을 World로 옮겨 D18과 어긋나기 때문이다. 기각한 것은 소유권이지 범위가 아니다. AgentStore가 소유하면서 세계 범위를 갖는 정책은 아래 미해결 항목의 후보로 남아 있다.

`PersonaSchema`를 직접 작성하는 안은 기각한다. schema는 파생물이고 digest로 묶여 있어서, 직접 쓰면 label과 범위가 세계 축과 갈라진다.

고정과 성장을 프롬프트 산문으로만 표현하는 안은 기각한다. 산문은 강제력이 없고 잠금은 코드가 검사한다.

## 확정하지 않은 것

| 항목 | 현재 상태 |
| --- | --- |
| 잠금 목록을 프로필에 둘지 별도 기록에 둘지 | 미정. 프로필에 두면 잠금 변경이 기존 성장 근거를 무효화한다 |
| 개인별 시작값 재정의 | 미정. 바꾸면 031의 합성식이 함께 바뀐다 |
| 자료를 주지 않는 입력을 계속 허용할지 | 미정. 제품 호출자가 생길 때 다시 본다 |
| 상대별 태도 잠금 | 축 단위만 수용. 상대별 잠금은 표현 불가 |
| `manual`에 잠금 목록이 함께 있을 때 | 잉여로 허용. 모순으로 거부할지는 미정 |
| revision이 바뀐 schema의 처리 | 미정. 자동 파생 여부와 현재·재생 적격성 판정이 모두 코드에 없다 |
| 잠금 id의 범위 | 미정. 안정적인 페르소나 dimension id와 세계별 대응을 둘지, 잠금을 세계 범위로 선언할지. 그전까지는 위의 잠정 규칙을 따른다 |

이 항목들의 결정과 구현은 후속 작업에서 다룬다.

## 관련 문서

| 문서 | 소유 범위 |
| --- | --- |
| [MOIRAI_ENGINE](../../MOIRAI_ENGINE.md) | 정본 결정과 기존 모듈의 배치 |
| [016 계약](016_neural_preference_contract.md) | 타입·포트·저장·복구, `dimensionSource` |
| [017 로드맵](017_moirai_module_composition.md) | F1–F4 순서와 남은 산출물 |
| [031 성장 투영](../context-engines/031_persona_projection.md) | 성장 해석·receipt·합성식 |
| [PERSONA_CONTEXT](../../PERSONA_CONTEXT.md) | 프롬프트 조립 영역·예산·입력 계층 표 |
