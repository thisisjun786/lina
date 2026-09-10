# 010 — 공통 처리 등급과 실제 모델 요청

> 2026-09-10 목표 변경: 사용자의 백엔드·모델 임의 설정은 취소한다. 네 등급은 내부 역할로 유지하되 모델과 설정은 유지보수자가 검증한 프리셋에서 결정한다. [Moirai 프리셋 계약](030_moirai_refactor_plan.md#모델-운영-검증한-프리셋으로-제한)이 목표를 소유한다. 아래는 기존 구현 기록이며, API·저장 설정·송신 소비자의 전환은 R4 작업이다.

> 2026-09-09 계약 정정: 사용자가 공통 등급을 기존 내부 역할별 모델 선택의 대체로 재확인했다. 아래 과거 구현 기록의 agent/role profile override 우선 정책은 더 이상 목표가 아니다. 현재 보완 범위와 증거는 [080 인수 보완](080_acceptance.md#2026-09-09-등급-선택-전환-보완)을 따른다. 일반 대화는 지정 모델을 유지한다.


상태: routing D 완료. 관련 357개 테스트·타입·린트·빌드·HTTP/브라우저 QA 통과. 전체 검사에서 발견한 기존 LIFE 이미지 시간 초과는 integration/acceptance에서 해결할 열린 항목이다. 선행: 전체 roadmap 잠금. 분류 C4(settings persistence/consumer contract).

## 목적

기억·페르소나·월드·컨텍스트 소비자는 quick/standard/deep/intensive 처리 등급을 요청한다. 모델은 등급별 profile로 해석하되 일반 대화는 기존 conversation 선택을 유지한다. 같은 모델을 여러 등급에 사용할 수 있다. 프로바이더/인증은 OpenCodex에 남긴다. 임의의 새 유료 모델을 선택하지 않는다.

## 확인한 현재 경로

`models/types.ts` ModelSettings → `validation.ts` parseModelSettingsInput → `settings.ts` settings_json → `selection.ts` resolveProfile → `lina-opencodex/services.ts` requireResolved/completeOptions/roleCall → complete.ts 실제 요청.

`createOpenCodexContextServices.summarize(text, _maxTokens, ...)`는 요약 호출자가 전달하는 출력 한도를 사용하지 않는다. 현재 completeOptions는 profile.maxOutputTokens만 보낸다. 이 경우 모델 설정이 없으면 요약기가 요청한 예산을 요청에 전달하지 않는 차이가 생긴다. 출력 검증이 별도로 존재하더라도 호출 비용·길이 제어의 대체 증거가 아니다.

## 변경 지도

| 작업 | 경로 | 전 → 후 |
| --- | --- | --- |
| MODIFY | packages/lina-runtime/src/models/types.ts | 역할별 profile만 존재 → 공통 tier 설정, 용도별 요청 정책, 적용 결과 타입 추가; 기존 conversation 필드 유지 |
| MODIFY | packages/lina-runtime/src/models/validation.ts | 기존 필드만 파싱 → tier enum/profile 참조/숫자 범위/미지원 값 검증; 구버전은 명시적 정규화 |
| MODIFY | packages/lina-runtime/src/models/settings.ts | 기존 JSON 읽기/쓰기 → 보존적 settings migration과 tier 저장, revision CAS 유지 |
| NEW | packages/lina-runtime/src/models/routes.ts | 등급·용도·필수 기능·명시적 override에서 적용 profile과 출력 예산을 결정하는 순수 resolver |
| MODIFY | packages/lina-runtime/src/models/selection.ts | role 선택 → 기존 대화/명시적 역할 override 유지, 내부 소비자의 공통 resolver 접점 제공 |
| MODIFY | packages/lina-runtime/src/context/port.ts | 요약/관찰/회상 호출 → 선택적 route request 전달; 호출자 제한과 기본 정책 구분 |
| MODIFY | packages/lina-opencodex/src/services.ts | roleCall 고정 선택 및 _maxTokens 무시 → route resolver 소비, 요약 요청 한도와 profile/catalog 상한의 최소값 전달, 실제 적용 정보 제공 |
| MODIFY | packages/lina-opencodex/src/complete.ts | 기존 프로토콜 직렬화 재사용; 부족한 옵션 처리만 소비자 테스트 근거로 수정 |
| MODIFY | packages/lina-runtime/src/fleet/codex-fleet.ts | 기존 settings getter/일반 대화 경로 보존, LIFE 라우트 연결은 persona/integration 단위와 소유권 조정 |
| NEW | packages/lina-runtime/test/model-routes.test.ts | resolver의 실제 지원조건·우선순위·미설정·부정 값 테스트 |
| MODIFY | packages/lina-runtime/test/model-settings-selection.test.ts, model-settings-integrity.test.ts | 기존 설정 유지, 재시작과 손상 JSON·잘못된 enum 거부 |
| MODIFY | packages/lina-opencodex/test/services.test.ts | 실제 임시 HTTP 수신 요청의 모델/effort/output limit 검증 |

## 동작 규칙

- 저장된 명시적 사용자 선택을 자동 조합이 덮어쓰지 않는다. 새 tier 값은 설정 추천으로 제시되고 저장된 설정으로 확정한다.
- 모델 미설정은 구성 필요 상태다. 지원하지 않는 도구/이미지/출력 형식을 더 높은 등급이라는 이유로 허용하지 않는다.
- 자동 실패 대체는 명시적으로 허용된 profile 목록 안에서만 한다. 불확실한 외부 실행을 새 모델로 무조건 재실행하지 않는다.
- 현재 일반 대화 모델은 내부 tier 변경으로 바뀌지 않는다.
- 설정 생성·저장·복원·서비스·catalog·HTTP·browser 소비 경로는 아래 보완 절에 명시한다. 독립 감사 통과 전 구현을 시작하지 않는다.

## 검증과 활성화

1. 레거시 settings를 임시 DB에 저장하고 재열기 → 기존 대화 선택 유지; 새 설정 저장/재열기 → 동일한 tier 결과.
2. 같은 모델을 네 tier에 배정하고 다른 effort 적용 → 실제 전송 payload의 값 확인.
3. summarize 요청 한도가 profile 한도보다 작음 → 전송 payload가 작은 한도를 사용. catalog 상한 초과·음수·알 수 없는 tier → 호출 전에 거부.
4. 진행 중 설정 변경 → 다음 호출에서 새 revision 사용; 원래 요청의 출처 검사를 유지.
5. 미지원 reasoning/image 기능·미설정 profile → 명시적 상태/오류, 다른 모델을 임의 선택하지 않음.

대상 명령: bun test packages/lina-runtime/test/model-settings-selection.test.ts packages/lina-opencodex/test/services.test.ts. 2026-09-08 실행 결과 exit 0, 16 pass / 0 fail / 45 assertions. 두 파일을 직접 인자로 전달하여 현재 선택·서비스 소비를 확인했다. 이는 기존 fixture 기반 baseline이며 새 tier나 실제 제공자 자격 검증의 증거는 아니다. 새 테스트는 구현 cycle의 red/green에서 추가한다. root/browser types와 호출 경로 integration도 필요하다.

## 설정 API와 브라우저 소비 체인 보완

추가 MODIFY: `packages/lina-runtime/src/fleet/companion-routes.ts`의 referencedBindingsValid가 tier에 사용된 profile도 현재 catalog로 검증한다. `packages/lina-web/client/model-settings.ts`와 `settings-tab-model.ts`는 기존 설정 저장 시 새 tier 설정을 유실하지 않도록 round-trip 보존한다. 이번 단위에서 새로운 화면을 디자인하지 않는다. 관련 browser structural fixture를 추가해 기존 화면 저장 후 tier가 유지되는지 확인한다.

추가 MODIFY: `packages/lina-opencodex/src/catalog.ts` 및 runtime `models/port.ts`는 이미 upstream의 reasoningEfforts/defaultReasoning을 파싱하는 경로를 유지·노출한다. `ModelReasoning` 고정 enum만으로 모든 provider 옵션을 허용한다고 주장하지 않는다. 지원 목록과 명시적 설정의 교집합을 사용하며 unknown은 실제 applied 상태에서 구분한다.

새 optional `routes`는 `{version:1, tiers: Record<Tier,{profileId:string,reasoning?:ModelReasoning,maxOutputTokens?:number}>, roleTiers: Partial<Record<ModelRole,Tier>>}`를 기본 계약으로 한다. tier 수는 네 개로 검증하고 profile 참조는 기존 validator로 확인한다. 대화는 roleTiers 대상에서 제외한다. 미설정 legacy는 기존 역할 선택을 유지하며 실제 tier가 설정되기 전 성공적인 tier 전환으로 표시하지 않는다. 내부 route 요청에서는 요청 override > 명시적으로 활성화한 tier binding 순으로 적용한다. routes가 없는 legacy 설정에서만 기존 역할/default 경로를 사용한다. 기존 역할 설정이 새 tier를 무조건 가리는 ghost tier를 만들지 않는다. 일반 conversation은 기존 resolveProfile만 사용한다. effective result는 mode=legacy|tier|override와 settingsRevision/tier/profileId/requested/applied 옵션을 반환한다.

## 사전 감사 수정: 활성화·우선순위

`routes.roleTiers[role]`의 존재가 해당 역할의 tier 활성화다. routes만 있고 roleTiers[role]가 없으면 기존 agentRoles→roles→default를 사용한다. 명시적 시험 override가 가장 우선이며 conversation은 언제나 legacy resolver다. MODEL_ROLES는 불변이다. LIFE director/actor는 일반 role enum에 추가하지 않고 070의 world model selector에서 공통 Tier 타입을 사용한다. summaryCacheKey는 기존 resolveProfile 결과 대신 실제 effective route(mode/tier/profileId/effort/output/policy revision)를 포함한다. 010 tests에 tier 없는 vision과 기존 agent role 보존, cache key 변경을 추가한다.

## routing 단위 감사 반영 (2026-09-08)

Inspector의 GO-WITH-FIXES(blockers=3)를 다음 규칙으로 해소한다. 이 절이 앞선 우선순위·한도 서술보다 우선한다.

- 명시적 시험 override > 명시적 agentRoles[agent][role] > 활성 roleTiers[role] > legacy roles/default. 에이전트별 명시 바인딩은 전역 등급 설정으로 무효화하지 않는다. 직접 tier 요청은 호출자가 명시한 tier를 사용하며 routes가 없으면 not_configured다. conversation의 tier 요청은 거부한다.
- 호출자의 출력 한도는 profile/tier/catalog 상한과 최소값으로 적용한다. 저장된 profile 또는 tier의 한도가 현재 catalog 상한을 넘으면 output_budget_exceeded로 호출 전 거부한다. 음수·비정수 입력은 invalid_input이다.
- reasoning=false는 전송 옵션 생략, 상태 model_no_reasoning이다. advertised reasoningEfforts에 요청값이 없으면 reasoning_unsupported로 거부한다. reasoning=true이고 목록이 없으면 기존 요청값을 보내되 지원 확인 상태는 unverified다. off는 기존처럼 옵션 생략을 뜻하며 제공자 내부 추론 중단을 보장하지 않는다.
- 순수 resolveModelRoute(settings, role, agentId?, request?)는 mode(legacy|tier|override), settingsRevision, tier?, profile를 반환한다. request는 tier?와 overrideProfileId?이며 함께 지정할 수 없다. resolveProfile은 변경 없이 대화 선택을 담당한다. 실제 catalog 적용은 서비스 경계에서 처리하고 ContextServices의 선택적 routeInfo가 requested/applied/지원 확인 상태를 반환한다.
- ContextServices의 summarize/observe/reflect/reasonMemory에 마지막 선택적 route request를 추가한다. SummaryCall도 같은 타입을 사용한다. 기존 timeout과 callback 순서를 유지한다. summaryCacheKey는 settingsRevision과 실제 route/catalog 옵션을 포함하고, engine policy revision 연결은 정책 owner 구현 단계에서 추가한다.
- settings_json 확장은 SQL schema 변경 없이 parser로 읽기·쓰기·재열기를 검증한다. 네 tier는 모두 필요하지만 같은 profile을 재사용할 수 있다. MODEL_ROLES는 불변이고 roleTiers 타입 및 파서에서 conversation을 제외한다.
- 추가 MODIFY 테스트: packages/lina-runtime/test/model-api.test.ts, packages/lina-web/test/model-settings-ui.test.ts. 브라우저의 활성 모델 표시는 실제 우선순위와 맞추되 새로운 화면을 만들지 않는다.
- 구현 분담: executor는 models/types.ts, validation.ts, 새 routes.ts와 해당 저장·선택 테스트를 맡는다. main은 ContextServices/SummaryCall, OpenCodex 서비스·catalog, API와 브라우저 소비 및 해당 테스트를 맡는다. 파일 쓰기 범위는 겹치지 않는다.

### B 증거: 요약 출력 한도

2026-09-08 services.test.ts에 3개 회귀 추가 후 실행: 5 pass / 3 fail, exit1. caller64/profile1024에서 실제 전송1024, 음수 및 catalog초과에서 resolve되는 실패를 확인했다. services.ts completeOptions에 호출 한도와 설정 상한 검사를 연결한 뒤 같은 파일 8 pass / 0 fail / 24 assertions, exit0. 기존 테스트의 max_output_tokens 미전송 기대는 수정된 계약에 맞게512로 변경했다. fixture HTTP 직렬화 경계 증거이며 실제 제공자 호출은 아니다. 라우팅 전체는 진행 중이다.

B 추가 red/green: advertised effort mismatch는 8pass/1fail 뒤 검사 추가로 9pass/0fail. 인증 해제·역할 미지원 catalog 재검사 테스트는 호출이 성공하는 red 뒤 model_unavailable 검사를 추가해 1pass/0fail. tier 활성/직접 tier/실제 loopback responses·chat 요청 테스트는 아직 연결 전 red 상태이며 통과로 기록하지 않는다. 처음 loopback chat fixture에 finish_reason이 빠진 문제는 fixture에 stop을 넣어 바로잡고 tier effort 미전송이라는 실제 red를 다시 확인했다. 카탈로그 공개 투영에 reasoningEfforts/defaultReasoning 전달을 추가하고 배열 복사도 검증 대상으로 뒀다.

B 연결 검증: main이 지연된 core 구현 범위를 회수했다. types/validation/routes를 구현하고 ContextServices와 SummaryCall을 연결했다. 모델 라우트 테스트는 모듈 부재 red 후 4pass, 실제 SQLite 재열기·손상·CAS 검증 추가 후 기존 저장 테스트와 합쳐40pass/0fail/107assertions. services16pass/0fail/55assertions는 명시 tier, 역할 tier, cache revision, actual loopback responses/chat, observe/recall/reflect guard 보존, requested/applied 지원 상태를 포함한다. bun install --frozen-lockfile로 작업트리의 누락된 node_modules를 준비했고 lockfile 변경은 없다. 테스트 fixture readonly-array 타입을 수정한 뒤 bun run typecheck(root+browser) exit0. API/browser 단위는 별도 executor가 계속 작성 중이므로 전체 routing 완료는 아니다.

B 독립 검토 PASS(core/service) 후 추가 결정: 전역 roleTiers만 활성화했을 때 에이전트별 추론 설정도 보존한다. tier model은 유지하고 agentRoleReasoning[agent][role]을 tier reasoning 위에 적용한다. 호출자가 직접 지정한 tier/시험 override는 이 overlay를 적용하지 않는다. 전역 roleReasoning은 tier 활성화를 사용자가 명시 저장한 경우 tier 정책으로 대체되며, tier 비활성 역할은 기존 규칙을 유지한다. 회귀 테스트에서 agent high가 medium으로 바뀌는 red를 확인하고 수정했다.

B API/browser 구현은 Hand가 완료했다. main이 diff를 확인하고 전역 tier에 가려지는 legacy 편집 차단, resolver 오류 시 거짓 legacy 표시 제거, 알려진 모델 오류의 고정 안내 문구를 반영했다. Inspector가 API/browser PASS와 5폭 visual functional-integrity PASS, 별도 Critic이 CJK/reflow PASS를 반환했다. 브라우저의 tier 활성/해제 UI는 만들지 않았으며 기존 PATCH API로 구성한다. 화면은 저장된 tier를 보존·표시하고 에이전트별 override를 편집한다. manual QA에서 실제 브라우저 저장 후 revision1→2, routes 보존, lina summary effort high, 저장 완료 문구를 확인했다. 스크립트의 대기 대상 ID 오타는 저장 후 조회로 완료를 확인해 중복 저장 없이 처리했다. 전체 모델 응답·업무 화면·LIFE UI 검증은 아니다.
