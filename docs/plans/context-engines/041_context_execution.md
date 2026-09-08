# 041 — 컨텍스트 정책의 실제 실행 경로

상태: context P. 040의 변경 지도를 실제 소스에 맞춰 보완한다. 구현 전 A 검토가 필요하다.

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
