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

## 2026-09-09 등급 선택 전환 보완

사용자가 공통 등급을 기존 역할별 모델 선택의 대체 경로로 재확인했다. 현재 `routes.ts`는 agentRoles가 있으면 roleTiers를 건너뛰며, LIFE는 등급 활성 상태에서도 직접 provider/model을 선택할 수 있었다. 인수에서 발견한 요구 누락으로 수정한다. 기존 저장 데이터는 보존하되 활성 등급의 우회를 허용하지 않고, 빠진 등급 연결은 미구성 오류로 드러낸다. 일반 대화는 지정 선택을 유지하며 사용자가 GLM 5.3 Flash로 변경했다.

변경 범위는 models/routes 및 해당 회귀·서비스 요청 테스트, LIFE model-selection과 테스트다. 기존 우회 성공 테스트는 새 요구에 맞춰 거부/공통 등급 선택을 검증하도록 변경하며 기존 데이터 읽기 증거는 유지한다. 자료·개인 기억·요약·페르소나의 최종 요청과 재시작 후 선택을 확인한다. UI의 기존 역할 편집이 새 계약과 불일치하는지도 인수 대상으로 남긴다. 배포되지 않은 개발 브랜치와 실행 중인 설치본을 구분한다.

사용자 지정 테스트 배정: quick=`ollama-cloud/deepseek-v4-flash:0731`, standard=`ollama-cloud/glm-5.3-flash`, deep=`ollama-cloud/deepseek-v4-pro:0813`, intensive=`ollama-cloud/glm-5.3`. 7979 catalog에서 네 ID의 인증 상태를 확인했다. 이 카탈로그는 reasoning=false를 보고하므로 에포트를 보내지 않는다. 실제 지원 능력을 카탈로그만으로 입증했다고 주장하지 않는다. 역할의 시작 등급은 관찰 quick, 요약·회상·이미지 이해 standard, 재검토 deep로 명시하며, 명시적 심층 작업은 intensive를 요청할 수 있다. 이 배정은 이번 테스트 설정이며 영구 제품 기본값이 아니다.

실행 중인 7979는 routes를 모르는 이전 코드라 전체 설정 PATCH가 400으로 거부됐다. 서비스 교체 없이 지원되는 대화·기본 모델만 변경했고 GET에서 revision3와 GLM Flash active를 확인했다. 네 등급 전체 설정은 격리된 개발 상태에 준비한다. 이전 역할 모델을 유지한 채 등급 전환이 완료됐다고 주장하지 않는다. 설정 스냅샷과 요청·읽기 결과는 session evidence/ollama-routing에 보관했다. 현재 소스 수정은 설치본 배포나 새 응답 생성 증거가 아니다.

설치본 비용 전환도 이어서 처리했다. 이전 코드가 지원하는 역할별 바인딩에 이번 테스트 등급과 같은 Ollama 모델을 저장해 revision4로 읽기 검증했다. 관찰 quick, 요약·회상·이미지 standard, 재검토 deep이며 일반 대화·기본은 GLM Flash다. 이 호환 설정은 설치본의 GPT 모델 사용을 피하기 위한 현재 배정이며, 설치본이 공통 등급 코드를 실행한다는 뜻은 아니다. intensive도 등록됐지만 기존 역할에는 대응 슬롯이 없으므로 개발 엔진의 명시적 등급 경로에서 검증한다. 기존 프로필은 삭제하지 않았다.

등급 전환 회귀 보완 결과: 내부 요청은 routes·roleTiers 부재 시 not_configured, profile override는 거부하며 에이전트별 옛 에포트도 적용하지 않는다. 설정 화면은 내부 역할의 직접 편집을 잠그고 현재 등급 또는 미구성 안내를 표시한다. LIFE의 기존 직접 선택은 상태 조회에서 models.director.tier/models.actor.tier 누락으로 표시하고, 해당 설정 오류로 자동 타이머 재시도를 만들지 않는다. world 설정 갱신 후 다시 실행할 수 있도록 원래 설정과 작업을 보존한다. 독립 검토에서 발견한 무검증 기존 바인딩 실행 가능성은 resolver 변경으로 닫았고, 기존 세계 구성 거부의 반복 오류는 상태/스케줄러 회귀로 보완했다.

검사: OpenCodex 125개, 웹 설정 21개, LIFE/라우팅 통합 52개가 각 범위에서 통과했다. 이 숫자를 합쳐 중복 없는 총 개수로 표기하지 않는다. 실제 Chromium에서 합성 HTTP 설정으로 컴포넌트를 열고 에이전트→전역 범위 변경, 내부 입력 비활성, 대화 입력 활성, GLM Flash 표시, 콘솔 오류0을 확인했다. 이미지 browser.png를 직접 읽었다. 테스트 서버는 종료했다. 설치본 전체 화면이나 실제 Ollama 추론 성공 증거는 아니다.

최종 범위 재검사: 20개 파일의 관련 테스트 194 pass·0 fail·940 assertions, 타입 검사·lint·CI validate·build 종료0. 전체 검사는 3671 pass·46 skip·3 fail였으며, 세 실패는 구형 무등급 자료 fixture 두 곳과 폐지된 내부 모델 dropdown 기대 한 곳이었다. 모두 새 계약으로 수정해 관련 194개 검사에서 통과했다. 전체 suite의 최종 수정 후 재실행 성공으로 표기하지 않는다. 네 등급 누락, 에이전트별 예전 profile/effort, 직접 내부 override, LIFE 혼합 설정, 다른 세계 타이머에 의한 재시도까지 부정 사례로 확인했다. 자동 재시도 억제는 명시적 wake까지 모델 lane에만 적용하고 이미지 방문은 유지한다.

독립 검토 후 게시 복구도 보완했다. `publication.ts`는 모델 등급 미구성 오류를 작업의 영구 실패로 기록하지 않고 호출자에게 돌려준다. 대기 작업을 보존하는 회귀는 실패→통과를 확인했으며 게시 처리 33개, 게시 HTTP 30개가 통과했다. HTTP는 409 `MODEL_NOT_CONFIGURED`로 설정 수정을 안내하고 내부 진단을 노출하지 않는다. 등급 작성 경로가 없다는 검토 의견은 `companion-routes.ts`의 PATCH `/api/models/settings`→`ModelSettingsStore.replace`와 실제 HTTP 저장 회귀를 근거로 반박했다. 신규 등급 편집 UI는 별도 범위이고 기존 API로 네 등급 설정을 저장할 수 있다.

## 2026-09-09 최종 로컬 재검사와 Ollama 호출

476a9d8의 깨끗한 소스에서 전체 테스트를 다시 실행했다. `bun test` 결과 3677 pass·46 skip·0 fail, 523개 파일·20791 assertions·249.99초이며 `ollama-routing/full-test-receipt.json`이 소스와 종료0을 기록한다. 앞선 3개 실패 기록은 수정 전 결과로 남기며 이번 결과가 최종 로컬 근거다.

남은 승인 호출 22–24를 격리 설정의 실제 역할 경로로 사용했다. standard GLM 5.3 Flash 요약은 정정된 초록색·장소의 색상이라는 이유·미정 출시일을 보존했다. quick DeepSeek V4 Flash 관찰은 `OpenCodex request failed`로 실패했고 원인을 확정할 증거는 없다. deep DeepSeek V4 Pro 재검토는 근거 없는 입력에 유효한 `{"proposals":[]}`를 반환했다. 응답 성공 둘은 어댑터와 출력 확인이며 저장·일반 대화·LIFE 전체 성공으로 확대하지 않는다. intensive는 아직 실제 호출하지 않았다. 증거는 `ollama-routing/live-three-results.json`, `live-output-checks.json`, 누적 `live/calls.json`이다.

승인된 총24회를 소진해 추가 호출을 멈췄다. 지정 Ollama 모델만 최대24회 추가 호출하는 질문을 남겼으며 답변 전에는 한도를 늘리지 않는다. 전체 목표와 실제 모델 인수 기준은 미완료 상태다. 설치본 코드 교체·푸시·머지는 하지 않았다.

## 2026-09-09 Ollama 호출 승인 확대와 재시작 결함

사용자가 “올라마는 무제한으로호출해도됨”이라고 승인했다. 위의 24회 제한과 승인 대기는 해제됐다. 지정한 Ollama 네 모델과 격리된 합성 데이터로 검증을 이어간다. 출력 제한 때문에 reasoning 응답이 잘리는 사례는 테스트 전용 출력 예산을 늘려 구분하며 제품 기본값 변경으로 취급하지 않는다.

실제 일반 대화의 재시작에서 완료된 native thread의 `notLoaded` 상태를 거부하는 경로를 찾았다. 기존 작성 대화에만 있던 사전 resume을 일반 대화에도 적용했다. terminal history 확인과 resume 후 idle 감사를 유지한다. 회귀는 수정 전 1 fail, 수정 후 관련 33 pass·0 fail·160 assertions다. 타입 검사 종료0, 변경 파일 Biome 검사 오류0(기존 info 진단 존재). 전체 suite를 이번 변경 후 다시 통과했다고 주장하지 않는다.

실제 GLM Flash 재검증은 재시작을 통과했지만 native epoch가 바뀐 뒤 앞선 색상 선택을 회상하지 못했다. 논리 세션 ID는 유지됐으며 이것만으로 대화 연속성을 입증할 수 없다. 짧은 대화의 compact도 요약을 만들지 않아 반복 압축 인수 증거가 아니다. `ollama-routing/native-context-live.json`에 실패를 남겼다. 원문 출처 검증·epoch 전환·이전 대화 전달 경로를 추가 조사해야 한다. 전체 인수는 계속 미완료이며 설치본 코드 교체·푸시·머지는 하지 않았다.

추가 실제 기억 검사: 테스트 전용 memory 출력 예산 32768로 관찰·통합 모델을 호출했다. `memory.json`은 초기 선호와 보리차로의 정정을 저장하고, 통합 committed 2·failed 0 및 DB 재열기 후 중복 provider 호출0을 기록한다. 누적 직접 어댑터 호출 기록은45이며 native Codex 대화 호출은 별도로 집계한다. 이 성공은 합성 trusted journal과 임시 SQLite 범위다. 일반 대화 연속성 실패나 장기 대화 품질까지 통과한 것은 아니다.

## 2026-09-09 최근 원문 전달과 공유 자료 실제 인수

컨텍스트 훅의 현재 질문을 native history로 오인해 raw tail이 항상 생략되던 경로를 수정했다. 현재 native epoch의 원문 ID를 별도 메타데이터로 전달하며, 알려진 빈 목록에서 적격 이전 원문을 복구한다. 메타데이터 없는 opaque 문맥은 계속 거부한다. SessionApp→turn/start에서 최근 원문이 빠지는 실패를 먼저 확인했고 수정 후 관련 4파일 45 pass·0 fail·217 assertions, 타입 종료0, 변경 파일 lint 오류0을 확인했다. 독립 검토는 진행 중이다.

실제 GLM Flash는 재시작 후 초록을 회상했고 노랑으로 정정하는 대화까지 진행했다. 두 번째 압축은 `Conversation summary model unavailable; previous checkpoint and original messages retained`로 실패해 반복 압축 인수는 미완료다. 실행 상태는 `/tmp/lina-live-e2e-49HfNW`에 격리했고 fleet 종료 기록이 있다.

`resources-live.json`은 실제 모델의 비코드 자료 기억 생성과 semantic search, DB 재열기 후 provider 재호출0, task ID 없는 공유 consumer 읽기, 비공개 자료 검색 제외, 공유 자료를 비공개로 바꾼 뒤 기존 frame guard와 외부 consumer의 접근 거부를 통과했다. 합성 문서와 임시 저장소만 사용했고 종료 시 삭제했다. 테스트 전용 resource 출력 예산8192를 사용했으며 제품 기본 예산은 변경하지 않았다.

### 실제 요약 응답 진단과 프롬프트 보완

출력 예산8192에서도 단문 요약이 실패했다. 격리 스크립트에 HTTP 상태와 공개 응답 본문만 기록하자, 실제 GLM이 길이 기준을 넘는 설명을 반환하고 재시도에서는 보관 원문 속 `LINA_APP_OK` 응답 지시를 실행하는 사례를 확인했다. 두 번째 결과는 길이 검사에는 통과했으나 색상 결정을 누락해 재시작 회상에 실패했다. 앞서 한 번 성공한 raw tail 회상과 모델 요약의 의미 보존은 서로 다른 증거다.

summary 역할 요청에 소비자의 문자 상한을 명시하고, 보관 원문 속 응답 표식을 실행하지 말고 결정·정정 사실을 보존하도록 지침을 보완했다. 서비스 요청 회귀는 수정 전1 fail→수정 후22 pass·0 fail, 타입 종료0이다. 이는 요청 계약 증거이며 모델 의미 보존 성공으로 대신하지 않는다. 보완된 실제 반복 압축 검사는 진행 중이다.

838b528의 프롬프트 보완 후 실제 GLM Flash native 검사가 종료0으로 끝났다. `/tmp/lina-live-e2e-O1iOtd`의 격리 Fleet에서 요약 체크포인트 두 번, 재시작 두 번, 초록 회상, 노랑/초록 정정 회상, `lina_context_expand` 실제 도구 호출과 원문 초록 복원을 확인했다. 논리 세션 ID·메시지 중복 없음·recoveryNeeded=false도 확인했다. 테스트 전용 freshTailEntries=1, 요약 출력8192 조건의 증거이며 기본 예산이나 장기 대화 품질을 보증하지 않는다. `native-context-live.json`의 archive-tool/restored-compaction/teardown과 종료0이 근거다.

독립 reviewer 01a084ed는807a33b에 한정해 PASS, 51 focused tests 통과를 보고했다. metadata 모델 비노출, ordinary 적격 출처·guard·예산 유지 확인. 지적한 epoch0 ID 누락은 두 번째 실제 turn의 nativeEntryIds를 검사하는 실패→통과 회귀로 수정했다. native compaction 후 projection ID가 실제 resident 원문과 같다는 보장은 아직 없다. 이 한계와 요약 프롬프트 변경의 독립 검토는 전체 완료 전 남은 항목이다.

동일 프로세스의 native 압축 알림 뒤에는 압축 전 원문을 resident ID 목록에서 제외하도록 보완했다. 압축 이후 새 turn은 계속 중복 제외한다. compact→turn→turn 회귀는 수정 전 실패, 수정 후 통과했으며 관련47개 검사와 타입 검사를 통과했다. 전체 재시작 native 원문 residency를 증명하는 변경은 아니다.

독립 조사01a084ea는 native compaction의 내부 turn에 managed source mapping이 없어 reopen 시 provenance 검사가 새 epoch를 만들 가능성을 가장 좁은 원인으로 제시했다. raw thread/read의 해당 turn ID·shape는 수집하지 못했으므로 직접 확인한 원인으로 단정하지 않는다. 미등록 turn을 임의 허용하지 않으며 출처 fail-closed 계약은 유지한다. 요약 거부의 실제 공개 응답은 이후 main이 별도 수집해 장문 출력과 보관 응답 표식 실행을 확인했다.
