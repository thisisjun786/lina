# 080 — 전체 기능 인수와 실제 모델 증거

상태: P 재검증, 2026-09-09. 선행 integration은 d0221de의 source-bound 검사(3,666 pass·46 skip·0 fail, 타입·lint·CI·build 종료 0)로 D 완료했다. 그 결론인 자체 owner·실행 연결 검증을 받아, 이번 단위는 재실행 가능한 인수 명령과 UI 계약을 정리한다. 실제 모델 자격 검증은 여전히 미완료다.

유형 satisfy-spec/C4, 계기는 사용자의 초기 목표 재점검·루프 재개 요청이다. 로컬 코드·임시 상태·합성 제공자·기존 공개 소스 조회만 허용한다. 푸시·머지·배포·사용자 설치 변경·실제 모델 호출은 별도 승인 범위다. 새 시간·토큰·금액 한도는 임의 지정하지 않는다. 성공 조건은 요구별 재현 가능한 기능 증거와 계약 목록, 별도 승인된 실제 모델 증거다. 실제 모델 승인이 없으면 준비한 호출·시나리오·한도를 제시하고 해당 기준을 열어 둔다. 기록은 이 문서·081·session evidence/acceptance-*다. 메인은 runner·검증을 맡고 독립 작성자는 081 계약 문서만 맡는다. 두 작성자가 같은 범위에서 실패하면 메인이 회수한다.

## 현재 소스에 맞춘 인수 실행

`scripts/qa/context-engines.ts`는 기존 실제 DB/HTTP/RPC 테스트를 명시적 경로 목록으로 묶는다. 새 가짜 엔진이나 별도 저장소를 만들지 않는다. `--list`는 시나리오와 검사 경로만 출력하고 상태를 만들지 않는다. 기본 실행은 명시한 로컬 테스트를 한 subprocess에서 실행하며 새로운 임시 디렉터리에 출력·소스 커밋·종료 코드·검증 범위 JSON을 남긴다. 모든 시나리오는 이미 임시 DB/설치와 합성 제공자를 사용한다. 임의 인수·`--live`는 실행 전에 거부한다. 실제 모델 검증은 이 로컬 결과로 충족시키지 않는다. 환경에서 live opt-in 변수를 상속하지 않고 외부 API 키를 전달하지 않는다. 실패 시 0을 반환하거나 실패 로그를 지우지 않는다.

검사 경로는 `packages/lina-runtime/test/`의 engine-integration, context-session-budget, context-tree, persona-native-growth, shared-resource-consumers, resource-memory-worker, life-resource-fleet, life-publication-fleet, persona-first-conversation, intro-api 및 `packages/lina-memory/test/`의 resource-memory-provenance, resource-activities, resources-extraction을 사용한다. 라우팅·기억의 추가 경로는 해당 기존 단위의 검증 명령과 대조해 확정한다. 전체 source gate는 integration에서 동일 소스에 실행했으며, 인수의 새 코드가 관찰되는 검사·타입·lint를 추가한다. 신규 `packages/lina-runtime/test/context-engines-qa.test.ts`가 CLI 잘못된 인수·list 무상태·실패 전파를 검사하고 import로 새 runner를 root typecheck 대상으로 포함한다.

081은 reference 문서다. 독자는 UI 설계자이며 엔진의 실제 endpoint/도구/설정 필드, 저장 성공과 처리 완료의 차이, 권한·오류·재시도·복원 의미를 확인한다. 004를 중복 설계하지 않고 실제 source와 테스트 경로를 연결한다. 첫 대화와 일반 대화·LIFE 공개 범위, legacy migration-required, 네 등급과 지정 대화 모델을 포함한다. 미구현 UI나 실제 모델 품질을 완료로 표시하지 않는다.

081은 001의 엔진별 계약 표 10행을 빠짐없이 대응시킨다. 각 행은 실제 endpoint·도구·소스 경로 또는 명시적 미구현 표시를 가지며, 페르소나의 고정 설정/변화 범위/revision/적용 상태, 자료의 목록/개요/검색/읽기/정리/처리 상태, 공유 기억의 식별자/출처/처리 실패/재처리도 포함한다. runner는 종료 코드와 별도로 completed/interrupted 상태를 기록한다. 실행 전 running 기록을 남겨 호스트가 강제 종료된 경우 성공이나 확정 실패로 오인하지 않게 하며, SIGINT/SIGTERM은 자식 종료와 기록을 완료한다. 세계 기준은 `git -C /home/jun/code/lina-world-engine status --short`, `git worktree list --porcelain` 및 기록된 cefaffc와 현재 source diff를 비교한다. 2026-09-09 로컬 LIFE head는 cefaffc이고 dirty가 없음을 확인했다. 원격 PR 현재 상태나 머지 증거로 해석하지 않는다.

라우팅의 실행 증거는 `packages/lina-runtime/test/model-routes.test.ts`와 `packages/lina-opencodex/test/services.test.ts`의 실제 요청 payload 검사를 함께 사용한다. 개인 기억은 `packages/lina-memory/test/engine-reasoning.test.ts`, `consolidation.test.ts`, `packages/lina-runtime/test/memory-query.test.ts`, `memory-consolidation.test.ts`로 원문 전제·후속 추론·질의·정리 소비를 검사한다. `context-budget-recovery.test.ts`는 압축과 복구 경계를 보완한다. 모두 071 전체 테스트에 포함되어 종료0을 확인한 기존 파일이며, 선택 목록에 들어간 경로만 이번 runner가 실행한다.

검증 기준: 인수 runner의 시나리오 명령 종료0, API 목록을 실제 route와 대조, integration curl 증거 재사용 가능 여부를 소스 diff로 확인, 최종 root/browser typecheck와 lint 및 구조 문서 검사. 기존 전체 검사 로그는 d0221de에 한정한다. 정적 검사는 문장 의미를 보증하지 않아 문서는 독립 검토한다. runner의 결과는 E7 로컬 실행 증거이며 임의 사용자가 JSON을 편집할 수 있으므로 위변조 방지나 모델 품질 인증으로 부르지 않는다.

## 변경 지도

| 작업 | 경로 | 전 → 후 또는 신규 책임 |
| --- | --- | --- |
| NEW | `scripts/qa/context-engines.ts` | task-owned temp root에서 전체 기능 시나리오 실행; paid profile은 명시적 선택/승인 없으면 실행하지 않음 |
| NEW | `docs/plans/context-engines/081_contract_inventory.md` | 검증된 도구/API/설정/상태/오류 목록과 UI 기획용 계약 |
| MODIFY | `docs/VALIDATION.md` | 각 기능의 local fixture/실제 model/재시작/설치본 증거 범위 구분 |
| MODIFY | `README.md` | 완성된 자체 엔진 설명과 실제 제한, 업무와 Codex 구분 |

## 필드·상태 흐름

모의 모델은 구조/실패/복구 검증에 사용한다. 실제 모델의 추출·추론·요약·회상 성공은 허용된 profile로 별도 증거를 남긴다. 기존 live credentials를 발견했다고 호출 권한으로 보지 않는다. 미승인 실제 모델 검증은 명시적 미완료 기준이며 전체 목표 완료를 주장하지 않는다. UI 화면 제작은 다른 범위이고 UI 계약의 호출 가능성을 실제 임시 API로 확인한다.

입력은 해당 boundary에서 검증하고 저장 owner가 schema/revision/참조를 검증한다. 새 상태는 API/도구 출력과 실제 consumer까지 전달한다. 임의 JSON으로 권한을 부여하지 않는다. 구버전·알 수 없는 enum은 명시적으로 처리하고 조용한 기본값으로 데이터 의미를 바꾸지 않는다.

## 활성화와 기대 결과

- 네 tier 실제 적용.
- 기억 근거 수정→후속 추론 변화.
- 비밀 미공개 성장.
- repeated compaction/restart 후 결정 이유.
- 비코드 자료의 LLM 탐색과 A/B/Codex 인수.
- 외부 Honcho/OpenViking 없는 runtime.
- source gates 전체 통과.
- world HEAD/dirty 재대조.
- paid qualification 여부 명시.
- 공통 대화 행동: 071 소유의 지침/RPC/첫 대화 상태 검사 결과를 받아, 지정 모델의 인사·구체적 요청·이견·기억 정정·검색/실행 전환 시나리오로 검증한다. 출처 없는 과거 대화를 꾸미지 않고, 역할 전환에도 작성된 목소리와 지정 모델을 유지해야 한다. 단기 모델 검증과 사용자의 장기 체감 평가는 구분한다.
- UI 계약 목록에 `GET /api/onboarding/entry`의 firstUser/resume, `GET /api/agents/:agentId/intro`의 room/turns/userRevision/shareUser/sessionId, POST turn/finish/choose의 revision·요청 ID·오류·재시도 의미를 포함한다. 기능을 새로 설계하지 않고 현재 소스와 실제 HTTP 결과를 대조한다.

## 검증 명령과 증거

각 NEW 테스트의 직접 경로를 `bun test`에 전달하여 실패→구현→통과를 남긴다. 이 문서 작성 시 새 테스트는 없으므로 실행 결과를 주장하지 않는다. 수정된 기존 기능의 affected tests, `bun run typecheck`, `bun run lint`를 수행하고 마지막 acceptance에서 `bun run ci:validate`, `bun run ci:build`와 전체 테스트를 수행한다. 현존 스크립트는 package.json에서 확인했으며 target coverage와 실제 exit code는 실행 시 기록한다.

## 감사와 재검증

공통 상태 계약은 004_contracts.md, 해당 단위의 추가 계약은 아래 사전 감사 수정 절을 따른다. A에서 source/소비자 누락을 검사하고, 각 구현 P에서는 선행 커밋으로 바뀐 타입과 경로를 재검증한다. A 통과 전 구현은 시작하지 않는다.

## 실제 모델 검증 승인 패킷

아래는 검증 승인 범위다. 2026-09-09 사용자의 “계속진행” 이후 역할별 모델 검증을 시작했으며, 결과는 다음 절에 구분한다. 승인 대상은 사용자 데이터 없는 임시 설치에서 현재 지정 대화 모델과 공통 엔진 라우트로 아래 합성 사례를 한 차례 확인하는 것이다. 모델이나 라우트가 없으면 임의 모델로 대체하지 않고 미구성 결과를 기록한다. API 키·원문 사용자 대화·기존 기억은 결과에 복사하지 않는다. 실행용 인증은 기존 제공자 경로만 사용하며 새 유료 fallback은 허용하지 않는다.

| 합성 사례 | 호출 경계와 관찰 |
| --- | --- |
| 취향 관찰→정정→재질의 | 현재 memory observer/consolidation/query 소비자; 옛 결론의 근거가 무효화되고 정정된 원문을 인용하는지 |
| 반복 요약→재시작→결정 이유 회상 | context summary/expand 소비자; 실제 요약에서 원문 결정·미완료 약속을 복원하는지 |
| 경험 해석→성장→일반 대화 | persona interpretation과 고정 대화 모델; 핵심 정체성을 유지하고 비밀 사건을 노출하지 않는지 |
| 다른 표현으로 공유 자료 탐색 | resource plan/rank/capture; 단순 문자열이 달라도 허용된 원문으로 연결하고 다른 에이전트 비공개 자료를 배제하는지 |
| LIFE 성격 반영과 공개 게시 | 고정 actor/publication 선택; 허용된 공개 근거만 문장에 쓰는지 |
| 첫 인사·구체적 요청·이견·기억 정정·검색 전환 | 지정 대화 모델; 지침과 목소리를 유지하고 없는 과거 대화를 꾸미지 않는지 |

승인 제안 한도는 전체 제공자 요청 최대 24회, 요청당 입력 최대 7,000 토큰·출력 최대 1,024 토큰이다. 이는 이번 검증의 상한 제안이며 제품 기본값·주기·예산 결정이 아니다. 실제 profile이 더 낮은 한도를 정하면 낮은 값을 적용한다. 요청 한도가 먼저 소진되면 남은 사례는 미검증으로 남긴다. 모델별 실제 비용은 아직 확인하지 않았으므로 무료 검증이라고 부르지 않는다. 결과에는 exact engine/API/model/effort, 요청·출력 사용량, 상태와 후속 저장/재조회, 실패 및 미실행 사례를 남긴다. 사용자 장기 대화 평가는 이 단기 검증 이후 별도 단계다.

## routing D 인계

공통 등급은 기존 settings PATCH API로 활성/해제한다. 현재 UI는 저장된 등급의 보존·표시와 에이전트별 모델/추론 override만 제공한다. 이것을 새 tier 편집 UI 구현으로 표시하지 않는다.

이전 routing 단계의 이미지 timeout 기록은 역사적 결과다. 통합 후 동일한 제한의 해당 시나리오와 전체 검사를 통과했으며 d0221de의 integration-test-receipt.json(3,666 pass·46 skip·0 fail)을 현재 근거로 사용한다. 별도로 발견한 게시 mock의 v2 한정 조건은 272b2f4에서 새 v3 계약으로 맞췄다. 이 mock 불일치를 과거 timeout의 원인으로 단정하지 않는다. 46개 skip은 실제 모델 검증으로 계산하지 않으며, 실제 모델 자격 검증은 별도 승인 범위다.

## 2026-09-09 실제 모델 부분 검증

운영 `/api/models` 읽기에서 대화 profile-1/gpt-6-astra, 기억·요약·재검토·회상 profile-2/gpt-5.6-terra(low)를 확인했다. 운영 설정은 수정하지 않았다. 네 등급 `routes`는 없어 자료 기억 호출이 모델 dispatch 전 `No model routes are configured`로 거부됐다. 임시 등급 바인딩 선택을 사용자에게 질문했으며 답변 전에는 생성하지 않는다.

현재까지 제공자 요청은 21/24회이며 모두 gpt-5.6-terra, low다. 첫 요청의 출력 상한은512이고 모든 요청은1024 이하로 제한했다. 요청 전 카운터를 저장해 실패도 횟수에 포함한다. 실제 청구 비용과 모든 응답의 토큰 사용량은 별도로 수집하지 않았으므로 비용·총 사용 토큰을 추정 완료로 기록하지 않는다.

- 실제 요약: 정정된 색상과 이유·미정 항목 보존. ContextStore 원문→모델 요약→SQLite 다시 열기→같은 summary id, 재호출0. 전체 native 세션 재시작 증거와는 구분한다.
- 실제 페르소나 해석: 합성 원문 근거에서 NativePersonaGrowth가 성향 값을 저장. 작성 identity 동일, DB 다시 열기 뒤 추가 호출0. 원문 근거 철회 후 개인 행동 projection 제거.
- 실제 기억: CompanionMemory 관찰→연역/귀납 재검토→다시 열기→사용자 정정의 전체 흐름. 처음에는 모델이 reasoningKind=explicit을 반환해 invalid_output으로 거부됐다. prompts.ts에 deduction/induction과 evidence 구분을 명시한 뒤 같은 실패 입력이 유효한 proposals:[]를 반환했다. 전체 흐름 재검사에서 accepted2, consolidation committed2, failed0, 재시작 재호출0. 호스트 파서는 완화하지 않았다.
- 실제 회상: 엔진이 만든 현재 active records로 보리차 선호·카페인 이유·출처를 답하고 없는 출시일은 unknown으로 표시. 별도 일반 대화 UI/native turn 품질 검증은 아니다.

증거는 session evidence/live의 calls.json, context-recovery.json, persona.json, memory.json, consolidation-13.json(실패), consolidation-recheck.json, recall.json과 실행 스크립트다. 합성 데이터만 기록하고 임시 DB는 정리했다. 설정된 대화 모델의 일반 대화, 네 등급별 실행, 자료 탐색·공유 기억 및 LIFE 공개 게시의 실제 모델 품질은 아직 미검증이다. 이 부분 검증으로 acceptance criterion을 충족 처리하지 않는다.
