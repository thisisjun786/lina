# 현재 구조와 동시 작업 기준

2026-09-08 · 조사 중. 실제 모델/전체 테스트를 수행하지 않았다.

| 소유 경로 | 확인한 현재 책임 | 다음 확인 |
| --- | --- | --- |
| packages/lina-runtime/src/models/types.ts, settings.ts, validation.ts, selection.ts | 역할·에이전트별 모델과 reasoning, SQLite settings_json 저장, resolveProfile | 새 등급의 입력/검증/복원/소비 전체 |
| packages/lina-opencodex/src/services.ts, hub.ts | auxiliary 서비스 생성과 역할 선택 | 요청/응답 프로토콜과 기능별 라우트 적용 |
| packages/lina-runtime/src/fleet/codex-fleet.ts | 일반 앱에 hub.createContextServices 전달, LIFE와 workbench 도구 조립 | LIFE와 공통 설정 계약 및 설치 생명주기 |
| packages/lina-memory/src/engine | 관찰·출처·검색·상태 | 전제 연결, 재검토 큐, 정정 후 파생 무효화 |
| packages/lina-runtime/src/context/tree.ts, external.ts | 요약 트리, 외부 체크포인트 | 문자 상수의 토큰 정책화와 모델 소비 |
| packages/lina-runtime/src/context/memory-query.ts | 제한된 추가 검색과 원문 기반 질의 | 깊이별 탐색·시간/호출 한도와 출처 보존 |
| packages/lina-core/src/agents/persona.ts, runtime/persona/hooks.ts | authored + learned + sharedGrowth | 세계 경험과 동일 상태 사용/변화 권한 |
| packages/lina-memory/src/openviking | 외부 HTTP consumer | 자체 공간 흡수 시 사용자/작업/자료 식별자 분리 |

## 월드 동시 변경

원본 /home/jun/code/lina-world-engine의 codex/life-engine HEAD는 3dc2721이다. 0b68b2f 이후 dev 이미지 기준을 병합했다. tracked commit diff는 이미지 문서/이미지 QA/세션 회귀 테스트의 5개 파일이다.

읽기 시점에 agents/store.ts, visual-capacity.ts, world/* persistence/store, runtime/images/life* 및 이미지 회귀 테스트에 미커밋 수정이 있었다. 이는 현재 LIFE 소유 작업으로 간주한다. 이 포크로 복사하거나 해당 워크트리에 쓰지 않았다. 각 구현 P와 통합 전에 HEAD와 dirty 파일 목록을 다시 비교한다.

## 문서 불일치

docs/ARCHITECTURE.md는 Codex/OpenCodex를 현재 실행 경로로 설명한다. docs/PERSONA_CONTEXT.md에는 OmO 및 Honcho 중심의 옛 표현이 남아 있다. 실제 소비 코드 기준으로 해당 문서를 갱신해야 한다. 이 불일치만으로 실행 버그라고 판정하지 않는다.
