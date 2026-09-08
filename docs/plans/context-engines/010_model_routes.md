# 010 — 공통 처리 등급과 실제 모델 요청

상태: P 초안, 감사 전. 선행: 전체 roadmap 잠금. 분류 C4(settings persistence/consumer contract).

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
- 현재 결정은 최소 경로의 필드 흐름이며 최종 타입/추천 정책은 catalog.ts, complete.ts, HTTP settings route 및 client 타입을 추가 조사한 뒤 A 전에 보완한다. 이 초안 자체는 구현 착수 가능한 완성 계획이 아니다.

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
