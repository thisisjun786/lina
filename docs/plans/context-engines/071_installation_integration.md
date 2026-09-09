# 071 — 자체 엔진 설치 연결과 외부 어댑터 퇴역

상태: P. 060은 121060d에서 종료했고 561개 테스트·타입·린트·문서·CI·빌드와 독립 검토를 통과했다. 현재 부족한 것은 엔진 자체보다 실제 Fleet의 조립 경로다. 이 단위는 LINA/Codex가 같은 자료 owner를 사용하고, 개인 기억·페르소나·세션 컨텍스트·LIFE가 각자의 출처와 권한을 유지하도록 연결한다.

유형 satisfy-spec. 계기는 전체 자체 엔진 완성 요청과 070 실행이다. 목표는 외부 Honcho/OpenViking 없이 신규 설치가 동작하고 기존 설정에는 전환 필요 상태가 명시되는 것이다. 범위 밖은 사용자 설치·원격 데이터 변경, 라이브 provider 호출, UI, 푸시·PR 머지·배포다. 검증은 임시 stateRoot/가짜 RPC·fetch의 실제 Fleet HTTP/도구·종료·재시작·checkpoint 경로와 전체 관련 게이트다. 성공하면 080으로 진행하며, 라이브 자격 검증은 별도 허가가 필요하다. 기록은 070/071 및 session evidence/integration-*다. 새 시간·토큰 예산은 정하지 않는다. 저장 형식·복구·출처 문제가 남으면 B/C에서 수정하며 사용자 제품 결정이 필요한 세계·주기·금액은 미정 상태를 유지한다. 실행자 둘이 같은 패킷에 실패하면 주 에이전트가 회수한다.

## 현재 코드와 선행 순서

codex-fleet.ts는 아직 OpenVikingClient/workTools를 만들고 task executeTool의 네 인자만 사용한다. session-app.ts는 CompanionMemory 또는 Honcho MemoryBridge를 선택하고 직접 시작의 기본은 disabled다. manager.ts에는 Honcho namespace qualification/초기화·삭제 흐름이 남았다. 자체 EnginePolicyStore와 ResourceEngine은 존재하지만 Fleet 저장·HTTP·checkpoint에 연결되지 않았다. 기존 resourceRoot는 정적 asset 경로이므로 자료 DB 경로로 재사용하지 않는다.

구현 순서는 PR #3의 필요한 안정화 변경 확인 → own memory port와 외부 어댑터 제거 → 공유 자료/정책 owner 설치 → LIFE tier/비개발 활동 경계 → checkpoint/전체 통합 검증이다. 각 순서는 같은 integration 단위 안에서 검증되는 의존 관계이며 별도 제품 기능을 축소하는 구분이 아니다.

## PR #3 기준점

2026-09-08 GitHub 원본과 gh 조회로 [PR #3](https://github.com/thisisjun786/lina/pull/3)의 OPEN/Draft, head cefaffcbb4d767848ace6bc0151b9271bf336bf2, base dev, mergeCommit null을 다시 확인했다. 이 브랜치와 공통 조상은 0b68b2f40b8f4368a78111ad1228626886a43797이다. PR 본문의 전체·hosted 테스트는 상류 증거이며 결합 증거가 아니다. 다른 worktree의 dirty 파일은 읽어 옮기지 않는다. 원격 PR을 머지하지 않고 필요한 커밋의 소스 diff를 검토해 이 브랜치 변경과 결합한다.

특히 life-json canonical 호환·replay 재사용·손상 LIFE owner 격리 변경과 원래 제한에서 통과한 이미지 timeout 수정을 확인한다. 현재 양쪽 변경 교집합은 agents/store.ts, fleet/life-runtime-installation.ts, fleet/manager.ts, test/life-runtime-fleet-fixture.ts 네 파일이다. 이 파일은 전체 교체하지 않는다. .gitattributes의 upstream verbatim 경로와 출처 고지를 보존한다. 결합 후 기존 원래 timeout으로 테스트하고 timeout 상향/skip으로 통과시키지 않는다.

## 변경 지도

| 작업 | 경로 | 책임 |
| --- | --- | --- |
| MODIFY | `packages/lina-runtime/src/context/memory.ts` | 외부 delivery 구현 → Lina-owned memory status/port 및 비활성·legacy 전환 진단; 원격 호출 없음 |
| MODIFY | `packages/lina-runtime/src/context/backend.ts` | native/disabled 유지, legacy honcho는 migration-required로 구분하고 자동 native로 바꾸지 않음 |
| MODIFY | `packages/lina-runtime/src/context/channel.ts` | MemoryBridge 클래스 의존 대신 자체 port 사용 |
| MODIFY | `packages/lina-runtime/src/context/companion.ts` | 자체 port/status 타입, disabled 자동 학습 차단과 기존 기억 읽기 보존 |
| MODIFY | `packages/lina-runtime/src/persona/reflection.ts` | 자체 recall port로 연결, 개인 출처/비밀 필터 유지 |
| MODIFY | `packages/lina-runtime/src/session-app.ts` | 외부 옵션·MemoryBridge 제거, 기본 자체 기억·정책·정리·성장 lifecycle 조립 |
| MODIFY | `packages/lina-runtime/src/fleet/manager.ts` | 외부 qualification/namespace 삭제 경로 제거, 자체 상태·legacy 진단·초기화 실패 보존 |
| MODIFY | `packages/lina-runtime/src/fleet/codex-fleet.ts` | 공유 자료·EnginePolicyStore owner 초기화, host task context, 설치 lock 내 종료 순서 |
| NEW | `packages/lina-runtime/src/fleet/resource-runtime.ts` | 설치당 단일 ResourceStore, scope별 worker/search/tool consumer, 처리 중 요청 추적·취소·close |
| MODIFY | `packages/lina-runtime/src/resources/tools.ts` | 저장 완료 이벤트를 owner에 전달해 허용된 pending 작업 실행, scope는 host 전용 |
| MODIFY | `packages/lina-runtime/src/resources/task-consumer.ts` | 설치 owner의 실제 consumer와 동적 도구 명세 재사용 |
| MODIFY | `packages/lina-runtime/src/fleet/resource-routes.ts` | 실제 서버 owner·요청 scope·작업 상태 접점, 기존 stream/body/loopback guard 유지 |
| MODIFY | `packages/lina-runtime/src/fleet/server.ts` | 자료/정책 route 등록 및 owner 준비/거부 상태 노출 |
| MODIFY | `packages/lina-runtime/src/fleet/companion-routes.ts` | engine policy GET/PATCH와 expectedRevision CAS, host getter 반영 |
| MODIFY | `packages/lina-runtime/src/tools/work-memory.ts` | lina_work_*는 지원되는 안정 참조만 자체 자료 경로에 연결하거나 명시적 retired 오류; task 생성 없음 |
| MODIFY | `packages/lina-runtime/src/codex-prompt.ts` | 실제 도구와 개발/비개발 업무 의미에 맞는 지침 |
| MODIFY | `packages/lina-memory/src/index.ts` | 외부 export 제거, 자체 엔진 export 연결 |
| MODIFY | `packages/lina-runtime/src/checkpoint-cli.ts` | 로컬 자료/기억 포함 범위와 원격 과거 데이터 미포함 명시 |
| MODIFY | `packages/lina-runtime/src/checkpoint-barrier.ts` | 자료 owner가 기존 installation lock 종료 장벽을 준수하는 계약 |
| MODIFY | `packages/lina-core/src/world/authoring-types.ts` | exact 모델 또는 tier selector의 명시적 union |
| MODIFY | `packages/lina-core/src/world/authoring-request-validation.ts` | selector 입력 strict 검사 |
| MODIFY | `packages/lina-core/src/world/autonomy-persistence.ts` | 구버전 exact 해석 보존, 새 tier의 해석 결과를 step에 고정 |
| MODIFY | `packages/lina-core/src/world/autonomy-step-records.ts` | 저장 당시 selector/출처 형식별 replay 및 원래 fingerprint 유지 |
| MODIFY | `packages/lina-runtime/src/fleet/life-runtime.ts` | tier를 exact profile/effort/cap/settings revision으로 해석, outbound 현재성 검사 |
| MODIFY | `packages/lina-codex/src/life-model-policy.ts` | 동결된 요청과 실제 provider 선택 일치 검사 |
| MODIFY | `packages/lina-core/src/world/work-validation.ts` | codex-task/resource-activity origin union과 역사 v1 읽기 |
| MODIFY | `packages/lina-core/src/world/autonomy-source.ts` | origin별 현재 근거·grant·revision 확인 |
| MODIFY | `packages/lina-core/src/world/store.ts` | resource activity admission과 반복 방지·철회 |
| MODIFY | `packages/lina-runtime/src/life/work-source.ts` | 자료 version/memory 근거와 명시 grant 연결 |
| MODIFY | `packages/lina-runtime/src/life/work-bridge.ts` | task 없는 활동 기록의 admit/revoke, 기존 task receipt 보존 |
| MODIFY | `data/app-system-prompt.md` | 업무는 개발·조사·검색·글쓰기·정리 모두 포함, 원문/추론/개인 경험을 구분 |
| NEW | `packages/lina-runtime/test/engine-integration.test.ts` | 실제 Fleet HTTP/도구/정책/legacy/start-stop-restart |
| NEW | `packages/lina-runtime/test/resource-checkpoint.test.ts` | 설치 owner 종료·checkpoint·새 root 복원·원문과 기억 검증 |
| NEW | `packages/lina-runtime/test/life-resource-activity.test.ts` | task 없는 활동→명시 grant→LIFE 입력, 철회·중복·재시작 |

외부 production adapter 디렉터리 honcho/openviking 및 capture-scan.ts는 모든 import/exports/test/QA 소비자 전환 후 제거한다. 외부 adapter 전용 테스트는 성공 동작 유지 테스트로 남기지 않고 legacy 진단·무호출·원본 보존 검증으로 대체한다. deploy/honcho 및 원격 QA 경로는 필수 실행 경로에서 제외하고 retired 설명을 남긴다. 사용자의 원격 namespace나 설치 파일을 삭제하지 않는다.

## 설치 owner·권한·처리 흐름

자료 DB/blobs는 stateRoot 하위 전용 디렉터리, 엔진 정책은 별도 SQLite owner로 둔다. 설치당 자료 store 하나를 공유하고, agent별 principal/allowedVisibilities를 고정한 consumer를 만든다. 비동기 호출 사이에 전역 mutable scope를 바꿔 쓰지 않는다. TaskToolContext.agentId가 검증되지 않으면 null/shared-only이며 모델 JSON은 owner가 될 수 없다. 공유 자료 모델 서비스는 설치의 공통 routes를 사용하고 일반 대화의 지정 모델은 바꾸지 않는다.

저장은 기존 transaction에서 durable pending job을 만든 뒤 owner에게 알린다. 실행은 범위별 큐에서 신호 기반으로 이어가고 과거 prepared/unknown은 자동 재호출하지 않는다. 단순 읽기·검색은 capture나 task를 생성하지 않는다. worker/search/tool 요청을 모두 추적하여 stop에서 신규 진입 차단→abort→요청 join→store close→installation lock 해제 순서를 지킨다. 다른 agent의 작업 취소가 전체 store를 닫지 않는다. 초기화 실패도 이미 연 owner를 역순 정리한다.

신규 설치는 외부 URL 없이 native 기억/자료를 사용한다. disabled는 자동 학습 중지이며 원문·이전 기억 삭제가 아니다. legacy honcho 선택은 원격 요청을 하지 않고 migrationRequired 진단을 반환한다. 기존 honcho-outbox/원격 기억을 mind.sqlite에 이전했다고 주장하지 않는다. 실제 원격 export 가져오기는 이 실행의 권한 밖이다. 자체 DB 손상은 원본을 보존하고 실패 owner를 명시하며 일반 대화/작업이 계속되는 기존 LIFE 격리 계약과 일치시킨다.

## 필드의 전체 경로와 LIFE 계약

정책 snapshot3 입력 → EnginePolicyStore CAS/SQLite → strict read → session/worker/LIFE getters와 HTTP 응답. callback은 host-only이며 JSON 권한으로 직렬화하지 않는다. legacy 진단은 backend parser → App/Fleet status → API에서 노출하며 enum 누락/default 성공 처리를 금지한다.

모델 selector exact|tier는 authoring 입력·validation → config/step serialization → version별 decoder → runtime 선택·Codex policy로 전달한다. tier가 없거나 binding 미설정이면 not_configured로 step 생성을 거부한다. 새 step만 당시 exact model/effort/output cap/revision/fingerprint를 동결하며 과거 step은 새 설정으로 다시 해석하지 않는다.

resource-activity는 별도 origin, resource/version 또는 memory id, actor, activityKind, factual evidence, grant/revision을 가진다. 단순 자료 저장을 업무 완료나 개인 경험으로 바꾸지 않는다. 실제 산출물과 명시적 LIFE 공유 허용이 있어야 admit한다. 기존 task 기반 v1은 당시 decoder로 보존하고 신규 v2에 origin별 증거를 기록한다. source 변경/철회는 아직 실행하지 않은 LIFE 입력과 성장 projection에 반영하며 같은 activity id/revision은 중복 반영하지 않는다.

## 검증과 문서 동기화

P에서 확인한 실제 기준선은 060의 561테스트 및 타입/린트/CI/빌드 exit0다. 이는 integration 증거가 아니다. 새 테스트 경로는 B에서 직접 bun test로 실패부터 확인하며 존재하지 않는 테스트가 통과했다고 주장하지 않는다. 기존 Fleet/SessionApp/LIFE/checkpoint 테스트도 직접 포함하고, C에서 전체 타입·린트·관련 테스트·문서 구조·CI·빌드를 실행한다. 현재 문서 검사기는 번호·경로·의존성만 검사하고 의미 완전성은 독립 감사가 맡는다.

필수 발동 시나리오: 외부 host 없는 신규 start; legacy honcho의 provider 호출0 및 원본 보존; 실패 중간 owner 정리 후 재시작; A 저장→B/작업 없는 Codex 읽기; TaskManager 인계 중 비공개 응답 차단; 정책 stale CAS409; active owner checkpoint 거부와 종료 후 복원; resource activity grant 철회 중 provider await 결과 반영 금지; tier 변경 중 준비 step stale 및 완료 step 미재실행; LIFE 손상 후 일반 대화 유지; PR #3 이미지 시험의 기존 timeout 통과.

C에서 POLICY.md, README.md, docs/ARCHITECTURE.md, PERSONA_CONTEXT.md, CODEX_RUNTIME.md, PLANNING.md 및 000/004/070/071을 최종 소스 계약으로 맞춘다. 외부 adapter의 역사 문서·원격 데이터 미이전 경계는 명시한다. enforcement의 최종층은 host 권한 검사와 저장 감사이며 임의 로컬 코드/DB 수정은 우회 가능하다. 이를 적대적 로컬 관리자 방어라고 부르지 않는다.

위임: 주 에이전트는 PR source 결합·자료 owner/정책/Fleet·LIFE source/routing과 통합을 맡는다. A 후 executor는 독립 가능한 memory port/session-app/context/channel/persona/reflection 및 외부 adapter-only 소비자 퇴역을 맡되 manager/codex-fleet/world 파일은 수정하지 않는다. 초기 upstream 안정화 결합을 먼저 끝내 충돌 경계를 고정한다. 모든 범위와 검증은 시작 전 명시하고 독립 reviewer가 계획과 최종 구현을 검토한다.


## 상류 안정화의 정확한 포팅 지도

7979843 기준 이 브랜치 변경171개, PR 변경63개, 교집합4개다. 아래 경로는 공통 조상→cefaffc의 고정 diff를 검토해 적용한다. 교집합4개는 060까지의 자체 변경을 보존해 수동 결합하며 나머지도 변경 후 해당 기능 검증을 수행한다. 이미지 UI mockup·web QA 파일은 포팅하지 않는다. 이 작업은 GitHub PR 머지가 아니다.

| 작업 | 경로 | 책임 |
| --- | --- | --- |
| NEW | `.gitattributes` | PR #3의 고정 소스·회귀 검증·출처 보존 변경 |
| MODIFY | `packages/lina-core/src/agents/store.ts` | PR #3의 고정 소스·회귀 검증·출처 보존 변경 |
| MODIFY | `packages/lina-core/src/agents/visual-capacity.ts` | PR #3의 고정 소스·회귀 검증·출처 보존 변경 |
| MODIFY | `packages/lina-core/src/world/authoring-persistence.ts` | PR #3의 고정 소스·회귀 검증·출처 보존 변경 |
| MODIFY | `packages/lina-core/src/world/autonomy-persistence.ts` | PR #3의 고정 소스·회귀 검증·출처 보존 변경 |
| MODIFY | `packages/lina-core/src/world/autonomy-step-records.ts` | PR #3의 고정 소스·회귀 검증·출처 보존 변경 |
| MODIFY | `packages/lina-core/src/world/image-discovery.ts` | PR #3의 고정 소스·회귀 검증·출처 보존 변경 |
| MODIFY | `packages/lina-core/src/world/image-persistence.ts` | PR #3의 고정 소스·회귀 검증·출처 보존 변경 |
| MODIFY | `packages/lina-core/src/world/life-json.ts` | PR #3의 고정 소스·회귀 검증·출처 보존 변경 |
| MODIFY | `packages/lina-core/src/world/life-persistence.ts` | PR #3의 고정 소스·회귀 검증·출처 보존 변경 |
| MODIFY | `packages/lina-core/src/world/social-persistence.ts` | PR #3의 고정 소스·회귀 검증·출처 보존 변경 |
| MODIFY | `packages/lina-core/src/world/store.ts` | PR #3의 고정 소스·회귀 검증·출처 보존 변경 |
| MODIFY | `packages/lina-core/test/agent-visual-capacity.test.ts` | PR #3의 고정 소스·회귀 검증·출처 보존 변경 |
| NEW | `packages/lina-core/test/fixtures/life-json-real-states.json` | PR #3의 고정 소스·회귀 검증·출처 보존 변경 |
| NEW | `packages/lina-core/test/life-image-event-discovery.test.ts` | PR #3의 고정 소스·회귀 검증·출처 보존 변경 |
| MODIFY | `packages/lina-core/test/life-image-policy-store.test.ts` | PR #3의 고정 소스·회귀 검증·출처 보존 변경 |
| NEW | `packages/lina-core/test/life-json-compatibility.test.ts` | PR #3의 고정 소스·회귀 검증·출처 보존 변경 |
| NEW | `packages/lina-core/test/life-json-reference-fixture.ts` | PR #3의 고정 소스·회귀 검증·출처 보존 변경 |
| NEW | `packages/lina-core/test/life-replay-reuse.test.ts` | PR #3의 고정 소스·회귀 검증·출처 보존 변경 |
| MODIFY | `packages/lina-runtime/src/fleet/agent-visual-routes.ts` | PR #3의 고정 소스·회귀 검증·출처 보존 변경 |
| MODIFY | `packages/lina-runtime/src/fleet/life-image-routes.ts` | PR #3의 고정 소스·회귀 검증·출처 보존 변경 |
| MODIFY | `packages/lina-runtime/src/fleet/life-images.ts` | PR #3의 고정 소스·회귀 검증·출처 보존 변경 |
| MODIFY | `packages/lina-runtime/src/fleet/life-routes.ts` | PR #3의 고정 소스·회귀 검증·출처 보존 변경 |
| MODIFY | `packages/lina-runtime/src/fleet/life-runtime-installation.ts` | PR #3의 고정 소스·회귀 검증·출처 보존 변경 |
| MODIFY | `packages/lina-runtime/src/fleet/manager.ts` | PR #3의 고정 소스·회귀 검증·출처 보존 변경 |
| MODIFY | `packages/lina-runtime/src/images/life-destinations.ts` | PR #3의 고정 소스·회귀 검증·출처 보존 변경 |
| MODIFY | `packages/lina-runtime/src/images/life-discovery.ts` | PR #3의 고정 소스·회귀 검증·출처 보존 변경 |
| MODIFY | `packages/lina-runtime/src/images/life-scheduler.ts` | PR #3의 고정 소스·회귀 검증·출처 보존 변경 |
| MODIFY | `packages/lina-runtime/src/images/life.ts` | PR #3의 고정 소스·회귀 검증·출처 보존 변경 |
| MODIFY | `packages/lina-runtime/test/agent-visual-routes-http.test.ts` | PR #3의 고정 소스·회귀 검증·출처 보존 변경 |
| NEW | `packages/lina-runtime/test/life-acceptance-fixture.ts` | PR #3의 고정 소스·회귀 검증·출처 보존 변경 |
| NEW | `packages/lina-runtime/test/life-checkpoint-child.ts` | PR #3의 고정 소스·회귀 검증·출처 보존 변경 |
| NEW | `packages/lina-runtime/test/life-checkpoint.test.ts` | PR #3의 고정 소스·회귀 검증·출처 보존 변경 |
| NEW | `packages/lina-runtime/test/life-e2e.test.ts` | PR #3의 고정 소스·회귀 검증·출처 보존 변경 |
| NEW | `packages/lina-runtime/test/life-image-destination-capacity.test.ts` | PR #3의 고정 소스·회귀 검증·출처 보존 변경 |
| MODIFY | `packages/lina-runtime/test/life-image-fleet-automatic.test.ts` | PR #3의 고정 소스·회귀 검증·출처 보존 변경 |
| MODIFY | `packages/lina-runtime/test/life-image-fleet-composition.test.ts` | PR #3의 고정 소스·회귀 검증·출처 보존 변경 |
| MODIFY | `packages/lina-runtime/test/life-image-fleet-event.test.ts` | PR #3의 고정 소스·회귀 검증·출처 보존 변경 |
| NEW | `packages/lina-runtime/test/life-image-manual-event.test.ts` | PR #3의 고정 소스·회귀 검증·출처 보존 변경 |
| NEW | `packages/lina-runtime/test/life-image-pause-recovery.test.ts` | PR #3의 고정 소스·회귀 검증·출처 보존 변경 |
| MODIFY | `packages/lina-runtime/test/life-image-runtime.test.ts` | PR #3의 고정 소스·회귀 검증·출처 보존 변경 |
| NEW | `packages/lina-runtime/test/life-image-scheduler-archive.test.ts` | PR #3의 고정 소스·회귀 검증·출처 보존 변경 |
| MODIFY | `packages/lina-runtime/test/life-image-scheduler.test.ts` | PR #3의 고정 소스·회귀 검증·출처 보존 변경 |
| MODIFY | `packages/lina-runtime/test/life-runtime-fleet-fixture.ts` | PR #3의 고정 소스·회귀 검증·출처 보존 변경 |
| NEW | `packages/lina-runtime/test/life-storage-isolation.test.ts` | PR #3의 고정 소스·회귀 검증·출처 보존 변경 |
| MODIFY | `packages/lina-runtime/test/session-app.test.ts` | PR #3의 고정 소스·회귀 검증·출처 보존 변경 |
| MODIFY | `packages/lina-runtime/vendor/ensemble/README.md` | PR #3의 고정 소스·회귀 검증·출처 보존 변경 |

외부 어댑터 표기가 남은 테스트/fixture는 현재26개다. production SDK npm 의존성은 package.json에서 발견되지 않았으므로 불필요한 새 패키지 변경은 하지 않는다. 제거 대상은 자체 HTTP adapter와 그 production 소비 경로다. 071의 자체 memory port는 class 상속을 유지할 필요가 없으며 status/refresh/recall/shutdown 등 실제 SessionApp/ContextChannel/PersonaReflection 소비 계약을 타입으로 보존한다.


## A 소스 점검: LIFE 타입 소비 경로 보완

현재 WorkReceiptProvenance는 taskId/turnId가 필수이며 WorkEvidenceSnapshot은 version1뿐이다. 따라서 task 없는 활동에 가짜 taskId를 채우지 않는다. 신규 v2 record의 origin을 codex-task/resource-activity로 구분하고 공통 귀속/결과와 origin별 원문 참조를 분리한다. 기존 v1 JSON은 필드 추가 없이 당시 parser를 유지한다. source를 공통 task 형태로 normalize해 과거 digest를 바꾸지 않는다.

| 작업 | 경로 | 책임 |
| --- | --- | --- |
| MODIFY | `packages/lina-core/src/world/work-types.ts` | origin/selector 전체 타입·생성·복원·소비 체인; 역사 v1 보존 |
| MODIFY | `packages/lina-core/src/world/life-types.ts` | origin/selector 전체 타입·생성·복원·소비 체인; 역사 v1 보존 |
| MODIFY | `packages/lina-core/src/world/work-ancestry.ts` | origin/selector 전체 타입·생성·복원·소비 체인; 역사 v1 보존 |
| MODIFY | `packages/lina-core/src/world/publication-reply-material.ts` | origin/selector 전체 타입·생성·복원·소비 체인; 역사 v1 보존 |
| MODIFY | `packages/lina-core/src/world/work-persistence.ts` | origin/selector 전체 타입·생성·복원·소비 체인; 역사 v1 보존 |
| MODIFY | `packages/lina-core/src/world/life-validation.ts` | origin/selector 전체 타입·생성·복원·소비 체인; 역사 v1 보존 |
| MODIFY | `packages/lina-core/src/world/autonomy-types.ts` | origin/selector 전체 타입·생성·복원·소비 체인; 역사 v1 보존 |
| MODIFY | `packages/lina-core/src/world/autonomy-store-types.ts` | origin/selector 전체 타입·생성·복원·소비 체인; 역사 v1 보존 |
| MODIFY | `packages/lina-core/src/world/autonomy-record-validation.ts` | origin/selector 전체 타입·생성·복원·소비 체인; 역사 v1 보존 |
| MODIFY | `packages/lina-core/src/world/autonomy-model-receipts.ts` | origin/selector 전체 타입·생성·복원·소비 체인; 역사 v1 보존 |
| MODIFY | `packages/lina-core/src/world/publication.ts` | origin/selector 전체 타입·생성·복원·소비 체인; 역사 v1 보존 |
| MODIFY | `packages/lina-core/src/world/index.ts` | origin/selector 전체 타입·생성·복원·소비 체인; 역사 v1 보존 |
| MODIFY | `packages/lina-runtime/src/life/actor.ts` | 새 step의 동결 route로 model request 생성; 역사 request decoder와 분리 |
| MODIFY | `packages/lina-runtime/src/life/model-port.ts` | 새 step의 동결 route로 model request 생성; 역사 request decoder와 분리 |

현재 lifePlan fingerprint는 version1이다. 신규 tier 선택의 exact profile/effort/output cap은 step 생성 시에 고정하고 model request와 native plan에 연결한다. publication도 actor selector를 소비하므로 publication의 동결 시점과 요청 검사를 같은 계약으로 수정한다. 대화 모델·주기·금액을 selector 지원의 기본값으로 자동 채우지 않는다. source별 키/DDL와 version별 decoder의 구체 필드는 독립 A에서 현재 work persistence와 대조해 고정한 뒤 B로 넘어간다.

A 기준선 검증: `bun test packages/lina-runtime/test/codex-fleet.test.ts packages/lina-runtime/test/memory-backend.test.ts packages/lina-runtime/test/checkpoint-barrier.test.ts` → exit0, 7 pass/0 fail, 20 assertions/3 files. 명령이 실제 세 경로를 읽음을 확인했다. 이 결과는 기존 상태 기준선이며 새 integration 구현의 완료 증거가 아니다. session evidence/integration-baseline.log에 저장했다.

## 독립 A 1차 수용

snapshot v2와 기존 input/step/native/publication 버전이 섞여 있던 설명을 004의 독립 discriminator 계약으로 고정했다. mixed records는 snapshot v2의 origin union이며 역사 v1은 그대로 읽는다. 최초 전환을 world history upgrade 행과 같은 transaction으로 기록한다. TaskToolContext의 null-agent는 자료 사용만 가능하고 LIFE activity 생성은 금지한다. 기존 task attribution 규칙은 그대로 두며, 자료 활동의 actor는 host가 확인한 world participant다. 자료 revision/version/memory/grant를 별도 staleness 기준으로 정하고 verified_result의 실제 원문 인용 검사를 명시했다.

| 작업 | 경로 | 책임 |
| --- | --- | --- |
| MODIFY | `packages/lina-runtime/src/resources/services.ts` | store ownership과 모든 worker/search/tool 실행 join, wrapper만으로 close를 가정하지 않음 |
| MODIFY | `packages/lina-opencodex/src/prompts.ts` | live prompt의 Honcho 명칭을 자체 기억 의미로 교체, 도구·근거 규칙 유지 |
| MODIFY | `THIRD_PARTY_NOTICES.md` | 제거한 디렉터리와 남긴 흡수 코드/라이선스의 실제 출처 정합 |
| MODIFY | `packages/lina-core/src/world/work-experience.ts` | task/resource origin별 경험 provenance, recorded는 업무 성공으로 해석하지 않음 |
| NEW | `packages/lina-memory/src/resources/activities.ts` | resource activity/grant revision·전달 outbox, 원문과 기억 scope 검증 |

자료 활동 owner는 설치 resources 하위 별도 activities.sqlite(schema1)다. 기존 resource catalog schema2를 다시 의미 변경하지 않는다. `resource_activities(id PRIMARY KEY, revision INTEGER, data TEXT)`와 `resource_activity_deliveries(activity_id,activity_revision,world_id,grant_revision,state,data,PRIMARY KEY(activity_id,activity_revision,world_id,grant_revision))` STRICT 테이블을 사용한다. data에는 004 receipt와 실제 source snapshot, grant의 actor/world/허용 fields/revision을 저장하며 열과 strict JSON을 재개방에서 대조한다. 호출자의 activity id/revision CAS와 operation receipt로 중복을 막는다. grant는 모델 출력에서 생성하지 않고 host의 확인된 source owner 요청에서만 만든다. 철회는 revision 증가+restrict delivery를 같은 transaction으로 기록한다. 원문 변경은 현재성 검사에서 즉시 차단하며 미실행 LIFE 입력에 restrict를 전달한다. 체크포인트는 이 DB도 같은 설치 lock 범위로 포함한다.

지적 수용 상태: schema versioning·null attribution 두 blocker와 services.ts/prompts.ts/notices 누락 세 항목 모두 명시했다. 독립 재검토가 끝나기 전 B로 넘어가지 않는다.

activity 원자적 재시도 기록은 `resource_activity_operations(operation_id TEXT PRIMARY KEY,activity_id TEXT NOT NULL,revision INTEGER NOT NULL,fingerprint TEXT NOT NULL,result TEXT NOT NULL,UNIQUE(activity_id,revision)) STRICT`에 남긴다. 같은 operation id와 동일 입력은 저장된 결과를 반환하고 다른 입력은 conflict다. activity projection·revision·delivery와 operation receipt는 한 transaction에서 commit한다. 재개방은 각 activity의 연속 revision과 마지막 결과/projection, grant 철회 상태, delivery 참조를 대조한다. 원본 source는 원래 resource store에 남으며 activity owner가 별도 파일 경로를 모델에게 받지 않는다.

A 최종 PASS의 정밀화: activity schema의 모든 필수 열과 복합 key에는 NOT NULL을 명시한다. resource_activities는 `(id TEXT PRIMARY KEY,resource_id TEXT NOT NULL,actor_agent_id TEXT NOT NULL,revision INTEGER NOT NULL,data TEXT NOT NULL) STRICT`로 고정하고 id/resource/actor/revision을 JSON과 대조한다. deliveries의 activity_id/activity_revision/world_id/grant_revision/state/data와 operations의 모든 필수 열도 NOT NULL이다. 별도 DB이므로 catalog에 대한 SQLite FK를 주장하지 않는다. host가 admission·read/delivery·reopen에서 resource/version 참조를 실제 catalog로 확인한다. 보정 supersedesRevision은 첫 revision만 null, 이후 revision-1이다. task의 기존 outcome 네 값과 resource의 recorded를 parser별로 구분한다.

### 세션 기억 전환 구현 기록

SessionApp의 기본 선택을 자체 CompanionMemory로 통일했다. disabled도 기존
로컬 기억을 열되 자동 학습을 막고, legacy honcho는 파일·원격 기억을 읽지 않는
migrationRequired 상태를 반환한다. Fleet 기억 초기화 API도 재연결 안내 대신
명시적인 전환 오류를 반환한다. 기존 외부 전용 reflection 실행은 제거하고
자체 관찰·페르소나 성장 경로를 사용한다.

폐기된 외부 초기화·전송 계약의 테스트와 capture-scan은 제거했다. 대체 검증은
session-app의 기본/disabled/legacy 선택 및 outbox 원본 보존, Fleet HTTP 전환
오류, context-memory의 대화 상태 불변, companion-memory의 출처·정착·페이지·
재시작·취소 검증이다. 온보딩의 출처 철회 검증은 외부 fixture 없이 유지했다.
수동 압축 회귀는 freshTailEntries=0을 지정해 요약 경로를 실제로 실행한다.

2026-09-09 로컬 임시 DB/가짜 세션 검증: 9개 파일 62개 테스트 통과,
루트·브라우저 타입 검사 통과. 기록은 session evidence의
integration-session-retirement-green.log 및 integration-retirement-types.log다.
전체 071 완료나 라이브 모델 검증을 뜻하지 않는다.

외부 어댑터 production 디렉터리 및 해당 전용 테스트를 제거했다.
TypeScript 소비자 검색에서 HonchoClient/OpenVikingClient와 어댑터 import가
남지 않는 것을 확인했다. 기존 QA 진입점은 외부 서비스·파일 접근 전에
retired 오류를 반환하며, deploy/honcho는 과거 설치 참고 자료로 표시했다.
기존 라이선스 검토 기록은 보존했다. 이 변경 뒤 lina-memory 전체 129개
테스트, 루트·브라우저 타입 검사, 전체 lint가 통과했다. lint에는 기존
warning/info가 남아 있으며 라이브 원격 데이터의 이전·삭제는 실행하지 않았다.

독립 리뷰의 실행 중 정책 변경 지적을 반영했다. memoryMode는 대화마다 현재
정책을 읽으며, 준비한 프롬프트 이후 정책이 바뀌면 전송을 거부한다. 비활성
상태에서는 자동 저장 안내도 넣지 않는다. 실제 SessionApp에서 settled 원문을
넣고 observer 호출 수를 검증했다: native는 정책을 켜야 호출하고, disabled는
정책 값이 켜져도 호출하지 않는다. 관련 15개 테스트 통과.

031의 `engine_disabled/honcho이면 native owner를 만들지 않는다`는 초기
lifecycle 설명 중 disabled 처리만 이 단위에서 구체화한다. 명시적으로 세션을
여는 경우 disabled는 기존 로컬 기억을 읽을 수 있도록 자체 owner를 사용하지만
자동 학습과 성장 투영은 비활성화한다. inactive agent의 출처를 조회하려고 새
세션을 시작하지 않는 031의 규칙과 honcho 자동 전환 금지는 그대로 적용한다.

자료 복구 경계에서 두 회귀를 재현하고 수정했다. 대기 중 또는 실행 중인
자료 요청이 있으면 복구를 거부하고, Fleet 자료 엔진 생성 중 복구가 실패하면
카탈로그를 닫은 뒤 오류를 전달한다. 실패 뒤 같은 임시 DB를 새 owner로 열어
복구할 수 있는지도 검사했다. integration-recovery-*-red.log에 수정 전 실패,
integration-recovery-green.log에 3개 파일 12개 테스트 통과, types.log에 루트·
브라우저 타입 검사 통과를 기록했다. 시작 전 손상 원본 보존의 전체 검증과
설치 체크포인트 검증은 별도 잔여 항목이다.

설치 잠금을 보유한 실제 FleetResources에서 체크포인트 생성이 거부됨을
검증했다. owner 종료 뒤 체크포인트를 만들고 새 임시 경로로 복원한 다음,
자료 catalog의 안정 참조와 원문 blob을 다른 에이전트 범위에서 다시 읽었다.
integration-resource-checkpoint.log: 1개 테스트·3개 단언 통과. 실제 전체 Fleet
종료 지연이나 활동 원장·이미지 owner까지 포함한 최종 수용 검증은 아직 남았다.

자료 저장소도 LIFE와 같은 복사본 선검사 경계를 적용했다. 설치 잠금 확인 후
catalog/WAL/journal과 blob을 임시 경로에 복사하고, 그곳에서 schema·migration·
복구를 검증한 뒤 원본을 연다. 복사 전후 원본 파일 목록·inode·크기·시각을
확인하고, SQLite shared-memory index는 원본에서 읽기 검증만 하고 복사본에서
재생성한다. 심볼릭 링크·하드링크를 따라가지 않고 임시 경로만 정리한다.

강제 종료된 임시 writer가 남긴 손상 WAL에서 시작 검사가 원본 DB/보조 파일을
변경하는 실패를 먼저 재현했다. 수정 후 원본 바이트가 모두 보존됐으며, 정상
WAL의 기록은 같은 검사 뒤 원문까지 복구됐다. integration-resource-preservation-
red/green/types.log: 9개 통합 테스트·40개 단언 및 루트·브라우저 타입 검사 통과.

복사본 선검사는 독립 리뷰 PASS를 받았다(리뷰어가 통합 테스트 9개를 직접 실행).
현 구현은 시작 시 blob 복사·probe 검증·원본 검증의 I/O 비용이 있고, catalog와
WAL 복사는 파일 전체를 메모리에 올린다. 임시 복사본은 0700/0600이며 정상
종료·예외에서 삭제된다. 프로세스 강제 종료 후 남은 임시 경로는 다른 설치의
실행 중 probe와 구별되지 않으므로 이름 패턴만으로 자동 삭제하지 않는다.

LIFE 모델 선택의 첫 연결을 구현했다. Fleet의 기존 exact profile 검색을
`life/model-selection.ts`로 모아 provider/model 중복 거부를 유지했다. 같은
해석기는 명시적 tier를 공통 routes로 해석해 reasoning/output cap을 반환하며
대화 기본값으로 fallback하지 않는다. 기존 Fleet 실행 회귀와 4단계 해석 테스트
12개가 통과했다. 아직 authored config의 tier 허용과 Step v4/새 model request에
해석 결과를 저장하는 연결은 미완료이므로 LIFE tier 기능 완료로 간주하지 않는다.

새 모델 요청 v3의 계약을 먼저 연결했다. 정확 선택은 profileId/provider/model/
reasoning/maxOutputTokens/settingsRevision의 canonical LIFE digest를
routeFingerprint로 갖는다. 출력 한도 미지정은 null로 보존해 임의 예산을 만들지
않는다. parser는 step 요청 v1 및 publication 요청 v2를 기존 parser로 검증한 뒤
v3 selection과 모델·revision·출력 한도를 대조한다. 옛 요청에 필드를 추가하지
않는다. 네이티브 lifePlan은 v3의 실제 profile/effort/cap과 고정 선택이 다르면
준비를 거부하며 fingerprint envelope v2에 선택을 포함한다.

Fleet의 기존 실행 owner는 아직 요청 v3을 받지 않는다. Step v4와 새 publication
owner를 구현할 때 이 임시 거부 경계를 제거해야 한다. 요청 계층만 구현된 상태를
LIFE tier 활성화 완료로 주장하지 않는다. 과거 native fingerprint의 전체 호환성도
별도 수용 검증 대상이다. 4개 파일 18개 테스트·85개 단언 통과에는 실제 임시
journal의 v1/v3 재개방과 initial.json 바이트 보존이 포함된다. provider 호출은 0이다.

공통 WorkRuleOutcome에는 자료 활동의 recorded를 추가하되 task receipt의
WorkOutcome 네 값은 유지했다. recorded 규칙 허용과 task receipt 거부를 함께
검증했으며 기존 설정·입력 회귀 포함 8개 테스트·35개 단언이 통과했다.
또한 LINA_LIFE_NATIVE_TEST=1로 로컬 가짜 provider를 사용하는 실제 Codex 부모
재시작/경쟁 프로세스 시험을 실행했다. 준비·결과 journal 복원 및 한 번 전송을
확인했다(1개 테스트·17개 단언). 이는 같은 코드 버전의 네이티브 프로세스 증거이며
실제 모델 품질이나 과거 코드 버전의 fingerprint 호환성을 증명하지는 않는다.

동일한 실제 프로세스 재시작·경쟁 실행 시험을 새 모델 요청 v3에도 확장했다.
고정 선택을 가진 요청을 prepare한 뒤 별도 부모 프로세스에서 복원·동시 complete·
결과 재복원을 수행했고, 로컬 provider 전송은 한 번이었다. native v3 시험
1개·17개 단언이 통과했다. Fleet Step v4와의 연결 완료 증거로 대체하지 않는다.

ResourceActivityReceipt/Source는 기존 work-types.ts에 공통 타입으로 정의하고,
work-activity-validation.ts에서 구조 검증한다. 이 검사는 실제 blob·grant 검증을
대체하지 않는다. WorkEvidenceSnapshot은 v1 또는 origin wrapper를 가진 v2로
읽으며, v1에 wrapper를 섞거나 origin과 source 종류가 다르면 거부한다. 자료
활동의 actor와 revision으로 선택·경험 식별을 계산하되 가짜 task 필드는 만들지
않는다. 기존 WorkPersistence는 아직 v1 이력을 쓰며, legacy step은 v2 source를
거부한다. 다음 연결은 원자적 upgrade history와 첫 자료 입력 admission이다.
관련 6개 파일 24개 테스트·120개 단언, 루트·브라우저 타입 검사 통과.

새 ancestry 참조는 version2/origin을 갖고 전체 source를 포함한 digest로 검증한다.
옛 참조는 기존 digest를 유지하며 자료 활동에 재사용할 수 없다. v2 records의
순서는 origin과 receipt/activity ID로 고정해 입력 순서가 달라도 같은 snapshot을
만든다. 역순 입력 회귀를 먼저 실패시킨 뒤 정렬을 적용했다. 자료 활동의 선택·
공유 필드 투영과 작업 ID와의 경험 충돌 방지도 테스트했다. 관련 14개 테스트가
통과했다. actual world history의 upgrade transaction은 아직 다음 작업이다.

LifeInput v4 구조 검증과 trusted admitWorkInput의 자료 경로를 연결했다. 최초
자료 입력 전에 upgrade/version2 이력 한 행을 남기고 기존 task records를 감싼다.
upgrade와 입력 admission은 WorldStore의 같은 transaction에서 commit한다.
입력 충돌로 실패하면 전환 이력·projection도 롤백된다. reopen은 각 history 행의
previous/next digest로 v1→v2 과정을 다시 구성한다. 같은 입력 재송신은 기존
receipt를 반환하고 원래 task 입력 재송신도 유지된다. 자료 grant revision만
증가한 제한 입력은 활동 내용을 바꾸지 않는 범위에서 허용한다.

관련 6개 파일 31개 테스트·146개 단언이 통과했고, grant 제한 추가 뒤 store
5개 테스트·28개 단언 및 루트·브라우저 타입 검사도 통과했다. Step v4 연결 전에는
legacy step이 v4 입력을 거부하므로 아직 전체 LIFE 실행 완료 상태는 아니다.
