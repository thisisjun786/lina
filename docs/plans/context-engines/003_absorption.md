# 원본 기능 흡수 대조

2026-09-08. 원본 설명/선택된 구현을 읽은 설계 근거이며 성능 동등성 검증이 아니다. OpenViking 조사 explorer 결과를 메인이 3개 pinned 원문으로 교차 확인했다. 일반 기능 원리를 독립적으로 구현하며 원본 코드를 복사하지 않는다. 이 절차를 법률상 clean-room 보장으로 부르지 않는다.

| 기준 | 흡수할 원리 | LINA 설계와 제외 경계 |
| --- | --- | --- |
| Honcho reasoning/deriver/dreamer | 원문 관찰, 축적 기억 재검토, 전제와 결론, 질의 시 탐색 | memory/020에 반영. 전문 모델의 동일 품질은 별도 평가. 외부 API/worker 서버는 자체 런타임으로 대체 |
| LCM 원문/summary DAG | 원문 보존, leaf와 상위 summary, grep/describe/expand, 압축 시 연결 유지 | context/040에 반영. Codex 실행 압축을 흉내내지 않고 Lina source archive를 소유. 실행 map/subagent framework 복제는 범위 밖 |
| OpenViking v0.4.17 / e7f2fe519086923340703b300895c02f8ccfd3e9 | 논리 URI, directory abstract/overview와 원문, 범위 기반 계층 검색, 저장/파생/index 상태 분리, session 기억 추출 | resources/050 및 shared-memory/060에 반영. 네임스페이스/저장소는 LINA 소유. 코드 저장소 import·skill marketplace·실행 관리자 복제는 범위 밖 |

## OpenViking 핵심 선택

[Context layers](https://github.com/volcengine/OpenViking/blob/e7f2fe519086923340703b300895c02f8ccfd3e9/docs/en/concepts/03-context-layers.md)는 directory 수준 abstract와 overview를 구분한다. 일반 파일마다 동일한 sidecar 두 개를 만드는 구조가 아니다. LINA collection의 짧은 개요/탐색 설명은 하위 자료의 현재 revision 집합에서 파생한다. 불완전 coverage·stale 상태는 감추지 않는다.

[Retrieval](https://github.com/volcengine/OpenViking/blob/e7f2fe519086923340703b300895c02f8ccfd3e9/docs/en/concepts/07-retrieval.md)은 단순 find와 현재 대화 의도를 반영하는 search를 구분한다. 검색어를 모르는 경우에도 탐색할 수 있다는 요구는 단순 FTS만으로 충족되지 않는다. 기본 경로는 FTS 후보+collection 개요 탐색+공통 라우트 기반 query planning/rerank이며 선택적 embeddings를 추가할 수 있다. 임베딩을 사용하지 않는다는 이유로 계층 탐색·의미 연결 요구를 삭제하지 않는다. 임베딩 유무별 회수 품질을 동일 fixture에서 비교하고 부족하면 선택을 재검토한다.

[License](https://github.com/volcengine/OpenViking/blob/e7f2fe519086923340703b300895c02f8ccfd3e9/LICENSE)는 AGPL-3.0이며 현재 LINA는 Apache-2.0이다. 조사 자료는 출처로 남기고 알고리즘 구현을 복사하지 않는다. 의존성 추가가 필요한 파서는 별도 라이선스/설치 계약을 확인한다.

자료 유형은 text/markdown/html/pdf/image를 초기 상세 설계의 직접 대상에 두며 Office/스프레드시트도 비개발 업무의 문서 요구로 추출 경로를 설계한다. 단순히 후속으로 제외하지 않는다. 실제 parser 미지원은 stored-but-not-indexed로 표시하고 전체 기능 검증에서 누락을 남긴다. 원본 파일은 항상 원형으로 보존한다.

Honcho 참고: [reasoning 설명](https://honcho.dev/docs/v3/documentation/core-concepts/reasoning) 및 [고정한 dream orchestrator](https://github.com/plastic-labs/honcho/blob/5a2f807b8b905cbb20e88267a9138f53c1e8d755/src/dreamer/orchestrator.py). 020 P에서 2026-09-08 HEAD를 조회하고 해당 원문을 읽어 연역→귀납 순서와 transaction 밖 호출 경계를 확인했다. LCM 참고: https://papers.voltropy.com/LCM . 전문 모델 학습·운영 복제는 요구되지 않았으며 모델은 LINA 공통 route로 선택한다.
