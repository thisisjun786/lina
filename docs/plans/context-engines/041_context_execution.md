# 041 — 컨텍스트 정책의 실제 실행 경로

상태: context 구현 및 독립 B 검토 통과, C 검증 대상. 040의 변경 지도를 실제 소스에 맞춰 보완한다. 구현 전 A 검토가 필요하다.

## 실행 범위

C4 satisfy-spec, 사용자 승인된 자체 엔진 목표의 context 단위다. 직전 persona D는 `a2f5575`에서 원본별 소유권과 공유 행동을 검증했으며, 다음 방향은 source-linked configurable session context다. 그 방향을 유지한다. 별도 시간·토큰 예산은 없다. 정책 생성→요약→저장→재시작→일반 요청/복원 도구 소비를 마치면 닫는다. UI·외부 provider 품질·설치 설정 UI·실제 데이터 이전·푸시/머지는 범위 밖이다. SoT 갱신은 docs/ARCHITECTURE.md와 docs/PERSONA_CONTEXT.md다.

## 현존 소스와 변경 이유

- `context/tree.ts`는 28000자와 64개 참조로 청크를 만들지만 긴 원문의 label/prefix가 청크 한도에 포함되지 않는다. max source/summary character ceiling은 저장 프로토콜 제한으로 남겨야 한다.
- `context/summarize.ts`는 입력32768자, 출력8192자, 호출 [2048,512]를 고정한다. 기존 extractive fallback은 누락을 명시하지만 external checkpoint는 fallback이 섞이면 활성화를 거부한다. 이 안전장치를 유지한다.
- `context/external.ts`는 완료한 적격 원문을 전부 요약하며 마지막 source ID를 checkpoint 경계로 쓴다. 최근 원문을 제외할 정책과 토큰 갱신 기준을 추가한다. 이전 checkpoint 실패 시 그대로 보존한다.
- `context/coordinator.ts`는 현재 working/recall 주입 후 external summary가 남은 예산에 맞을 때만 추가한다. 현재성 검사는 유지하고, 예산 정책/추정 방식/누락을 상태로 노출한다.
- `context/native.ts`는 native가 고른 cut을 검증하는 경계다. OpenCodex services.prepare는 명시적으로 미지원이며 Codex가 compaction을 소유한다. native cut을 Lina가 임의로 옮기지 않는다. 정책의 최근 원문 보존은 Lina external checkpoint에 적용하고, 실제 일반 요청의 최근 원문 재주입도 예산/중복 검사를 거쳐 연결한다. native compaction 설정을 제어했다고 주장하지 않는다.
- ContextStore v2는 text/sources/proofs fingerprint만 보관한다. CACHE는 WeakMap이며 재시작하면 사라진다. 정책·route 식별을 가진 새 summary generation metadata와 재사용 조회를 영속 owner에 추가한다.
- `context/tools.ts`는 검색20건/확장4096자 상수이며 검색 요청 수를 추적하지 않는다. activeRequestId를 기준으로 호출 한도를 관리하고, source cursor를 보존한 토큰 제한 페이지를 반환한다.

## 계약과 전체 필드 경로

새 `ContextBudgetPolicy`는 기존 권한 계약 SessionContextPolicy와 별개다. `{version:1, leafInputTokens, leafOutputTokens, condensedOutputTokens, freshTailEntries, expansionTokens, refreshThresholdTokens, maxSearchCalls}` safe integer를 검증한다. snapshot에는 revision을 둔다. 생성: context/policy.ts parser/default + AppOptions injected getter. 저장: integration070의 설정 owner가 맡으며 이 단위에는 새로운 설정 DB를 만들지 않는다. 소비: tree/summarize/external/coordinator/tools와 session-app의 실제 연결. 알 수 없는 version/field는 거부한다.

기본값은 현재 구현의 기술적 한도에 맞춘 보수적 엔진 설정이며 사용자 비용 예산이나 세계 주기는 아니다. leaf 입력7000, 출력2048, condensed512, freshTail4, expansion1024, refresh3000, search8을 초기 후보로 검사한다. caller가 요청별 명시 정책을 주면 그것을 사용한다. output은 provider/catalog/profile cap과 min을 취한다. 모델 라우트의 summaryCacheKey와 정책 전체 digest가 생성 식별에 포함된다. 일반 대화 모델은 고정 선택을 유지한다.

토큰 추정기는 선택 가능한 정확한 tokenizer가 현재 연결돼 있지 않음을 명시한다. 이 단위의 fallback은 UTF-8 byte 기반 보수적 상한 추정이며 ContextServices.estimateText를 정확한 토큰 수로 둔갑시키지 않는다. 지원되는 trusted estimator를 주입할 수 있고 stable estimator ID가 생성 fingerprint와 상태에 들어간다. 추정값이 NaN/음수/unsafe면 거부한다. prefix·label·원문·JSON envelope까지 입력 한도에 포함하며 surrogate를 나누지 않는다. 한 code point조차 담기지 않는 정책은 실패하고 원문 offset을 전진시키지 않는다.

새 generation metadata는 version1, policy digest/snapshot, route key, estimator ID를 고정한다. core/context/types.ts → strict decoder → stage fingerprint → summary generation sidecar → SummaryRecords.inspect/validate → tree cache lookup의 전체 경로다. v2 과거 summary ID/fingerprint/원문 bytes는 유지하고 metadata 없음은 legacy로 읽는다. 신규 metadata가 있는 summary만 동일 generation으로 재사용한다. 단순 policy revision이 같아도 값이 다르면 cache hit이 아니다. 새 정책으로 재생성해도 과거 활성 checkpoint를 먼저 폐기하지 않는다. source proofs가 달라지거나 철회되면 캐시를 재사용하지 않는다.

원문 span offset은 요약 text의 trusted host label과 sources 링크로 복원한다. 상위 요약은 하위 요약 전체를 입력으로 읽는다. raw source 삭제/누락을 성공으로 취급하지 않는다. 작은 한도에서 leaf가 요약돼도 상위 fan-in이 수렴하지 않으면 명시 실패한다.

## 추가 변경 지도

| 작업 | 파일 | 책임 |
| --- | --- | --- |
| NEW | `packages/lina-runtime/src/context/policy.ts` | 정책 parser/default/digest와 estimator 계약 |
| NEW | `packages/lina-runtime/src/context/budget.ts` | 전체 입력 측정과 Unicode 안전 prefix/page packing |
| MODIFY | `packages/lina-runtime/src/context/tree.ts` | 토큰별 leaf/parent packing, generation 캐시, 현재성 guard |
| MODIFY | `packages/lina-runtime/src/context/summarize.ts` | 호출 output 정책, extractive fallback 및 한도 검증 |
| MODIFY | `packages/lina-runtime/src/context/external.ts` | fresh tail, threshold, 정책 snapshot, 이전 checkpoint 유지 |
| MODIFY | `packages/lina-runtime/src/context/coordinator.ts` | 실제 injection budget과 정책/추정/누락 상태, policy changed guard |
| MODIFY | `packages/lina-runtime/src/context/tools.ts` | 요청별 bounded search, cursor를 유지한 expansion budget |
| MODIFY | `packages/lina-runtime/src/session-app.ts` | injected context policy/estimator를 모든 실제 consumer에 연결 |
| MODIFY | `packages/lina-runtime/src/context/port.ts` | trusted estimator metadata, 별도 권한 부여 없음 |
| MODIFY | `packages/lina-core/src/context/types.ts` | generation metadata와 expansion 옵션 |
| MODIFY | `packages/lina-core/src/context/schema.ts` | v2 보존 후 generation sidecar 추가, startup 감사 |
| MODIFY | `packages/lina-core/src/context/store.ts` | generation 저장/lookup, 소유 transaction 재사용 |
| MODIFY | `packages/lina-core/src/context/summary-records.ts` | metadata decode 및 변조/출처 검사 |
| MODIFY | `packages/lina-core/src/context/validation.ts` | versioned generation fingerprint, legacy bytes 보존 |
| MODIFY | `packages/lina-core/src/context/expansion.ts` | trusted bounded page 옵션과 offset 검증 |
| NEW | `packages/lina-runtime/test/context-budget-recovery.test.ts` | 실제 원문/요약/재시작/요청 연결 및 예산 변화 |
| NEW | `packages/lina-core/test/context-generation.test.ts` | v2 이전/변조/캐시/rollback file DB |

## 수용 시나리오와 위임

- 긴 한글·emoji·tool 원문과 작은 정책: 모든 원문 구간을 leaf 입력에서 확인하며 full envelope 토큰 한도를 넘지 않는다. expansion으로 정확한 원문 복원.
- 정책 변경/route 변경/추정기 ID 변경 후 새 호출; 같은 입력/정책은 재시작 뒤 provider 호출 없이 적격 summary 재사용.
- 모델 오류·초과 출력·출처 철회·inflight policy 변경: 이전 유효 checkpoint 유지, 새 잘못된 값 활성화 없음, diagnostic 확인.
- 여러 압축과 실제 file reopen 뒤 최신 결정 B와 이전 A의 이유를 source 링크로 찾는다. mock 요약의 품질을 실제 모델 장기 기억 능력으로 주장하지 않는다.
- request별 search 한도 소진/새request 리셋/정책 축소; expansion 유효 cursor와 한글 경계; summary 하위source pagination 보존.
- native cut은 기존 prepared boundary에 일치해야 한다. external fresh tail이 실제 ordinary injection에 남고 중복/초과하면 명시 omission이 된다.
- v2→새schema rollback/corrupt generation/unknown version, 과거 checkpoint 원문 byte 보존.

A 통과 후 core generation owner와 fileDB tests를 executor에 위임하고, main은 runtime policy/packing/consumer 연결을 맡는다. 쓰기 범위는 서로 겹치지 않는다. source quota 판정은 runtime, provenance/storage audit는 core 소유자를 유지한다.

기준 검사: `bun test packages/lina-runtime/test/context-*.test.ts packages/lina-core/test/context*.test.ts` exit0,80pass716asserts/19files. 직접 glob이 기존 대상 소스의 소비 테스트를 포함한다. 신규 테스트는 아직 없다. B는 실패→구현→회귀를 기록하고 C는 해당 suite, types/lint/docs/build와 독립 검토를 수행한다. 앱 상태·생산 데이터·provider 호출은 없다.

검증 계층: 정책은 runtime 입력/dispatch 및 core parse/storage에서 검사한다. 임의로 내부 SQLite를 수정하는 같은 OS 사용자를 막는 보안 격리는 아니다. source validator 우회/프로그램 수정은 별도 신뢰 경계이며, 저장 감사는 손상을 검출하는 기능이다. 문서 checker는 구조만 검사하며 의미적 수용 판정은 독립 코드/계약 검토가 맡는다.

## Main A 보완

추가 MODIFY `context/injection.ts`: 기존 2048 token ceiling은 기능이지만 문자로 자르는 단계에 Unicode-safe packing과 실제 policy/estimator를 적용한다. `core/context/index.ts`는 새 generation 타입을 export한다. 생성 guard는 source proofs뿐 아니라 고정 policy 전체·route key·estimator ID가 현재와 같은지 모델 dispatch 직전과 응답 후에 대조한다. 불일치 시 old checkpoint를 보존하고 새 활성화를 거부한다.

최근 원문도 ContextStore의 ordinary eligibility와 source proof를 통과한 항목만 쓴다. native message에 같은 안정 ID가 있으면 중복 주입하지 않는다. 메시지 ID를 확인할 수 없을 때 텍스트가 같다는 이유로 임의 중복 판정하지 않는다. 전체 envelope가 한도에 맞지 않으면 omission을 남긴다. 중요한 결정을 text 잘라내기로 보존했다고 주장하지 않는다.

정책·route·추정기가 변경되면 새 대화가 없어도 기존 generation과 비교해 재구성을 시도한다. freshTailEntries가 늘면 이전 checkpoint가 이미 포함한 최근 항목을 분리해야 하므로 원문에서 재구성한다. 새 root를 만들기 전에는 기존 활성 root를 지우지 않고, 그 root가 현재 출처/주입 예산 안에 있으면 읽을 수 있다. legacy active는 읽기 호환성을 유지하되 새 metadata 기준 cache hit으로 취급하지 않는다. source 참조만 같고 요약 입력이 달라진 경우를 막으려면 실제 input digest도 generation 식별에 포함한다.

## A에서 반영한 독립 검토

독립 검토는 GO-WITH-FIXES로 판정했다. 주입 경로와 정책 소유권 보완을 수용한다.

정책은 기존 `EnginePolicyInput.context`에 지금 포함한다. 새 설정 DB나 독립 revision을 만들지 않는다. 추가 MODIFY `runtime/context/policy-settings.ts`가 versioned 입력의 이전과 전체 snapshot을 소유하고, `context/policy.ts`는 중첩 context 값의 검증/측정 계약만 소유한다. 기존 v1 memory 설정은 같은 저장소에서 v2 context 기본값을 붙여 읽고 기존 memory 값과 revision을 보존한다. unknown payload/schema는 거부한다. session-app은 기존 enginePolicy getter를 소비한다. 신규 입력의 저장·다시 열기·memory 보존·실패 rollback 테스트를 추가한다. 이는 위의 “integration070에서 정책 저장” 초안을 대체한다. UI/API 편집 표면의 조립은 070에 남는다.

한 요청의 raw tail은 external checkpoint 이후의 적격 ordinary entry 중 native 입력에 없는 안정 ID만 주입한다. native ID를 확인할 수 없으면 중복 여부를 텍스트로 추측하지 않고 tail을 제외하며 `tail_dedup_unavailable`을 표시한다. 이 경로는 native cut을 제어하거나 최근 원문 존재를 보장한다는 약속이 아니다. source refs의 guard는 readInjection.beforeDeliver에 합성한다.

주입 diagnostic은 기존 boolean omitted와 함께 working/recall/external/tail 중 제외된 부분을 구분한다. JSON working capsule은 필드/항목 단위로 줄여 유효 구조를 유지하고, 개별 문자열의 발췌는 surrogate-safe 경계와 명시적 abridged 표시를 사용한다. 2048 기술 상한과 현재 전체 요청 budget을 넘지 않으며 정책 expansionTokens를 작업 맥락 주입에도 적용한다. 기존 context-injection 테스트와 실제 session 입력 캡처 테스트를 회귀 범위에 포함한다.

A closure PASS: 추정기는 summary packing, ContextServices.estimateText/estimateMessages, persona systemTokens 검사와 주입에서 동일한 구현을 쓴다. estimator ID는 services/coordinator/generation에 남긴다. native `prepared.fits`는 root 수용의 최종 조건이며 추정으로 대체하지 않는다. 보수적 byte 추정은 기존 문자/4보다 큰 입력량을 계산하므로 더 많은 청크/요약 호출 또는 주입 생략이 생길 수 있다. 실제 증가율은 텍스트에 따라 달라지며 모델 비용 개선으로 주장하지 않는다. 검증은 tree뿐 아니라 injection/coordinator/native/tools/policy와 persona 예산 회귀까지 포함한다. 존재하지 않는 테스트 이름은 기존 glob 및 새 직접 경로로 조정한다.


## 구현 결과와 초기 설계의 변경

- 기존 EnginePolicySettingsStore가 memory/context를 함께 소유한다. v1 payload는 읽기 정규화로 v2 snapshot을 제공하며 원문 JSON/revision을 바꾸지 않는다. v1 memory-only 쓰기는 이미 저장된 context 값을 유지한다.
- 최종 기본 추정기는 `utf8-half-heuristic-v1` (`ceil(UTF-8 bytes / 2)`)이다. raw bytes 초안은 긴 한글 입력에서 불필요한 omission을 만들어 폐기했다. 정확한 tokenizer나 보장된 상한이 아니다. 같은 인스턴스를 서비스·페르소나·요약·주입에서 쓴다.
- generation은 `{version:1, policyDigest, routeKey, estimatorId, inputDigest}`다. policyDigest는 전체 엔진 정책 snapshot을 묶는다. 옛 정책을 재실행하는 기능은 아니므로 정책 원문을 core에 중복 저장하지 않는다. source refs/proofs는 기존 소유자를 재사용한다.
- 새로운 core expansion 옵션은 추가하지 않았다. runtime이 기존 page를 예산에 맞게 줄이고 text/source continuation을 유지한다. source가 있으면 최소 한 링크를 남기며, envelope 자체가 한도를 넘으면 실패한다.
- raw tail은 stable ID로 현재 native 입력과 비교할 수 있을 때만 보낸다. 실제 native 메시지가 opaque이면 `tail_dedup_unavailable`이다. request ID가 없는 직접 도구 호출은 같은 익명 search bucket을 공유하며 한도가 자동 초기화되지 않는다.
- source별 고정 proof를 각 청크에서 검사하고 부모/최종 root에서 전체 ancestry를 검사한다. 1MB/1,000개 원문 회귀는 기존 30초 제한을 유지했다. 전체 proof를 모든 작은 청크에서 반복 검사하던 초안의 시간 초과를 이 방식으로 해결했다.

검증 증거는 세션 evidence의 `context-audit.md`, `context-checkpoint2.log`, `context-session-budget.log` 및 최종 C 영수증에 남긴다. B 범위 226개 통과, 실제 SessionApp fake Codex RPC 입력 검사, 구버전 이전 rollback, 출처 revision 캐시 무효화, 정책/route 변경 중 활성화 거부를 포함한다. 실제 모델 요약 품질·장기 대화·UI·설치 데이터·배포 검증은 별도다.
