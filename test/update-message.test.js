const test = require("node:test");
const assert = require("node:assert/strict");

const { configManager } = require("../dist/config");
const { AuthenticationError, NavigationError } = require("../dist/types");
const { Logger } = require("../dist/utils/logger");
const {
  formatFailureNotification,
  sanitizeNotificationErrorDetail,
} = require("../dist/updateResume");

test("update success patterns accept the observed resume dialog but not generic edits", () => {
  const patterns = configManager.getUpdateConfig().successPatterns;
  const observedMessage =
    "이력서 수정일이 오늘날짜로 업데이트 되었습니다. 최신 이력서로 입사지원 하세요";

  assert.equal(
    patterns.some(pattern => observedMessage.includes(pattern)),
    true
  );
  assert.equal(
    patterns.some(pattern => "프로필이 수정되었습니다".includes(pattern)),
    false
  );
});

test("notification errors redact secrets and stay below Telegram's limit", () => {
  const secret = "notification-password";
  Logger.registerSensitiveValues([secret]);
  const detail = sanitizeNotificationErrorDetail(
    `locator.fill: ${secret} https://evil.example/${encodeURIComponent(secret)}?token=abc ${"<&".repeat(5000)}`
  );

  assert.equal(detail.length <= 2800, true);
  assert.doesNotMatch(detail, /notification-password|token=abc|evil\.example\/notification/);
  assert.match(detail, /\[생략됨\]$/);
  assert.doesNotMatch(detail, /<(?!\/)|&(?!amp;|lt;|gt;)/);
});

test("retryable workflow navigation failures use temporary notifications", () => {
  const temporaryMessage = formatFailureNotification(
    new NavigationError("temporary navigation"),
    3,
    "2"
  );
  assert.match(temporaryMessage, /일시 실패/);
  assert.match(temporaryMessage, /workflow 3\/4번째 시도/);
  assert.doesNotMatch(temporaryMessage, /최종 실패/);

  const terminalMessage = formatFailureNotification(
    new NavigationError("temporary navigation"),
    3,
    "4"
  );
  assert.match(terminalMessage, /최종 실패/);

  const authenticationMessage = formatFailureNotification(
    new AuthenticationError("rejected"),
    1,
    "1"
  );
  assert.match(authenticationMessage, /최종 실패/);
  assert.doesNotMatch(authenticationMessage, /일시 실패/);
});
