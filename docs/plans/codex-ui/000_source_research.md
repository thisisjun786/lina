# UI 설계 참고 자료

Codex 디자인 언어를 따르는 Lina UI 계획의 공개 참고 자료다. 아래 고정 리비전은 설계 참고와 출처 기록이며, 이번 공개 준비에서 외부 소스를 다시 검증하거나 현재 호환성을 인증한 것은 아니다.

## 공개 참고 소스

Codex 조사 기준 커밋: `0e9589ffae082437e6793e8c24900e876dfdf86a`.

- [저장소와 범위](https://github.com/openai/codex/tree/0e9589ffae082437e6793e8c24900e876dfdf86a)
- [LICENSE](https://github.com/openai/codex/blob/0e9589ffae082437e6793e8c24900e876dfdf86a/LICENSE), [NOTICE](https://github.com/openai/codex/blob/0e9589ffae082437e6793e8c24900e876dfdf86a/NOTICE)
- [App Server README](https://github.com/openai/codex/blob/0e9589ffae082437e6793e8c24900e876dfdf86a/codex-rs/app-server/README.md)
- [thread.rs](https://github.com/openai/codex/blob/0e9589ffae082437e6793e8c24900e876dfdf86a/codex-rs/app-server-protocol/src/protocol/v2/thread.rs)
- [turn.rs](https://github.com/openai/codex/blob/0e9589ffae082437e6793e8c24900e876dfdf86a/codex-rs/app-server-protocol/src/protocol/v2/turn.rs)
- [item.rs](https://github.com/openai/codex/blob/0e9589ffae082437e6793e8c24900e876dfdf86a/codex-rs/app-server-protocol/src/protocol/v2/item.rs)

Apps SDK UI 조사 기준: 버전 `0.2.2`, 커밋 `0f00143c7a639906f1621fe58e1b6be7b5bea46d`.

- [README 및 설치 조건](https://github.com/openai/apps-sdk-ui/tree/0f00143c7a639906f1621fe58e1b6be7b5bea46d): React 18/19와 Tailwind 4가 필요합니다.
- [MIT LICENSE](https://github.com/openai/apps-sdk-ui/blob/0f00143c7a639906f1621fe58e1b6be7b5bea46d/LICENSE)
- [기본 값](https://github.com/openai/apps-sdk-ui/blob/0f00143c7a639906f1621fe58e1b6be7b5bea46d/src/styles/variables-primitive.css), [용도별 색·표면](https://github.com/openai/apps-sdk-ui/blob/0f00143c7a639906f1621fe58e1b6be7b5bea46d/src/styles/variables-semantic.css), [컴포넌트 규격](https://github.com/openai/apps-sdk-ui/blob/0f00143c7a639906f1621fe58e1b6be7b5bea46d/src/styles/variables-components.css)
- [Textarea](https://github.com/openai/apps-sdk-ui/blob/0f00143c7a639906f1621fe58e1b6be7b5bea46d/src/components/Textarea/Textarea.tsx), [입력 높이 처리](https://github.com/openai/apps-sdk-ui/blob/0f00143c7a639906f1621fe58e1b6be7b5bea46d/src/hooks/useAutoGrowTextarea.tsx)

## 사용 범위

관련 공개 제품·구조 참고 자료:

- [OpenAI App Server 구조 설명](https://openai.com/index/unlocking-the-codex-harness/)
- [Codex 모바일·원격 사용 소개](https://openai.com/index/work-with-codex-from-anywhere/)
- [Remote 연결 문서](https://learn.chatgpt.com/docs/remote-connections)
- [Codex 제품 페이지](https://chatgpt.com/codex/)

Codex 실행 계층은 작업 상태·명령·재연결 계약의 참고 자료다. 현재 실행 구조는 [Codex 런타임](../../CODEX_RUNTIME.md)을 따른다. Apps SDK UI는 토큰과 기본 요소의 참고 후보이며 완제품 Codex 화면 전체의 소스라고 간주하지 않는다.

Lina의 TypeScript/HTML/CSS 구조를 재사용한다. UI 개편 때문에 React/Tailwind 전환을 요구하지 않는다. 공개되지 않은 데스크톱 번들의 코드·폰트·로고는 재배포하지 않으며, 공개 코드를 도입할 때도 해당 버전의 라이선스와 고지를 보존한다.

웹·Electron·모바일은 에이전트 ID, 대화 기록, 작업 상태와 명령 계약을 공유한다. 화면 폭·스크롤·키보드·파일 선택은 각 클라이언트가 처리한다. 디자인 값은 [UI 계획](001_ui_plan.md)의 시작값과 [시각 기준](005_codex_design_language.md)을 사용하고 실제 렌더링으로 검수한다.
