# GitHub에 올릴 소스 준비

공개 대상은 범용 웹앱·서버·엔진·테스트·스킬·문서와 `scripts/catalog.json`에 등록한 스크립트입니다. 입력 영상, 특정 영상 전용 보정 코드, 변환 결과, 캐시와 설치 의존성은 포함하지 않습니다. `.gitignore`는 로컬 파일을 보존하면서 공개 후보에서 제외합니다. 이미 추적 중인 파일은 ignore만으로 추적이 해제되지 않으므로 공개 검사에서 함께 확인합니다.

README에서 기능을 설명하기 위해 직접 만든 검증 영상과 예제용 AI 캐릭터 영상의 비교 GIF·편집 프로젝트·선정한 소스를 `docs/assets/`, `examples/reconstruction-demo/`, `examples/character-gradient/`에 포함했습니다. [기본 예제 출처](../examples/reconstruction-demo/README.md)와 [AI 캐릭터 출처·생성 절차·검증 범위](../examples/character-gradient/README.md)를 함께 제공하며, 사용자 원본이나 일반 실험 결과를 자동 공개하는 규칙은 아닙니다.

## 검사와 패키징

```sh
npm run release:check
npm run release:package
```

검사는 Git의 추적 파일과 무시되지 않은 미추적 파일을 대상으로 합니다. 공개 경로, 일반 파일 여부, 파일당 10 MiB라는 프로젝트 정책, 일부 민감 문자열·사용자 홈 경로와 스크립트 목록 일치를 확인합니다. 이는 포괄적인 비밀정보 감사가 아닙니다. 결과는 `.cache/public-source-check.json`에 저장됩니다.

패키지는 `dist/github-source/saegim-source.zip`에 생성됩니다. `saegim/`에는 실행 소스가, ZIP 최상위 `SOURCE_MANIFEST.json`에는 소스별 크기와 SHA-256이 들어갑니다. 파일을 읽는 도중 바뀌지 않았는지 확인하고, ZIP을 다시 해제해 모든 소스 해시를 대조합니다. `package-check.json`은 패키지 해시와 검사 결과를 기록합니다.

Git이 초기화되지 않은 다운로드 폴더에서는 먼저 `git init`을 실행해야 공개 후보를 나열할 수 있습니다. 저장소 복제본에서는 그대로 실행합니다. 패키지 생성은 커밋·원격 저장소 생성·업로드를 하지 않습니다.

## 새 폴더에서 확인하기

ZIP을 해제한 `saegim` 폴더에서 실행합니다.

```sh
git init
npm ci
npm run setup
npx playwright install chromium
npm run doctor
npm test -- --maxWorkers=1
npm run build
npm run release:check
```

원본 영상 없이 앱의 예제 프로젝트와 합성 테스트를 사용할 수 있습니다. 개인 영상으로 분석하려면 README의 입력 명령을 사용하고 결과는 `artifacts/` 아래에 둡니다.

## 업로드 전 확인할 항목

- `git status --short`와 공개 검사 목록을 확인합니다.
- 의도한 파일만 스테이징하고 `git diff --cached --stat`으로 범위를 확인합니다.
- 프로젝트 소스의 MIT 라이선스와 포함 글꼴의 OFL 고지를 보존합니다.
- 대상 GitHub 저장소와 브랜치를 정한 뒤 커밋하고 push합니다. 이 문서와 패키징 명령은 해당 작업을 대신 실행하지 않습니다.

새 범용 스크립트를 추가할 때는 `.gitignore`의 허용 목록, `scripts/catalog.json`, `docs/scripts.md`를 함께 갱신합니다. 특정 영상용 입력은 설정·관측 파일로 분리해 호출자에게 받거나 공개 대상에서 제외합니다.
