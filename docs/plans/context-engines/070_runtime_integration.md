# 070 — 실행 연결과 외부 어댑터 퇴역

상태: P 설계 초안. 감사 전이며 구현 완료가 아니다. 단위 `integration`, 선행 `persona + context + shared-memory`.

## 변경 지도

| 작업 | 경로 | 전 → 후 또는 신규 책임 |
| --- | --- | --- |
| MODIFY | `packages/lina-runtime/src/session-app.ts` | honcho/native 구성 분기 → 자체 기억/자료/context의 명시적 lifecycle 조립 |
| MODIFY | `packages/lina-runtime/src/fleet/manager.ts` | Honcho client 선택/초기화 → 자체 engine owner와 설정 상태 |
| MODIFY | `packages/lina-runtime/src/fleet/codex-fleet.ts` | parseHonchoEnv/OpenViking workbench → 자체 자료 엔진 초기화/닫기, LIFE 공통 route 연결 |
| MODIFY | `packages/lina-runtime/src/context/backend.ts` | native/honcho/disabled → 자체 엔진 활성화 정책; legacy honcho는 조용히 바꾸지 않고 전환 필요 상태 |
| MODIFY | `packages/lina-memory/src/index.ts` | 외부 memory export → 자체 resource/memory boundary; 소비자 확인 후 외부 adapter source 제거 |
| MODIFY | `data/app-system-prompt.md` | 업무=코딩 연상과 실제 도구 불일치 제거; 개발/비개발/검색 구분 및 자료 탐색 규칙 |
| MODIFY | `docs/ARCHITECTURE.md` | 구형 외부 기억 및 source ownership 설명 → 검증된 자체 엔진 경계 |
| MODIFY | `docs/PERSONA_CONTEXT.md` | OmO/Honcho 중심 과거 설명 → 실제 route와 인격/context 책임 |
| NEW | `packages/lina-runtime/test/engine-integration.test.ts` | Fleet start→소비→stop/restart와 외부 adapter 호출 부재 검증 |

## 필드·상태 흐름

기존 사용자 데이터는 읽기 없이 임시 fixture로 이전 경로를 검증한다. 외부 adapter 삭제는 import/exports/env/client/settings/tests/installer 소비자 목록을 확정한 뒤 수행한다. 기존 실행 설치를 교체하지 않는다. 승인 없는 legacy 데이터는 원형을 보존하고 명시적 전환이 필요한 상태를 제공한다. capability/settings/state 계약을 문서화해 UI가 실제 준비/진행/실패를 표시할 수 있게 한다. LIFE는 current head를 재검증하며 다른 워크트리 dirty 변경을 복사하지 않는다.

입력은 해당 boundary에서 검증하고 저장 owner가 schema/revision/참조를 검증한다. 새 상태는 API/도구 출력과 실제 consumer까지 전달한다. 임의 JSON으로 권한을 부여하지 않는다. 구버전·알 수 없는 enum은 명시적으로 처리하고 조용한 기본값으로 데이터 의미를 바꾸지 않는다.

## 활성화와 기대 결과

- 신규 설치와 legacy 설정 각각 초기화.
- 외부 host 미설정에서도 자체 기능 수행.
- 이전 실패는 원본 유지.
- 중간 초기화 실패 리소스 정리.
- 일반 대화 모델 고정.
- persona/world/resource 컨텍스트가 목적대로 분리.
- UI용 상태가 빈 성공값으로 실패를 숨기지 않음..

## 검증 명령과 증거

각 NEW 테스트의 직접 경로를 `bun test`에 전달하여 실패→구현→통과를 남긴다. 이 문서 작성 시 새 테스트는 없으므로 실행 결과를 주장하지 않는다. 수정된 기존 기능의 affected tests, `bun run typecheck`, `bun run lint`를 수행하고 마지막 acceptance에서 `bun run ci:validate`, `bun run ci:build`와 전체 테스트를 수행한다. 현존 스크립트는 package.json에서 확인했으며 target coverage와 실제 exit code는 실행 시 기록한다.

## 감사와 재검증

공통 상태 계약은 004_contracts.md, 해당 단위의 추가 계약은 아래 사전 감사 수정 절을 따른다. A에서 source/소비자 누락을 검사하고, 각 구현 P에서는 선행 커밋으로 바뀐 타입과 경로를 재검증한다. A 통과 전 구현은 시작하지 않는다.

## 저장과 체크포인트 연결

MODIFY `packages/lina-runtime/src/checkpoint-cli.ts`는 외부 memory가 export되지 않는다는 기존 coverage gap을 실제 구성에 맞게 갱신한다. 자체 자료 DB와 content는 stateRoot 하위에 두어 기존 state component에 포함한다. MODIFY `checkpoint-barrier.ts`는 resource background writers도 설치 lock owner에 속하도록 runtime lifecycle과 계약을 맞춘다. 기존 barrier를 우회하는 worker를 만들지 않는다. NEW `packages/lina-runtime/test/resource-checkpoint.test.ts`는 자료 저장→index 진행→정지→checkpoint→새 디렉터리 복원→read/search 및 job resume를 검증한다. 원본 해시·참조와 index의 준비 상태를 별도로 확인한다.

외부 서비스 설정을 제거하더라도 기존 외부 메모리가 이 checkpoint에 포함됐다고 표시하지 않는다. 원격 데이터 이전은 명시적으로 선택된 export 입력만 허용하고 자동 fetch/삭제하지 않는다.

## 사전 감사 수정: LIFE 라우트·비개발 활동

월드 라우트를 제외하는 축소안은 채택하지 않는다. 추가 MODIFY core/world/authoring-types.ts의 models.director/actor는 정확 {provider,model} 또는 {tier} selector로 구분한다. 관련 authoring validation/codec은 양쪽을 검증하고 기존 config를 exact selector로 유지한다. 추가 MODIFY core/world/autonomy-persistence.ts, runtime/fleet/life-runtime.ts selection(), codex/life-model-policy.ts: 새 step 생성 시 tier를 exact profile/settings revision으로 해석하고 당시 route fingerprint를 step source에 동결한다. lifePlan fingerprint v2는 해석 결과를 포함하고 기존 v1 receipt는 당시 decoder로 유지한다. 정책 변경 뒤 outbound 전 검사는 stale을 거부하며 이미 실행된 결과를 새 모델로 반복하지 않는다.

추가 MODIFY runtime/life/work-source.ts, work-bridge.ts 및 core/world의 work evidence codec: activity source를 discriminated union `codex-task | resource-activity`로 받는다. 후자는 source resource/version, origin actor, kind, factual evidence, grant와 revision을 가지며 task id가 없다. 자료 저장만으로 업무 성공을 추정하지 않고 실제 산출물/수행 기록과 명시적 공유 허용이 있어야 LIFE input으로 admit한다. world evidence digest는 origin과 version을 포함한다. 검증: Codex task 없는 research 기록→공유 허용→후속 사건 입력 한 번 반영, 철회 후 아직 미실행 입력 제외.

## 사전 감사 수정: 퇴역 범위 결정

소스에서 외부 엔진 runtime 의존성을 제거하는 것과 사용자의 기존 설치/원격 데이터를 삭제하는 것은 별개다. 양쪽 병행 유지가 현재 사용자 요구라는 검토 의견은 최신 직접 지시와 달라 채택하지 않는다.

- MODIFY runtime/tools/work-memory.ts: 기존 lina_work_* 호환 이름을 자체 resource owner에 연결하거나 명시적 retirement 오류로 처리; Codex 작업을 생성하지 않는다. MODIFY runtime/codex-prompt.ts와 data 지침은 실제 새 도구 이름에 맞춘다.
- DELETE memory/src/honcho/* 및 openviking/*의 production adapter는 모든 소비 전환 이후 수행. 원격 데이터/설치 서비스는 건드리지 않는다. tests의 외부 adapter-only 계약은 retirement/migration 부정 테스트로 대체한다.
- MODIFY manager.ts와 session-app.ts는 Honcho 옵션/초기화 호출을 제거한다. backend.ts의 legacy honcho 값은 migration-required 진단으로 처리하고 자동 native 재해석하지 않는다.
- deploy/honcho와 live QA 스크립트의 원격 전용 호출은 retired 문서로 명시하고 새 런타임 필수 경로에서 제외한다. 역사적 LIFE 050 검증 기록은 재작성하지 않고 새 계약 문서 링크를 추가한다.
- MODIFY docs/CODEX_RUNTIME.md, ARCHITECTURE.md, PERSONA_CONTEXT.md, README.md는 source retirement와 실제 기존 데이터의 미이전 상태를 구분한다.

## 리포지터리 계약 문서 동기화

추가 MODIFY POLICY.md의 Dependencies and compatibility 중 OpenViking/Honcho optional external adapters 설명을 자체 엔진과 legacy 전환 계약으로 갱신한다. 이는 실행 서비스/데이터 삭제 권한 변경이 아니다. 기존 Codex/OpenCodex 실행 역할과 CI의 local fake 정책은 유지한다. 추가 MODIFY docs/PLANNING.md에는 이 단위의 목표/상태와 LIFE 연동 경계를 연결한다. docs/VALIDATION.md는 080에서 실제 증거로 갱신한다.
