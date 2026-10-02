# 운영 workflow 설치

이 폴더의 YAML은 예제입니다. GitHub Actions는 `.github/workflows/`에 설치하기 전에는 실행하지 않습니다. **본인이 관리하는 private 저장소**에 설치하고, 공개 템플릿 저장소에 운영 runner나 Secrets를 연결하지 마세요.

## 1. 실행 환경 확인

- Linux, Node.js 24, pnpm 10.30.3을 사용합니다.
- 서버에서 `https://www.jobkorea.co.kr/Login/`으로 접속할 수 있는지 확인합니다.
- GitHub, 패키지 registry, Playwright 브라우저 다운로드, Telegram API에도 연결할 수 있어야 합니다.
- Chromium OS 의존성과 sandbox 지원을 관리자 권한으로 미리 준비합니다. 예를 들어 프로젝트 의존성을 설치한 뒤 관리자가 `pnpm exec playwright install-deps chromium`을 실행할 수 있습니다.
- Linux 자체 runner를 **해당 private 저장소**에 등록하고 `jobkorea`라는 사용자 지정 label을 붙입니다. 예제의 `runs-on: [self-hosted, jobkorea]`와 일치해야 합니다. 별도 label을 쓰려면 probe와 update job을 함께 수정하세요.
- 테스트와 갱신을 위한 전용 실행 계정을 사용합니다. 자체 runner 작업은 실행 사이에 파일과 캐시를 보관할 수 있습니다.

예제에서 `actions: write`는 GitHub-hosted 알림·재시도·keepalive job에만 부여됩니다. 자격증명이 주입되는 자체 runner job은 `contents: read`만 사용합니다.

## 2. Secrets 준비

운영 저장소의 **Settings → Secrets and variables → Actions → Secrets**에 다음 네 값을 등록합니다.

- `JOBKOREA_ID`
- `JOBKOREA_PWD`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

처음에는 **Variables**의 `ENABLE_AUTOMATION`을 설정하지 않습니다. 예제의 운영 job은 이 변수가 문자열 `true`일 때만 실행합니다.

## 3. Workflow 설치와 첫 실행

1. 아래 세 YAML을 운영 저장소의 `.github/workflows/`로 복사합니다. CI 파일은 유지합니다.
   - `update_resume.yml`
   - `auto_rerun_update_resume.yml`
   - `update_resume_watchdog.yml`
2. **처음에는 `update_resume.yml`과 `update_resume_watchdog.yml`에서 `on.schedule` 블록을 제거**해 수동 실행만 가능하게 합니다. `workflow_dispatch`는 남깁니다.
3. 변경을 검토한 뒤 운영 저장소의 기본 브랜치에 반영합니다. GitHub Actions가 비활성화되어 있다면 켭니다.
4. Actions Variables에서 `ENABLE_AUTOMATION=true`를 설정합니다.
5. **Update Resume → Run workflow**를 실행합니다. `chain_id`는 비우고 `attempt=1`을 사용합니다. 이는 실제 계정으로 로그인하고 이력서를 갱신합니다.
6. 실행 로그, 실제 이력서 갱신 결과와 Telegram 수신을 확인합니다. 로그인 문제라면 반복 실행하기 전에 사이트에서 계정 상태를 확인하세요.
7. 성공하면 제거했던 두 `schedule` 블록을 복원해 기본 브랜치에 반영합니다.

Watchdog은 예약 슬롯을 감시합니다. 수동 갱신 성공만으로 예약 슬롯의 성공이 되지는 않으므로, 첫 예약 실행 후 해당 슬롯이 성공으로 인식되는지 확인하세요. 수동 watchdog 점검 시 아직 예약 실행이 없으면 누락 알림이 오는 것이 정상입니다.

중지하려면 `ENABLE_AUTOMATION`을 `false`로 설정하고 필요하면 Actions 화면에서 workflow를 비활성화합니다. 변수 변경은 이미 실행 중인 job을 중단하지 않으므로 진행 중인 실행은 별도로 확인하세요.

## 4. 일정과 재시도

예제 기본 일정은 08:50·12:50 KST이며, YAML cron은 UTC입니다. 일정을 바꿀 때는 다음을 함께 수정합니다.

- 갱신 workflow의 두 `schedule.cron`
- watchdog의 두 cron과 내부 `SLOT_CRON` 매핑, 슬롯 설명
- `test/workflow-retry.test.js`의 일정 검증

일시적인 연결 실패만 workflow 단위로 최대 4회 재시도합니다. 자동 재시도는 `chain_id`와 `attempt`를 유지합니다. 재시도를 예약한 실행 자체는 실패로 표시될 수 있으므로 후속 실행의 결과를 확인하세요. 인증·보안 경계·중복 갱신 위험이 있는 오류는 같은 방식으로 재시도하지 않습니다.

## 5. Keepalive와 검증 범위

갱신과 watchdog에는 각각 독립된 GitHub-hosted keepalive job이 있습니다. 예약 실행이며 `ENABLE_AUTOMATION=true`인 경우에만 동작합니다. `actions: write`로 자신의 workflow를 활성화하고, API 실패는 보조 단계의 실패로만 처리합니다. keepalive action은 검토한 v1 commit에 고정되어 있습니다.

공개 저장소의 60일 무활동 제한을 고려한 예제이지만 **자체 runner를 사용하는 운영 구성은 private 저장소를 권장**합니다. public으로 운영하려면 runner 접근 경계부터 별도로 설계해야 합니다. 이미 비활성화된 workflow는 수동으로 다시 켜야 합니다.

이 템플릿의 CI는 실제 계정과 자체 runner를 사용하지 않습니다. 로컬 fixture, workflow shell mock, 권한·활성화 조건 검증을 통과해도 사용자 네트워크와 잡코리아 계정에서의 운영 성공을 보장하지 않습니다.

`pnpm test`는 이 폴더의 원본 예제를 검사합니다. 설치한 `.github/workflows/`의 운영 YAML을 변경하면 해당 변경을 예제와 테스트에도 반영해 검증 대상이 어긋나지 않게 하세요.
