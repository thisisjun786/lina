# Lina 제품 계획

상태: 공개 전 로컬 소스 후보의 제품 요구와 후속 설계다. 계획은 기능 완료나 공개·배포 증거가 아니다. 현재 구현은 [README](../README.md), [Codex 실행 구조](CODEX_RUNTIME.md), [설치 계약](plans/installation.md), [온보딩 계약](plans/onboarding.md)을 기준으로 확인하고 [검증 범위](VALIDATION.md)에 따라 증거를 남긴다.

## 제품 기획

| 기획 | 문서 | 현재 상태 |
| --- | --- | --- |
| Codex 디자인 언어, Electron과 웹 공통 화면 | [UI 개편](plans/codex-ui/001_ui_plan.md), [Electron](plans/codex-ui/004_electron_stack.md), [디자인 기준](../packages/lina-web/DESIGN.md) | 방향 확정, UI 전면 개편과 Electron 패키징은 후속 구현 |
| 메신저형 에이전트 목록과 모바일 탐색 | [에이전트 목록](plans/codex-ui/006_agent_list_mobile.md), [작업 목록 배치](plans/codex-ui/007_sidebar_comparison.md) | 기본 한 목록 열, 넓은 창의 선택적 작업 열, 모바일 전체 화면 전환 |
| 연속 메시지와 중간 사용자 입력 | [대화 전달](plans/codex-ui/002_conversation_delivery.md) | 공개된 발화와 미공개 후보를 나누는 엔진·저장 계약 설계 |
| 이미지·파일 붙여넣기 | [첨부 계획](plans/codex-ui/003_clipboard_attachment.md) | 공통 첨부 큐와 플랫폼별 검증이 필요한 계획 |
| 전용 컴퓨터의 공통 계약 | [컴퓨터·실행·입력 소유권](plans/platform/001_runtime_contracts.md) | API·저장 계약 제안, 독립 GUI 입력은 아직 미검증 |
| 검증 모델 프리셋과 연결 | [Moirai 모델 계약](plans/context-engines/030_moirai_refactor_plan.md#모델-운영-검증한-프리셋으로-제한), [모델 온보딩](plans/platform/005_model_onboarding.md) | 사용자 백엔드 임의 설정 취소. 유지보수자가 검증한 모델·역할 프리셋으로 제한하는 전환 계획이며 기존 설정 API는 아직 유지 |
| 설치 구성과 전체 상태 버전관리 | [리팩터링 요구](plans/platform/008_refactor_preparation.md) | 홈·패키지 분리·로컬 체크포인트 구현, 자동 이력·선택 복원·외부 내보내기는 후속 |
| ima2 이미지 엔진 | [생성·편집 연동](plans/platform/009_ima2_image_engine.md), [LIFE 통합 계약](plans/life/070_images_and_avatars.md) | 기존 이미지 엔진과 LIFE 게시·아바타 연결 구현. 070에서 전체 테스트 3,357개·HTTP 27건·독립 리뷰 통과. 실제 이미지 품질·UI는 별도 검증 |
| 주기적 프로필 사진과 내부 SNS | [에이전트 일상](plans/platform/010_agent_daily_life_ideas.md), [LIFE 전체 구현 계획](plans/life/000_plan.md) | 내부 게시물·에이전트 답글·댓글·반응·재공유와 다음 경험 연결 구현·검토 통과. 이미지·주기적 프로필 사진 연결도 로컬 검증 통과. UI와 실제 생성 품질은 별도 검증. 주기·예산·공유 대상은 명시적 설정 |
| 페르소나와 분리된 월드 엔진 | [RisuAI 참고와 월드 설계](plans/platform/011_world_engine_risuai.md), [최소 구현과 연결 계약](plans/platform/012_world_engine_mvp.md) | 장면·사건·개인 경험·믿음·공유 성장 저장과 목적별 전달 구현. 업무·기억·페르소나 출처 경계와 런타임 연결 완료. 운영 설치본의 활성화는 별도 요청 |
| 세계 배경 편집과 규칙 미리보기 | [세계 편집 계약](plans/life/020_world_authoring.md) | 원문·질문·초안 버전 저장, 명시적 확인, 제한된 lore/규칙 평가와 전용 작성 세션 구현. 종료 경합 수정과 독립 검토 통과. 실제 모델 품질·UI는 별도 검증 |
| LIFE 사회 시뮬레이션과 공유 성장 | [소스 분석과 구현 방향](plans/platform/013_life_engine_research.md) | 사용자 배경 설정·확률적 사건·업무 영향·개인 경험·비밀·관계가 목표. 성격·관계 성장은 일반 대화와 공유하고 사건 원문은 별도 공개 제어. [사회 엔진](plans/life/030_social_engine.md)의 규칙 판정·비밀 전달·저장·복구와 설치 패키지 연결 구현, 독립 검토 통과. [자율 일상](plans/life/040_autonomous_life.md)의 실행·복구·모델 격리·설치본 HTTP 검증과 독립 검토 통과 |
| LIFE 전체 구현과 통합 검증 | [전체 계획](plans/life/000_plan.md), [첫 단위 저장 설계](plans/life/011_state_contract.md), [대화 이전 설계](plans/life/012_context_migration.md), [이미지·아바타 연결](plans/life/070_images_and_avatars.md) | 8단계 로컬 엔진 구현·검증 완료. 010~050 저장·세계 편집·사회 엔진·자동 일상·업무·기억 연결 검증 통과. 060 게시물·상호작용도 독립 재검토, 전체 테스트와 실제 HTTP 검증 통과. 070 이미지·아바타 연결도 완료. 080의 단일 설치 통합 흐름·저장소 장애 격리·체크포인트 복원과 [소비자 계약](LIFE_ENGINE.md) 검증 통과. 최종 전체 테스트 3,368개·독립 리뷰 통과 |
| 초파리 회로 기반 감정·선호·선택 | [연구·제품 방향](plans/platform/015_neural_preference_engine_research.md), [사건·조회·학습·실행 계약](plans/platform/016_neural_preference_contract.md) | 새 Senpi 인지 백엔드와 Google·Janelia MaleCNS v1.0 부분회로를 연결하는 설계. 첫 대화 단위부터 개인별 학습·활동별 조회·복구를 포함하고 LIFE 선택·8명 운영으로 확장. 관측 확정과 행동 확정을 분리하고 finalize 검증 뒤 실행. 실제 회로·연동·성능은 미검증 |

UI 공개 참고 자료는 [설계 참고 자료](plans/codex-ui/000_source_research.md), 세부 시각 기준은 [Codex 디자인 언어](plans/codex-ui/005_codex_design_language.md)에 있다. 개인 캡처와 운영 이력은 제품 소스에 포함하지 않는다.

## 현재 구현과 계획의 관계

- **첫 시작:** 사용자 소개는 최초 한 번만 한다. 사이드바 없는 대화 화면에서 이름/호칭과 기본 맥락을 묻고, 완료 후 재진입 메뉴를 제공하지 않는다. 에이전트 추가는 리나가 진행하는 별도 생성 대화다. [완료된 흐름](plans/onboarding.md)을 유지한다. UI 기획의 목록·뒤로 가기·설정은 평소 대화에 적용하며 최초 소개로 복귀하는 기능을 되살리지 않는다.
- **런타임과 패키지:** 실행 엔진은 Codex, 프로바이더 관리는 OpenCodex다. `lina-runtime`은 제품 런타임을 소유한다. Senpi 실행과 OmO 작업 패키지 `lina-jobs`는 제거했고, Codex 작업 기능은 유지한다. 계획의 제안 API·테이블·패키지는 구현 전에 현재 코드와 대조한다.
- **설치 홈:** 명시한 `LINA_HOME`, 기본 `~/.lina`가 기준이다. Lina OS의 초기 `/var/lib/lina` 제안은 현재 기본 경로를 바꾸지 않는다. OS 서비스 등록은 사용자 데이터와 구분한다.
- **모델 연결과 OS 설정:** Lina가 검증 모델 프리셋과 인증·연결 계약을 소유한다. 사용자가 백엔드와 역할별 모델을 자유롭게 조립하는 안은 취소했다. 현재 설정 API의 전환은 Moirai R4에서 진행한다. Tailscale·도구 설치와 OS 설정 완료 기준은 [OS 제품 경계](REPOSITORY_SPLIT.md)가 정한 OS 소유 범위다. 네이티브 Lina의 첫 소개에 OS 설치 요구를 강제하지 않는다.
- **데이터 이력:** 원래 요구는 페르소나뿐 아니라 메모리·에이전트 설정·사용자 프로필 전체다. 현재 체크포인트는 오프라인 로컬 스냅샷과 선택적 Git 명세 기록이다. 자동 변경 이력, 선택 복원, 외부 저장소까지 일관된 복구가 구현됐다고 표현하지 않는다.

## 실행 환경 소유권

Lina는 에이전트·대화·페르소나·메모리·작업·컴퓨터 공통 계약과 연결 UI를 소유한다. Lina OS는 Omarchy, 데스크톱 프로세스·드라이버, 호스트 권한, OS 설치·업데이트·복구 검증을 소유한다. 실제 소스 경로는 구현 시 결정하며 두 저장소에 동일한 런타임을 복제하지 않는다.

전용 컴퓨터는 VM 또는 원격 장비를 사용할 수 있는 작업 공간 기능이다. 보안 격리는 별도 선택이며 네이티브·개별 작업 컨테이너·전체 런타임 컨테이너를 구분한다. 컴퓨터 계약이 있다는 사실만으로 맥·윈도우 GUI, 공유 로그인, 동시 입력, OS 부팅이 검증된 것은 아니다.


## 문서 관리

제품 요구는 `docs/plans`에서 유지한다. 개인 세션·호스트·워크트리·운영 이력을 소스에 포함하지 않는다. 공개 참고 소스의 리비전과 라이선스는 보존하되, 설계 문서의 외부 버전·카탈로그 설명은 구현 시 다시 확인한다. 선정한 방향, 제안 세부사항, 미정 항목과 현재 구현을 구분한다.
