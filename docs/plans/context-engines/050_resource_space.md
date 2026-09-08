# 050 — LLM 중심 비코드 자료 공간

상태: P 재검토. [051 실제 실행 계획](051_resource_execution.md)을 우선하며 구현 전이다. 단위 `resources`, 선행 `routing`.

## 변경 지도

| 작업 | 경로 | 전 → 후 또는 신규 책임 |
| --- | --- | --- |
| NEW | `packages/lina-memory/src/resources/types.ts` | stable resource id, parent collection id, revision, media type, source, visibility, derived revision 상태 |
| NEW | `packages/lina-memory/src/resources/store.ts` | 내장 metadata/참조/collection/CAS owner; 코드 레포 복제나 task manager 아님 |
| NEW | `packages/lina-memory/src/resources/content.ts` | 불변 content version 저장, 크기/해시 검증, 중간 실패 복구 |
| NEW | `packages/lina-memory/src/resources/retrieval.ts` | 목록/개요/요약/원문 점진 읽기, 검색 후보와 범위 기반 탐색 |
| NEW | `packages/lina-memory/src/resources/indexing.ts` | 추출/요약/검색 준비를 분리하는 durable indexing jobs |
| NEW | `packages/lina-runtime/src/resources/tools.ts` | LLM용 list/read/search/create/update/move 계약; scope는 host가 공급 |
| NEW | `packages/lina-memory/test/resources-store.test.ts` | stable reference, revision conflict, move cycle, 중간 저장 실패, reopen 검증 |
| NEW | `packages/lina-runtime/test/resources-tools.test.ts` | 도구부터 원문/검색까지 실제 owner 경로 |

## 필드·상태 흐름

운영체제 파일 경로와 논리 주소를 분리한다. resource id는 이동/이름 변경에 불변이며 version id는 내용 변경마다 새로 생긴다. collection은 분류 관계이며 실제 디스크 디렉터리와 일대일로 결합하지 않는다. 바이너리를 일반 모델 text에 주입하지 않는다. 지원하지 않는 추출기는 원본만 보존하고 unavailable 상태를 반환한다. 읽기/색인 실패가 원문 저장 성공을 뒤집지 않는다. 외부 폴더를 자동 스캔하거나 사용자 파일을 옮기지 않는다. upstream 조사에 따라 상세 저장/검색 선택과 기능 대조를 A 전에 확정해야 한다.

입력은 해당 boundary에서 검증하고 저장 owner가 schema/revision/참조를 검증한다. 새 상태는 API/도구 출력과 실제 consumer까지 전달한다. 임의 JSON으로 권한을 부여하지 않는다. 구버전·알 수 없는 enum은 명시적으로 처리하고 조용한 기본값으로 데이터 의미를 바꾸지 않는다.

## 활성화와 기대 결과

- PDF/이미지/문서 원본 저장 및 타입별 처리.
- 작업 ID 없이 자료 생성.
- 이름 모르는 질의로 개요에서 원문 탐색.
- move 뒤 기존 참조 유효.
- 두 동시 수정 중 stale revision 거부.
- worker 중단/reopen 뒤 인덱스 재개.
- 삭제/권한 변경 뒤 파생 결과 제외.
- source code 저장소 관리 기능을 만들지 않음..

## 검증 명령과 증거

각 NEW 테스트의 직접 경로를 `bun test`에 전달하여 실패→구현→통과를 남긴다. 이 문서 작성 시 새 테스트는 없으므로 실행 결과를 주장하지 않는다. 수정된 기존 기능의 affected tests, `bun run typecheck`, `bun run lint`를 수행하고 마지막 acceptance에서 `bun run ci:validate`, `bun run ci:build`와 전체 테스트를 수행한다. 현존 스크립트는 package.json에서 확인했으며 target coverage와 실제 exit code는 실행 시 기록한다.

## 감사와 재검증

공통 상태 계약은 004_contracts.md, 해당 단위의 추가 계약은 아래 사전 감사 수정 절을 따른다. A에서 source/소비자 누락을 검사하고, 각 구현 P에서는 선행 커밋으로 바뀐 타입과 경로를 재검증한다. A 통과 전 구현은 시작하지 않는다.

상세 identity/schema/transaction/search/API 계약은 [004_contracts](004_contracts.md)를 따른다.

## 기존 파서 재사용과 파일별 경로

NEW `packages/lina-memory/src/resources/extraction.ts`는 `packages/lina-core/src/attachments/document.ts`의 `extractDocument`와 document-container 검사를 재사용한다. PDF/Office 추출을 새 라이브러리로 중복 구현하지 않는다. 현재 Linux child-process 제한을 사용하는 기존 코드의 플랫폼 한계를 기록하고 지원되지 않는 환경에서는 추출 실패 상태를 명시한다. 원문 bytes 저장은 추출 실패와 독립이다. 이미지 설명은 ContextServices.analyzeImage를 거쳐 vision 지원 모델을 사용하며 메타데이터만으로 이미지 내용을 읽었다고 표시하지 않는다.

NEW `packages/lina-memory/src/resources/schema.ts`는 004의 테이블과 schema version=1 생성/정합 검사를 소유한다. NEW `codec.ts`는 요청/디스크에서 읽은 자료/버전/job/derived JSON을 검증한다. NEW `index.ts`는 외부 consumer용 public boundary만 제공한다. NEW `packages/lina-runtime/src/fleet/resource-routes.ts`는 004의 API를 구현하며 기존 Fleet server dispatch에서 연결한다. 해당 dispatch와 설치 수명주기 변경은 070에서 순차 통합한다.

검증에는 기존 `packages/lina-core/test/attachment-document.test.ts`의 실제 임시 PDF/Office 추출 경로와 새 resource ingest 결과를 함께 사용한다. 새 스프레드시트 parser를 도입하기 전에 기존 office_text.py 지원 범위를 확인한다.

## 사전 감사 수정: 검색 기반과 권한

Bun 1.4.0 node:sqlite의 FTS5 trigram 생성과 한국어 phrase MATCH를 P에서 실제 확인했다. 공백으로 나눈 두 글자 단어 쿼리 `결정 이유`는 0건이고 quoted phrase는 1건이었다. 따라서 원문 query를 FTS 연산식으로 실행하지 않고 escape한 phrase 후보와 3자 미만 literal substring 후보를 결합한다. 이는 availability proof이며 의미 회수 품질 증거는 아니다. 계층 개요 탐색과 route planner/rerank는 필수 구현한다. vector는 추가 encoder가 실제 연결됐을 때만 사용하며 가짜 embedding 상태나 예약-only 기능을 완료로 세지 않는다.

추가 MODIFY packages/lina-runtime/src/execution.ts: 실제 resource read/list/search 도구를 confirm-mode 읽기 allowlist에 연결한다. write/move는 기존 쓰기 승인 규칙을 적용한다. 등록뿐 아니라 실제 execute→waiting_approval 여부를 회귀 검증한다.
