# 화면 (renderer)

React 화면이다. 이 폴더의 파일을 고칠 때는 루트 `AGENTS.md`에 더해 아래를 지킨다. 화면 흐름·배치·문구·색의 원본은 `docs/internals/architecture.md` 맨 위의 "화면 설계의 원본"(claude.ai artifact)이다.

- 색·크기는 `src/styles/tokens.css`의 CSS 변수만 쓴다(라이트 B2, 다크 D4, OS 설정을 따름). `src/components/`(CSS Modules)의 부품을 조합하고, 부품 밖에서 색·치수를 직접 쓰지 않는다. 본문 글꼴은 내장한 Pretendard(`src/assets/fonts/`).
- 창 맨 위 띠: Windows 기본 제목 줄을 숨기고 `components/TitleBar`를 `main.tsx`에서 모든 화면 위에 둔다. 높이는 `tokens.css`의 `--titlebar-h`와 `main/index.ts`의 `TITLE_BAR`(32)가 같아야 하고, 화면을 꽉 채울 때는 `100vh` 대신 `--app-h`를 쓴다. macOS에서는 띠를 비워 둔다(신호등 버튼만).
- 화면 영역은 4:3(마법사 800×600, 홈 1000×750, 모니터에 맞춰 줄임, `main/fit.ts`)이고 본문은 `--content-max-w`(720px)까지만 넓어진다. 모든 화면은 최소 800×600에서 스크롤 없이 들어가게 만든다.
- OS마다 다른 낱말(이 PC·이 Mac, 트레이·메뉴 막대, 그래픽카드·GPU, 마이크 권한을 켜는 곳)은 `src/platform.ts`에 모으고, 문구는 Windows 기준으로 쓴 뒤 그 낱말만 가져다 쓴다.
- 폴더: `wizard/`(첫 실행 마법사), `home/`(사이드바 `Shell`, 홈, 시작 전 확인 `ConfirmDialog`, 작업 목록 `JobList`, 녹음 `Recorder`), `notes/`(노트 목록), `preview/`(노트 미리보기), `settings/`(설정).
- 메인과의 통신: 처리는 `src/api.ts`로 부른다(`main/index.ts`의 `handlers`에 있어야 하고, 없으면 거기에 먼저 넣는다). 메인의 알림은 preload 허용 목록에 있는 이벤트만 받는다. 끌어 놓은 파일 경로는 preload의 `pathForFile`로 얻는다.
- KaTeX CSS는 Node 테스트가 못 읽으니 `markdown.ts`가 아니라 `NotePreview.tsx`에서 import한다.
