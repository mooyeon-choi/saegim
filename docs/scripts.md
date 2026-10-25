# 스크립트 안내

공개 저장소에는 다른 영상에도 사용할 수 있는 개발·분석·렌더링·검증 도구만 포함합니다. 특정 영상의 장면 번호, 캐릭터, 팔레트, 제목, 수작업 마스크와 보정 기록을 전제로 하는 실험 스크립트는 공개 목록에 포함하지 않습니다. 실행 파일 목록과 입력 조건은 [`scripts/catalog.json`](../scripts/catalog.json)에 있습니다.

`src/engine`의 편집 프로젝트와 `object-scene-v1`은 서로 다른 데이터 형식입니다. 앱의 일반 영상 분석 결과는 편집 프로젝트입니다. 관측 도형을 연결하는 `object_scene_tracks.py`는 별도 실험 도구이며, 영상 파일을 직접 분석하거나 숨겨진 신체 구조를 복원하지 않습니다.

## 환경 준비와 앱 실행

저장소 루트에서 실행합니다. Node.js, npm, Python 3.10 이상이 필요합니다. 브라우저 렌더링과 E2E 검증에는 Playwright Chromium도 설치합니다.

```sh
npm ci
npm run setup
npx playwright install chromium
npm run dev
```

`workflow`와 렌더러는 설치된 `.venv`를 우선하며 없을 때 `FRAMEFORM_PYTHON`을 사용합니다. 렌더러의 `--python`은 명시적인 실행 환경 재정의입니다.

`setup.mjs`는 `.venv`를 만들고 `requirements.txt`를 설치합니다. `dev.mjs`는 로컬 분석 API와 Vite를 실행합니다. Python 경로를 지정하려면 환경 준비 전에 `FRAMEFORM_PYTHON`을 설정합니다. 아래의 `.venv/bin/python` 예시는 macOS/Linux 기준이며 Windows에서는 `.venv/Scripts/python.exe`를 사용합니다.

`scripts/workflow.mjs`는 같은 작업의 명령 진입점을 제공합니다. 인자를 해당 도구로 전달하며, `doctor`는 설치나 다운로드 없이 로컬 의존성을 검사합니다.

```sh
node scripts/workflow.mjs list
node scripts/workflow.mjs doctor
node scripts/workflow.mjs analyze --input /path/to/input.mp4 --out-dir artifacts/my-video
```

지원 작업은 `analyze`, `render`, `elements`, `compare`, `fixtures`, `verify-fixtures`, `render-fixtures`, `compare-fixtures`, `release-check`, `package`입니다.

| 파일 | 입력 | 출력·역할 |
| --- | --- | --- |
| `scripts/setup.mjs` | `requirements.txt`, Python 실행 파일 | 로컬 `.venv` 준비 |
| `scripts/dev.mjs` | 설치한 npm·Python 의존성 | 분석 API와 편집 웹앱 실행 |
| `scripts/create-fixtures.py` | 외부 영상 불필요 | 직접 그린 검증 영상 5개와 `.data/qa-fixtures/manifest.json` |
| `scripts/verify-analysis.py` | 검증 영상, 실행 중인 분석 API | `artifacts/qa/*.json`, 분석 요약 |
| `scripts/visual-qa.mjs` | 분석 프로젝트 JSON, Chromium | 실제 엔진 SVG 캡처, `visual-review-data.json` |
| `scripts/compare-frames.py` | 원본 검증 영상, SVG 캡처 | 비교 이미지와 `visual-review-metrics.json` |

## 준비한 영상으로 분석·렌더링·비교하기

앱의 API가 실행 중이어야 합니다. 입력 경로와 출력 폴더를 직접 지정합니다.

```sh
.venv/bin/python scripts/analyze-video.py \
  --input /path/to/input.mp4 \
  --out-dir artifacts/my-video \
  --quality high

node scripts/render-project.mjs \
  --project artifacts/my-video/project.json \
  --out-dir artifacts/my-video/render \
  --fps 24 --width 960

.venv/bin/python scripts/compare-video.py \
  --source /path/to/input.mp4 \
  --rendered artifacts/my-video/render/preview.mp4 \
  --output artifacts/my-video/comparison.gif
```

| 파일 | 결과 | 주요 선택 인자 |
| --- | --- | --- |
| `scripts/analyze-video.py` | `project.json`, `analysis-check.json` | `--base-url`, `--quality standard\|high`, `--sample-fps`, `--clip-start`, `--clip-end`, `--timeout` |
| `scripts/render-project.mjs` | `index.html`, `preview.mp4`, 처음·마지막 프레임 PNG, `render-check.json` | `--fps`, `--width`, `--python`, `--html-only` |
| `scripts/compare-video.py` | 지정한 GIF, 같은 이름의 `.json` 검증 보고서와 `.last.png` | `--fps`, `--width`, `--source-start` |

이 분석 CLI는 한 번에 하나의 프로젝트를 생성합니다. 현재 API의 업로드 한도는 100MiB(104,857,600바이트)이며 전체 영상은 최대 60초까지 분석합니다. 30초 이하는 단일 프로젝트, 30초를 넘는 영상은 서버에서 처리 구간으로 나누어 하나의 `schemaVersion: 2` 프로젝트로 자동 조립합니다. 처리 구간 경계는 원본 장면 컷과 같지 않을 수 있습니다.

원본에서 일부만 선택할 때는 `--clip-start 10 --clip-end 20`처럼 두 인자를 함께 전달합니다. 시작은 0초 이상, 선택 길이는 0.2~60초이며 종료는 원본 길이 안에 있어야 합니다. 선택 구간이 30초를 넘으면 같은 자동 조립 경로를 사용합니다. 같은 원본으로 비교할 때는 `compare-video.py --source-start 10`을 지정해 시간축을 맞춥니다. 조립 결과에는 최대 64개 처리 구간과 압축 구간 데이터 256MiB 한도가 있으며, 복잡한 영상은 이 용량 한도에 먼저 도달할 수 있습니다.

세 스크립트 모두 기본적으로 기존 주요 출력 파일을 덮어쓰지 않습니다. 재실행하려면 다른 출력 폴더를 사용하거나 `--overwrite`를 명시합니다. `--html-only`는 영상 인코딩을 생략하고 독립 실행 HTML만 내보냅니다. HTML은 재생 결과이며 편집 프로젝트 JSON은 앱에서 불러와 수정합니다.

`--sample-fps`는 `standard` 분석의 표본 빈도입니다. `high`는 원본 FPS와 24 중 작은 빈도를 사용합니다. 짧은 입력도 고품질 결과가 요소 8,000개 또는 경로·JSON 한도를 넘으면 중단할 수 있습니다. 입력 구간을 짧게 나누거나 빠른 분석으로 변경한 사실을 기록하고 결과의 `analysis.warnings`를 검토합니다. `standard`는 많은 요소를 줄여 보존할 수 있으므로 분석 성공이 모든 디테일 보존을 뜻하지 않습니다.

MP4 렌더 FPS는 앱 프로젝트와 동일하게 1~240의 유한한 소수를 지원합니다. 기본값은 프로젝트 FPS이며, 분석 샘플 FPS와는 별개입니다. GIF 비교 FPS는 5·10·20·25·50 중 선택합니다.

렌더러는 검증된 앱 프로젝트를 브라우저에서 SVG로 재생한 뒤 프레임 수와 FPS를 검사합니다. 비교기는 화면 비율을 맞춘 좌우 GIF를 만들고 모든 GIF 프레임을 디코딩하여 시간 간격을 확인합니다. GIF 길이는 선택한 GIF FPS에 맞추어 마지막 프레임 간격까지 양자화됩니다. 비교 GIF에는 음성이 포함되지 않습니다.

앱 schema 1/2의 `temporal.mode: "frames"`는 프레임 다시 그리기 모드입니다. `sampleFps`의 직전 관측을 선택하고 실제 `cuts`에서는 즉시 새 장면으로 바꿉니다. 각 관측을 온전한 SVG로 다시 그리며 프레임 혼합·배경/전경 수식 패치는 사용하지 않습니다. `backgroundMotion`과 `foregroundMotion` 데이터, 편집 텍스트, 레이어와 그라데이션은 프로젝트에 유지됩니다. 끝 시각에는 마지막 관측을 표시합니다. composition의 관측 격자는 전역 시각 기준이므로 압축 구간마다 다시 시작하지 않습니다. `--fps`를 높여도 그 사이 관측이 추가되지 않습니다. `blend`와 `off`의 기존 동작은 유지되며, 프레임 모드는 이 기능을 지원하는 버전에서 열어야 합니다.

## 외부 영상 없이 검증하기

먼저 `npm run dev`를 실행한 상태에서 별도 터미널로 진행합니다.

```sh
.venv/bin/python scripts/create-fixtures.py
.venv/bin/python scripts/verify-analysis.py --base-url http://127.0.0.1:8000
node scripts/visual-qa.mjs
.venv/bin/python scripts/compare-frames.py
```

각 명령은 이전 단계의 결과를 읽습니다. 검증 영상은 평면 도형·텍스트·컷 전환·같은 색의 여러 오브젝트를 포함합니다. 이 영상에서 통과했다는 사실만으로 임의 영상의 변환 품질을 보장하지 않습니다. 비교 이미지의 RGB 차이는 관측값이며, 원본 유사도 백분율로 해석하지 않습니다. 일부 파일은 같은 출력 경로를 사용하므로 이전 검증 결과를 보관하려면 실행 전에 따로 복사합니다.

## 부품별 원본 비교

앱 schema 1/2의 `stackBoundary`를 사용하는 도형은 기본 면을 불투명하게 유지하면서 내부 `paintRegions`에 알파 색상·그라데이션을 겹칠 수 있습니다. 이를 이용해 빛과 그림자가 투명하게 사라지는 표면 조명을 표현합니다. 내부 그라데이션 좌표는 해당 영역이 아니라 도형 전체의 바운딩박스를 기준으로 하며, 최종 외곽 마스크가 모든 내부 조명을 함께 자릅니다. 내부 영역은 최대 8개, 각 그라데이션은 최대 16개 stop을 사용합니다. 이는 도형 내부 합성이며 프레임 간 혼합이나 별도 실험 스키마의 기능을 뜻하지 않습니다.

```sh
.venv/bin/python scripts/compare-parts.py \
  --manifest artifacts/my-video/comparison-input.json \
  --out-dir artifacts/my-video/part-comparison
```

`compare-parts.py`는 같은 시각·화면 크기로 준비한 **원본 이미지와 실제 렌더 이미지**를 호출자가 정한 고정 ROI별로 비교합니다. ROI는 주변 문맥을 보는 창이며 의미 부품의 정답 윤곽이 아닙니다. SVG 도형을 자동 추출하거나 윤곽을 맞추는 도구는 아닙니다. 출력은 `index.html`, `report.json`과 부품별 원본 문맥·현재 렌더·선택적 수정 전 렌더·50% 겹침·RGB 차이 3배 PNG입니다. 겹침은 검수용 진단 이미지이며 재생 방식이 아닙니다.

입력은 앱 schema 1/2, `object-scene-v1`과 별개의 `part-comparison-v1`입니다. 다음 좌표와 시각은 형식 예시이며, 실제 입력에 맞추어 정합니다.

```json
{
  "schema": "part-comparison-v1",
  "frames": [{
    "id": "frame-12",
    "time": 0.5,
    "source": "source/frame-12.png",
    "rendered": "candidate/frame-12.png",
    "baseline": "baseline/frame-12.png",
    "parts": [{
      "id": "body",
      "label": "몸통",
      "roi": [30, 20, 60, 50],
      "visibleMask": "annotations/body-visible-frame-12.png"
    }]
  }]
}
```

- `source`, `rendered`, 선택적 `baseline`, 선택적 `visibleMask`는 모두 manifest 파일 기준 상대 경로입니다. 입력은 단일 정지 이미지이며 투명 픽셀은 거부합니다. 투명 이미지는 호출 전에 동일 배경에 합성해야 합니다. 보고서에는 입력 파일별 SHA-256이 기록됩니다.
- 각 프레임의 원본·현재·수정 전 이미지는 크기가 같아야 합니다. 도구는 리사이즈, 카메라 정렬, 시간 정렬이나 색상 프로파일 변환을 하지 않습니다. 같은 크기여도 다른 시각의 이미지는 잘못된 비교이므로 호출자가 확인해야 합니다.
- `time`은 유한한 0 이상 초, `roi`는 이미지 픽셀 단위 정수 `[x, y, width, height]`입니다. 영역은 이미지 안에 있어야 합니다. ROI를 새 후보 도형의 크기에 따라 바꾸면 비교 조건이 달라지므로 반복 비교에서 고정합니다. 원본 문맥에 맞춰 정하는 것을 권장하며, 수정 전 도형의 경계로 초기화했다면 그 사실을 실험 기록에 남깁니다. 어느 경우에도 ROI를 원본 부품의 정확한 분할 마스크로 취급하지 않습니다.
- `id`는 영문자나 숫자로 시작하고 영문자·숫자·`_`·`-`만 허용하며 1~80자입니다. 프레임 ID는 전체에서, 부품 ID는 같은 프레임 안에서 중복될 수 없습니다. 대소문자만 다른 ID도 중복으로 처리합니다. `label`은 표시용 텍스트입니다.
- `visibleMask`는 원본과 같은 크기의 불투명 흑백 이미지이며 값은 0 또는 255만 허용합니다. 흰 픽셀은 **원본에서 실제로 보이는 해당 재질**의 독립 주석이어야 합니다. 가린 부품·추정한 내부·배경은 제외합니다. 후보 SVG 자체의 마스크를 정답으로 사용하면 안 됩니다. 마스크는 색상 비교 영역일 뿐 윤곽 정답이 아닙니다.

보고서는 `roiRgbMae`(고정 문맥 ROI의 RGB 채널 절대오차 평균, 0~255)를 기록합니다. 마스크가 있으면 `visibleRgbMae`와 평가 픽셀 수를 별도로 기록합니다. 원본 잘라보기에는 앞에 있는 다른 부품이나 배경이 포함될 수 있으므로 마스크 없는 값을 해당 부품만의 오차라고 해석하면 안 됩니다. `baseline`이 있으면 동일 ROI·동일 마스크의 수정 전 값과 `current - baseline` 차이를 함께 기록합니다. 음수는 해당 픽셀 차이가 줄었다는 뜻이며, 윤곽이나 움직임 전체가 좋아졌다는 뜻은 아닙니다. 모양 IoU나 재현 정확도 백분율은 계산하지 않습니다.

출력 디렉터리가 비어 있지 않으면 중단합니다. `--overwrite`는 같은 생성 파일 이름만 교체하며 관련 없는 파일은 삭제하지 않습니다. 입력 파일이나 manifest를 포함한 디렉터리, 입력 파일과 연결된 출력 파일, 심볼릭 링크 경로에는 덮어쓰지 않습니다. 이전 후보의 비교를 보존하려면 새 출력 폴더를 사용하세요. 도구의 성공은 입력 검증과 이미지·보고서 생성을 뜻하며, 사람이 전체 영상을 검수했다는 뜻은 아닙니다. `--help`로 옵션을 확인할 수 있습니다.

## 관측 도형 연결 도구

`scripts/object_scene_tracks.py`는 프레임별 도형 관측을 입력받아 컷 경계를 넘지 않는 트랙을 만듭니다. `scripts/object-scene-runtime.mjs`는 그 결과를 SVG로 그립니다. 재질 그룹 ID와 색상은 호출자가 정하며 특정 대상이나 영상 길이가 고정되어 있지 않습니다.

입력 메타데이터 예시:

```json
{"width":160,"height":90,"fps":12,"frameCount":2,"cuts":[]}
```

`observations.jsonl`은 한 줄에 한 프레임을 기록합니다. `0`부터 `frameCount - 1`까지 빠짐없이 필요합니다.

```jsonl
{"frame":0,"background":"#17212b","observations":[{"id":"moving-dot","label":"source-surface","kind":"ellipse","recolorGroup":"accent","fill":"#ed7049","geometry":{"cx":40,"cy":45,"rx":12,"ry":9}}]}
{"frame":1,"background":"#17212b","observations":[{"id":"moving-dot","label":"source-surface","kind":"ellipse","recolorGroup":"accent","fill":"#ed7049","geometry":{"cx":44,"cy":45,"rx":12,"ry":9}}]}
```

위 내용을 원하는 작업 폴더에 `meta.json`, `observations.jsonl`로 저장한 뒤 실행합니다.

```sh
.venv/bin/python scripts/object_scene_tracks.py \
  --meta work/meta.json \
  --observations work/observations.jsonl \
  --out work/object-scene.json \
  --report work/tracking-report.json
```

`--observations-dir`을 사용하면 JSONL 대신 `frame-0000.json`부터 순서대로 읽습니다. 지원 도형은 타원, 닫힌 윤곽, 닫힌 베지어 곡선입니다. `recolorGroup`은 선택 사항이며, `protectedPaint: true`는 해당 색을 변경 대상에서 제외합니다. `cuts`는 새 장면이 시작하는 정수 프레임 번호입니다.

렌더링 API는 프레임 단위 시간을 사용합니다. 다음 예제는 위 모델의 중간 프레임을 SVG로 저장합니다.

```js
import fs from 'node:fs/promises';
import {createObjectSceneRuntime} from './scripts/object-scene-runtime.mjs';

const model = JSON.parse(await fs.readFile('work/object-scene.json', 'utf8'));
const runtime = createObjectSceneRuntime();
runtime.validate(model);
const svg = runtime.render(model, 0.5, {
  colorOverrides: {
    accent: {baseColor: '#ed7049', targetColor: '#27b6a3'},
  },
});
await fs.writeFile('work/midpoint.svg', svg);
```

이 관측 예제는 160×90, 12fps, 2프레임으로 실행 검증했습니다. 중간 프레임의 타원 중심 `x=42`를 확인했습니다. 이것은 입력 형식과 연결·렌더링 동작의 검증이며, 다른 영상의 품질 검증이 아닙니다.

자동 연결은 도형·색상·위치 조건을 만족하는 인접 관측에만 적용됩니다. 가림이나 급격한 형태 변화가 있는 구간에서는 관측 포즈 유지 또는 트랙 분리가 필요합니다. 프레임 사이 원본 정답이 없는 경우 출력 FPS를 높였다는 사실만으로 움직임의 정확도를 주장하지 않습니다. 이 실험 도구에는 앱의 편집 가능한 텍스트를 자동 합성하는 기능이 포함되어 있지 않습니다.

`scripts/parametric-vector-model.mjs`는 별도의 수식 기반 벡터 모델 라이브러리입니다. `createParametricVectorRuntime()`으로 검증·평가·렌더링 함수를 가져오며 직접 실행하는 CLI가 아닙니다. 입력 예와 수치 검사는 `tests/engine/parametric.test.ts`를 참고합니다. 이 라이브러리 역시 앱 프로젝트 또는 `object-scene-v1`과 같은 형식이라고 가정해서는 안 됩니다.

## 공개 소스 검사와 패키징

```sh
node scripts/release-check.mjs
node scripts/package-source.mjs
```

| 파일 | 역할 | 결과 |
| --- | --- | --- |
| `scripts/release-check.mjs` | Git이 추적하거나 무시하지 않는 파일의 공개 범위·크기·일부 민감 문자열·카탈로그 포함 여부 검사 | `.cache/public-source-check.json` |
| `scripts/package-source.mjs` | 검사한 소스만 ZIP으로 묶고 압축을 다시 풀어 각 파일 해시 확인 | `dist/github-source/saegim-source.zip`, `package-check.json` |
| `scripts/lib/release-files.mjs` | 검사와 패키징에서 공유하는 파일 수집·해시·검사 함수 | 직접 실행하지 않는 모듈 |

두 명령은 로컬 Git 작업 폴더에서 사용합니다. 압축을 풀어 받은 소스는 `git init` 후 검사할 수 있습니다. 패키징은 GitHub 업로드·커밋·원격 저장소 생성을 수행하지 않습니다. 소스 검사의 크기 제한은 이 프로젝트의 정책이며, 문자열 검사는 모든 비밀 정보를 찾아낸다는 보장이 아닙니다. 코드를 추가하면 공개 포함 규칙과 `scripts/catalog.json`도 함께 갱신합니다.

## 데이터와 공개 범위

`.data/`, `.cache/`, `artifacts/`, `.venv/`, `node_modules/`는 실행 중 생기는 로컬 데이터이며 소스 코드가 아닙니다. 원본 영상, 렌더링 결과, 글꼴 파일, 분석 캐시를 저장소에 자동 포함하지 않습니다. 새로 받은 소스만으로 시작하려면 위의 자체 생성 검증 영상이나 사용자가 준비한 영상을 사용합니다.

과거 결과에 묶인 스크립트가 로컬 작업 폴더에 남아 있어도 공개 실행 경로의 일부가 아닙니다. `scripts/catalog.json`과 저장소의 공개 파일 목록을 기준으로 사용합니다. 스크립트를 추가할 때는 실제 입력·출력, 필수 선행 단계와 검증 범위를 함께 갱신합니다.

## 컷별 SVG 요소 내보내기

```sh
npm run workflow -- elements \
  --project artifacts/my-video/project.json \
  --regions artifacts/my-video/regions.json \
  --out-dir artifacts/my-elements
```

`regions.json`은 영상별 주석 데이터이며 공개 소스에 영상 이름·좌표·캐릭터를 고정하지 않습니다. `width`, `height`는 프로젝트와 같아야 합니다. `sections`는 전체 시간축을 빠짐없이 순서대로 덮고 실제 컷을 넘지 않아야 합니다. `time`은 해당 구간 안의 대표 시각입니다. 레이어는 앞쪽부터 순서대로 기록하고, `path`는 원본 좌표계에서 보이는 영역의 닫힌 SVG 경로입니다. 구멍은 even-odd 규칙을 사용합니다. 예시는 160×90, 2초, 1초 지점에 컷이 있는 프로젝트입니다.

```json
{
  "schemaVersion": 1, "width": 160, "height": 90,
  "sections": [
    {"id":"first", "name":"첫 컷", "start":0, "end":1, "time":0.5,
     "layers":[{"id":"left", "name":"왼쪽 요소", "path":"M0 0 H80 V90 H0 Z"},
               {"id":"right", "name":"오른쪽 영역", "path":"M80 0 H160 V90 H80 Z"}]},
    {"id":"second", "name":"다음 컷", "start":1, "end":2, "time":1.5,
     "layers":[{"id":"scene", "name":"장면", "path":"M0 0 H160 V90 H0 Z"}]}
  ]
}
```

실제 컷은 `temporal.cuts`에서 가져옵니다. 컷 정보가 없으면 하나의 컷으로 처리합니다. 분석 처리 구간 경계를 컷으로 추정하지 않습니다. 편집 구간은 사용자가 의미에 따라 지정하는 별도 단위입니다. `manifest.json`에 세 종류의 구분과 SVG 배치 좌표·기준 시각·해시를 기록합니다.

출력 `index.html`에서 컷과 편집 구간을 선택하고, 요소 표시/숨김, 선택 요소만 보기, 개별 SVG 저장과 전체 ZIP 저장을 사용할 수 있습니다. 폴더를 유지하면 로컬 파일로도 열립니다. 각 구간의 `scene.svg`는 분리 전 장면, `stack.svg`는 이름이 있는 요소 그룹을 다시 쌓은 장면입니다. 그라데이션·클리핑·실제 텍스트 요소를 보존하고 원본 이미지는 삽입하지 않습니다.

이 도구는 입력 마스크로 정적 대표 프레임을 분리합니다. 캐릭터 의미 영역을 자동 검출하거나 모든 프레임에 걸쳐 추적하는 도구는 아닙니다. `edgeOverlapPx`(기본 0, 최대 8)를 주석 루트에 지정하면 경계를 해당 원본 픽셀만큼 겹쳐 재합성 때 생기는 안티앨리어싱 틈을 줄입니다. 이 겹침은 재합성용 `stack.svg`와 `stack/` 이미지에만 적용하며, 개별 다운로드 SVG는 원래 마스크를 유지합니다. 합성 가장자리에 인접 색이 포함될 수 있으므로 작은 값부터 검수합니다. 겹치는 마스크는 겹치는 픽셀을 그대로 포함하므로, 보이는 영역의 소유권과 뒷배경을 주석 단계에서 검수해야 합니다. 배면 도형을 지정하지 않은 요소의 가려진 부분은 투명하게 유지합니다.

`npm run test:elements`는 별도 영상 없이 합성 composition으로 컷 경계 검증, SVG 텍스트·그라데이션 보존, ZIP, 오프라인 탐색·표시/숨김을 검사합니다.

### 곡선 윤곽과 완전한 배면 도형

`--smooth-px 3`은 M/L/H/V 경로를 꼭짓점을 보존하는 Bézier 곡선으로 다듬습니다. 0은 비활성화, 최대 8이며 원본 좌표계의 픽셀 단위입니다. 기존 곡선·텍스트·실제 구멍을 유지합니다. 후보 곡선을 양방향 표본 거리로 검사하고 허용치를 넘으면 원래 선분을 유지합니다. 표본 검사는 연속 곡선 전체의 수학적 오차 보증이 아니므로 작은 디테일을 확대 검수하세요. 확인된 원래 색면을 곡선 아래에 남겨 독립적으로 다듬은 색면 사이의 틈을 방지합니다.

가려져 생긴 구멍은 레이어의 `surface`로 채웁니다. `surface.project`는 같은 크기의 **앱 schemaVersion 1** 프로젝트 객체이며 배경은 `#00000000`, 노드는 0초부터 보이는 정적 도형이어야 합니다. 키프레임과 모션 트랙은 허용하지 않습니다. 경로·사각형·타원·그라데이션·텍스트를 기존 검증기로 검사하고 0초에 렌더링합니다. 원본 프로젝트는 수정하지 않습니다.

`surface.mode`의 `underlay`는 원래 보이는 부분 아래에 완전한 면을 추가하며, `replace`는 해당 요소를 기본 도형 프로젝트로 교체합니다. 앞쪽 요소는 `layers` 배열의 앞에 두고, 디스플레이·배경 같은 뒷면은 뒤에 둡니다. 고리나 다리 사이의 실제 빈 공간은 일괄적으로 메우지 않습니다. 추정 배면은 `<element>-surface.json`으로 함께 내보내며 라이브러리에서 다운로드할 수 있습니다. `manifest.json`에 zIndex, 배면 모드와 곡선화 통계를 기록합니다. 정적 대표 프레임용 기능이며 전체 영상 추적·보간 기능은 아닙니다.

`tests/workflow/element-assets.mjs`에는 실제 surface 프로젝트 예제가 있습니다. `npm run test:elements`는 앞쪽 물체를 숨겼을 때 배면이 남는지, 원래 구멍은 보존되는지, 텍스트·그라데이션·오프라인 파일·레이어 순서를 검사합니다.

### 주변 색을 측정해 배면 그라데이션 맞추기

```bash
npm run workflow -- fit-surfaces \
  --library artifacts/reference-elements/library \
  --regions artifacts/surface-regions.json \
  --out-dir artifacts/fitted-surfaces
npm run workflow -- elements \
  --project artifacts/my-video/project.json \
  --regions artifacts/fitted-surfaces/regions.json \
  --smooth-px 3 --out-dir artifacts/fitted-surfaces/library
```

참조 라이브러리의 `scene.svg`를 표본화하며, 영역 주석은 동일한 크기·구간 ID·대표 시각이어야 합니다. 프레임·화면·받침대와 같은 기존 surface 노드와 paintRegions를 각각 측정하고 앞에 가려진 영역을 제외합니다. 경계의 혼합색을 줄이기 위해 마스크 안쪽 표본을 사용하고, 채울 곳에 가까운 색에 더 높은 가중치를 줍니다. 기존 팔레트와 가까운 표본이 충분하면 다른 재질의 색을 제외합니다. 초기 색이 잘못된 경우에는 그 색을 강제하지 않습니다.

2·4·8개 중간 색과 여러 방향의 선형 그라데이션을 비교합니다. 기존 방사형 그라데이션도 후보에 포함합니다. 학습에 쓰지 않은 표본의 CIELAB ΔE76 색 차이가 줄어드는 경우만 적용하며, 표본이 적거나 투명한 조명은 유지합니다. 각 채널을 관측된 1~99백분위 범위로 제한해 과도한 외삽을 줄입니다. 도형·텍스트·쌓는 순서·원본 파일은 바꾸지 않으며 출력은 SVG 그라데이션입니다. 비트맵은 측정 과정에서만 사용합니다.

`gradient-fit-report.json`의 오차는 선택한 **보이는 색 표본**에 대한 값이며, 가려진 원본 색의 정확도나 영상 전체의 재현율이 아닙니다. 복잡한 여러 색 방향이나 좁은 반사광이 한 면에 섞여 있다면 surface 영역을 더 나누어 검수하세요. 기본 출력은 이전처럼 정적 대표 SVG입니다.

관측되지 않은 부위처럼 색을 측정하면 안 되는 배면에는 `surface.fitColors: false`를 지정할 수 있습니다. 이 경우 도형과 지정 색을 그대로 유지합니다.
