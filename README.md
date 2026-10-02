# JobKorea Updater Template

Playwright로 잡코리아 이력서를 갱신하고 Telegram으로 결과를 알리는 TypeScript 자동화 템플릿입니다.

**이 공개 저장소에서는 계정 없이 테스트와 빌드만 실행합니다.** 실제 자동화는 이 템플릿으로 만든 사용자의 **private 저장소**에서 설정하세요. 운영용 workflow는 [`examples/workflows/`](examples/workflows/)에 있어 복사하기 전에는 실행되지 않습니다. 로그인 정보, Telegram 토큰, 연결된 운영 runner는 제공하지 않습니다.

## 시작하기

1. GitHub의 **Use this template → Create a new repository**에서 새 저장소를 **Private**으로 만듭니다. GitHub Fork 대신 템플릿 생성을 사용하면 독립적인 저장소로 시작할 수 있습니다.
2. 만든 저장소를 로컬에 clone합니다.
3. Node.js 24와 pnpm 10.30.3을 준비하고 아래 검증을 실행합니다.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm lint
pnpm test
pnpm test:browser
```

Linux에서 Chromium OS 패키지가 없다면 관리자가 `pnpm exec playwright install-deps chromium`을 실행해 준비해야 합니다. 브라우저는 sandbox를 사용하므로 해당 기능을 허용하는 실행 환경이 필요합니다.

테스트는 실제 계정 없이 로컬 fixture와 mock으로 실행합니다. `pnpm test:browser`는 실제 Chromium을 실행하지만 외부 웹사이트 응답을 로컬 fixture로 대체합니다.

## 로컬에서 실행하기

```sh
cp .env.example .env
```

아래 네 값을 본인 계정 정보로 채운 후 `pnpm start`를 실행합니다. 이 명령은 새로 빌드한 뒤 **실제 이력서 갱신을 시도**합니다.

| 변수 | 설정할 값 |
| --- | --- |
| `JOBKOREA_ID` | 잡코리아 로그인 ID |
| `JOBKOREA_PWD` | 잡코리아 로그인 비밀번호 |
| `TELEGRAM_BOT_TOKEN` | 본인의 Telegram bot token |
| `TELEGRAM_CHAT_ID` | 봇이 메시지를 보낼 chat ID |

`.env`와 `.env.*`는 Git에서 제외되며, 값이 없는 `.env.example`만 공유합니다. timeout 등 선택 설정도 이 예제 파일에 있습니다.

## 자체 runner를 사용하게 된 이유

이 자동화를 운영하는 과정에서 해외 GitHub-hosted runner가 잡코리아 로그인 페이지에 연결하지 못하는 현상이 반복됐습니다. 잡코리아에 접속하는 probe와 이력서 갱신 작업을 한국 리전의 자체 runner로 옮겼고, 계정이 필요 없는 테스트와 빌드는 GitHub-hosted runner에 유지했습니다.

이는 당시 실행 환경에서 관찰한 현상입니다. 잡코리아가 모든 해외 접속을 차단한다는 뜻도, 한국 리전이면 항상 연결된다는 보장도 아닙니다. 사용할 서버에서 로그인 페이지 접속부터 확인하세요. OCI 한국 리전은 한 가지 선택지이며 특정 클라우드를 반드시 사용할 필요는 없습니다.

예제는 Chromium sandbox와 필요한 OS 패키지가 준비된 Linux runner를 가정합니다. Ubuntu 22.04를 기준으로 확인하며, 사용자 계정은 런타임에 sudo 권한이 없어도 됩니다. macOS나 다른 Linux 배포판에서의 운영은 별도 확인이 필요합니다.

**자체 runner는 private 운영 저장소에 연결하세요.** 외부 사용자가 PR을 만드는 공개 저장소에 운영 runner를 연결하지 않습니다. 공개 저장소에서의 위험은 [GitHub 자체 runner 안내](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/add-runners)를 참고하세요.

## 예약 실행

[`examples/workflows/README.md`](examples/workflows/README.md)의 순서대로 runner, Secrets, workflow를 설치하고 수동 실행을 확인한 다음 예약 실행을 켭니다.

- 기본 일정: 매일 08:50, 12:50 KST. GitHub cron은 정시 실행을 보장하지 않습니다.
- 연결 실패: workflow 단위로 최대 4회 시도하며 약 3분, 8분, 15분 후 재시도합니다.
- 인증 실패: 계정 잠금을 피하려고 자동 재시도하지 않습니다.
- 중복 방지: 원래 실행 ID와 시도 번호를 기준으로 이미 생성된 재시도를 확인합니다.
- Watchdog: 각 예약 슬롯의 8시간 뒤 성공 여부를 확인하고 누락·실패를 Telegram으로 알립니다.
- Keepalive: 갱신과 watchdog 예제 각각에 포함합니다. 더미 커밋 없이 해당 workflow를 다시 활성화하는 보조 작업이며, API 오류는 갱신 결과를 실패로 바꾸지 않습니다. private 저장소에는 60일 무활동 제한이 적용되지 않지만 예제에는 포함되어 있습니다.

Keepalive는 [해당 workflow 하나만 활성화](https://github.com/liskin/gh-workflow-keepalive)합니다. 이미 꺼진 예약 실행을 스스로 시작하거나 GitHub의 장애를 해결하는 기능은 아닙니다. 갱신과 watchdog 모두 GitHub 스케줄러에 의존하므로 외부 서비스 수준의 가용성 감시를 대신하지 않습니다.

## 진단과 정보 보호

- 로그인 폼과 이동 대상의 도메인을 확인하고 자격증명이 입력된 동안 외부 요청을 제한합니다.
- 로그에서 등록된 자격증명과 URL의 query·fragment를 마스킹합니다. 로그를 다른 사람에게 공유하기 전에는 내용을 직접 확인하세요.
- 실패 화면·HTML 저장은 기본적으로 꺼져 있습니다. `CAPTURE_FAILURE_ARTIFACTS=true`는 로컬 진단용이며 저장된 파일에 개인정보가 들어갈 수 있습니다.
- 예제 workflow는 화면·HTML 진단 파일을 Actions artifact로 업로드하지 않습니다.

## 구조와 업데이트

```text
src/                    자동화 소스
test/                   계정 없이 실행하는 테스트
.github/workflows/ci.yml 공개 저장소에서도 실행 가능한 CI
examples/workflows/     private 운영 저장소에 설치할 예제
.env.example            값이 비어 있는 환경변수 양식
```

이 저장소는 소스를 재사용하기 위한 출발점입니다. 템플릿으로 생성한 저장소에 이후 수정이 자동 반영되지는 않습니다. 공통 수정은 공개 저장소에서 확인하고 필요한 변경을 검토·테스트한 후 운영 저장소에 반영하세요. 공개 저장소의 최신 코드를 운영 runner가 무조건 내려받아 실행하게 구성하지 않습니다.

라이선스: [ISC](LICENSE).
