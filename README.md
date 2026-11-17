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
- 2단계 인증: 추가 인증이 필요하면 Telegram으로 인증번호를 받아 같은 실행에서 이어갑니다. 아래 [2단계 인증과 인증 상태 유지](#2단계-인증과-인증-상태-유지)를 참고하세요.
- 중복 방지: 원래 실행 ID와 시도 번호를 기준으로 이미 생성된 재시도를 확인합니다.
- Watchdog: 각 예약 슬롯의 8시간 뒤 성공 여부를 확인하고 누락·실패를 Telegram으로 알립니다.
- Keepalive: 갱신과 watchdog 예제 각각에 포함합니다. 더미 커밋 없이 해당 workflow를 다시 활성화하는 보조 작업이며, API 오류는 갱신 결과를 실패로 바꾸지 않습니다. private 저장소에는 60일 무활동 제한이 적용되지 않지만 예제에는 포함되어 있습니다.

Keepalive는 [해당 workflow 하나만 활성화](https://github.com/liskin/gh-workflow-keepalive)합니다. 이미 꺼진 예약 실행을 스스로 시작하거나 GitHub의 장애를 해결하는 기능은 아닙니다. 갱신과 watchdog 모두 GitHub 스케줄러에 의존하므로 외부 서비스 수준의 가용성 감시를 대신하지 않습니다.

## 2단계 인증과 인증 상태 유지

로그인 뒤 `/user/TwoFactorAuth/`로 이동하면 `TELEGRAM_AUTH_ENABLED=true`일 때 같은 브라우저에서 Telegram 재인증을 기다립니다. 비활성화했거나 재인증에 실패하면 인증 오류로 종료하며 프로세스·workflow 재시도를 하지 않습니다. 인증 화면은 진단 파일로 저장하지 않습니다.

`JOBKOREA_AUTH_STATE_DIR`을 지정하면 저장된 쿠키·localStorage로 마이페이지 접근을 먼저 확인합니다. 로그인이 유효하면 자격증명을 다시 제출하지 않고, 만료되어 로그인 화면이나 홈으로 돌아온 경우에만 기존 로그인 절차를 한 번 진행합니다. 2단계 인증이 다시 필요하면 사람이 재인증해야 합니다. 실제 유지 기간은 잡코리아의 판단에 따르며 코드에서 고정하지 않습니다.

상태 파일은 저장소 밖의 전용 디렉터리(권한 `700`)에 `state.json`(권한 `600`)으로 원자적으로 저장합니다. 잡코리아 쿠키·localStorage만 보관하고 계정 ID의 해시로 실행 계정을 구분합니다. 다른 계정, 잘못된 파일, 넓은 접근 권한은 오류로 중단합니다. 파일에는 로그인 권한을 제공하는 정보가 있으므로 Git, Actions artifact, 채팅에 올리지 않습니다. IndexedDB/sessionStorage 의존 인증은 저장 대상이 아닙니다.

예제 workflow는 runner 사용자의 `$HOME/.local/state/jobkorea-updater`를 사용합니다. checkout 정리와 별개로 유지되며, 최초 인증도 **같은 서버의 같은 runner 사용자**로 실행합니다. 실행마다 홈이 초기화되는 runner에서는 상태가 남지 않습니다.

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `TELEGRAM_AUTH_ENABLED` | `false` | 추가 인증 시 Telegram으로 인증번호를 받습니다. 예제 갱신 workflow는 `true` |
| `TELEGRAM_AUTH_BOT_TOKEN` | 알림 bot token | 별도 인증 봇 token (선택) |
| `TELEGRAM_AUTH_CHAT_ID` | 알림 chat ID | 인증번호를 받을 본인 개인 대화의 숫자 ID (선택) |
| `JOBKOREA_AUTH_STATE_DIR` | 미설정 | 저장소 밖 인증 상태 전용 절대 경로. 미설정 시 저장·복원을 하지 않습니다 |

### 최초 인증

기본 방법은 Telegram입니다. 운영 저장소에 설치한 **Authenticate JobKorea** workflow를 `method=telegram`으로 실행하거나, 자동 갱신 중 추가 인증이 필요한 경우 다음 순서로 진행합니다.

1. 봇의 준비 요청에서 **인증번호 받기** 버튼을 누릅니다. 버튼은 최대 7분 동안 사용할 수 있으며 누르기 전에는 문자를 발송하지 않습니다.
2. 봇이 잡코리아에서 등록된 휴대폰으로 문자를 한 번 발송합니다.
3. **인증번호 입력** 버튼을 눌러 입력 안내를 열거나, 같은 대화의 입력창에 받은 6자리 코드를 보냅니다. 일반 메시지와 답장을 모두 받습니다. 잡코리아 화면의 남은 시간과 문자 발송 시각을 기준으로 최대 3분만 받습니다.
4. 코드를 한 번 제출하고 완료 안내를 확인한 뒤 인증 상태를 저장합니다. 자동 갱신 중이었다면 같은 실행에서 이력서 갱신을 이어갑니다.

인증번호는 **본인과 봇의 개인 대화**에서만 받습니다. 사용자 ID, 요청보다 새로운 message ID, 메시지 시간을 함께 검사하며 단체방·전달 메시지·다른 사람·이전 요청에 붙인 답장은 사용하지 않습니다. 알림을 단체방이나 채널로 받는다면 `TELEGRAM_AUTH_CHAT_ID`에 본인 개인 대화의 ID를 지정하세요. `취소`로 중단할 수 있고, 처리한 메시지와 요청 메시지는 삭제합니다. 삭제 실패는 경고하며, 코드·수신 payload를 파일이나 로그에 저장하지 않습니다. 늦게 확인했다면 인증 workflow를 다시 실행해야 합니다.

버튼은 본인·개인 대화·해당 봇 메시지·요청별 임의 토큰·마감 시간을 함께 확인하고, 누른 버튼은 제거합니다. 남은 시간은 Telegram의 상대 시각 표시로 앱에서 갱신되며 정확한 KST 마감 시각도 함께 적습니다. 만료된 클릭과 코드는 거절합니다.

기존 webhook은 제거하거나 바꾸지 않습니다. 같은 봇의 `getUpdates`를 다른 프로그램이 사용한다면 전용 인증 봇을 만들고 `TELEGRAM_AUTH_BOT_TOKEN`, `TELEGRAM_AUTH_CHAT_ID` secrets를 지정하세요. 인증 중에는 해당 봇의 업데이트 큐를 소비하므로 수신기를 중복 운영하면 안 됩니다.

실제 인증번호나 잡코리아 로그인을 사용하지 않는 연결 테스트는 `method=telegram-test`입니다. **연결 테스트 시작** 버튼을 누른 뒤 **인증번호 입력**을 눌러 테스트용 번호 `123456`을 보내면 버튼·입력·삭제를 검증합니다. 실제 번호는 보내지 않습니다.

```sh
gh workflow run authenticate.yml --ref main -f method=telegram-test
```

인증 상태만 점검하려면 `method=check`를 선택합니다. 인증 workflow는 갱신 workflow와 같은 concurrency 그룹을 사용해 동시에 실행되지 않고, 이력서 변경·artifact 업로드·후속 workflow dispatch를 하지 않습니다. 자동 trigger는 없으며 `main`에서만 실행됩니다.

### 브라우저에서 직접 인증하기

GUI가 있는 환경에서는 환경변수를 설정하고 `pnpm auth:setup`을 실행합니다. ID·비밀번호는 검증된 로그인 폼에 한 번만 제출하고, 문자·이메일 인증은 열린 브라우저에서 직접 완료합니다. 이 명령은 이력서를 수정하거나 Telegram을 보내지 않습니다.

화면이 없는 서버에서는 로컬 Chrome으로 서버의 브라우저를 조작합니다. 먼저 로컬 터미널에서 runner 서버로 SSH 터널을 유지합니다.

```sh
ssh -N -L 127.0.0.1:9222:127.0.0.1:9222 <runner-host>
```

그다음 인증 workflow를 `method=browser`로 실행하거나, 서버에서 **runner를 실행하는 사용자**의 셸로 checkout에 들어가 직접 실행합니다. Bash의 `read`를 사용하면 비밀번호가 셸 기록이나 명령 인수에 들어가지 않습니다.

```bash
export JOBKOREA_AUTH_STATE_DIR="$HOME/.local/state/jobkorea-updater"
read -rp 'JobKorea ID: ' JOBKOREA_ID
read -rsp 'JobKorea password: ' JOBKOREA_PWD
printf '\n'
export JOBKOREA_ID JOBKOREA_PWD
pnpm auth:setup --headless --debug-port=9222
unset JOBKOREA_PWD
```

로컬 Chrome의 `chrome://inspect/#devices` → Configure에 `localhost:9222`를 추가하고, 잡코리아 인증 페이지의 **inspect**를 엽니다. DevTools의 화면 미러링(screencast)에서 인증 수단을 선택하고 받은 번호를 **잡코리아 페이지에 직접** 입력합니다. 최초 인증은 최대 10분 기다리며, 사이트의 인증번호 유효시간은 별도로 적용됩니다. debugger는 loopback에만 열고 인증 명령 종료 시 닫히므로 방화벽에 이 포트를 공개하지 않습니다.

인증 명령은 마이페이지 접근을 확인한 뒤 상태를 저장하고, 브라우저를 완전히 종료한 다음 **새 Chromium 프로세스로 재사용을 검증**합니다. 재사용 검증이 실패하면 인증을 성공으로 간주하지 않습니다. 이후에도 `pnpm auth:check`로 이력서 변경 없이 재확인할 수 있습니다. 메일함이나 SMS 수신함을 읽지 않으며, 본인이 현재 요청에 전달한 코드만 사용합니다.

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

### 이후 변경 가져오기

템플릿으로 만든 저장소는 이 저장소와 Git 히스토리를 공유하지 않아 `git merge`나 `git pull`로 가져올 수 없습니다. 템플릿을 remote로 추가하고 필요한 커밋을 골라 적용하세요.

```sh
git remote add template https://github.com/nanggo/jobkorea-updater-template.git
git fetch template
git log --oneline template/main   # 가져올 커밋 확인
git cherry-pick <commit>
```

여러 커밋을 가져올 때는 오래된 것부터 순서대로 적용합니다. 적용한 뒤 `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm test`로 확인하세요.

**cherry-pick은 `examples/workflows/`만 바꿉니다.** `.github/workflows/`에 설치한 복사본은 그대로 남습니다. 예제가 바뀐 커밋이라면 `git show <commit> -- examples/workflows/`로 변경분을 확인해 설치본에 같은 내용을 반영하고, 새로 추가된 예제는 복사하세요. `pnpm test`는 예제만 검사하므로 이 누락을 알려주지 않습니다.

라이선스: [ISC](LICENSE).
