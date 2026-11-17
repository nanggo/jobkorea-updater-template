const test = require("node:test");
const assert = require("node:assert/strict");
process.env.LOG_LEVEL = "error";
delete process.env.JOBKOREA_AUTH_STATE_DIR;
delete process.env.TELEGRAM_AUTH_ENABLED;
const { BrowserService } = require("../dist/services/browser");
const { JobKoreaService } = require("../dist/services/jobkorea");
const { AuthenticationError, TwoFactorAuthenticationError } = require("../dist/types");
const notify = require("../dist/notify");
const { updateResume } = require("../dist/updateResume");
const telegramAuth = require("../dist/services/twoFactorTelegram");
const config = { jobkoreaId: "synthetic-account", jobkoreaPwd: "synthetic-password", telegramToken: "synthetic-token", telegramChatId: "synthetic-chat" };

function setup(t, { hasState = true, valid = true, challenge = false, saveFailure = false } = {}) {
  const calls = [];
  const messages = [];
  const patch = (object, method, implementation) => t.mock.method(object, method, implementation);
  patch(notify, "sendTelegramMessage", async (_, __, message) => { messages.push(message); });
  patch(BrowserService.prototype, "initialize", async () => { calls.push("initialize"); });
  patch(BrowserService.prototype, "getPage", () => ({}));
  patch(BrowserService.prototype, "close", async () => { calls.push("close"); });
  patch(BrowserService.prototype, "hasStoredAuthState", () => hasState);
  patch(BrowserService.prototype, "saveAuthenticatedState", async () => {
    calls.push("save");
    if (saveFailure) throw new AuthenticationError("state write failed");
  });
  patch(JobKoreaService.prototype, "tryRestoreSession", async () => {
    calls.push("restore");
    if (challenge) throw new TwoFactorAuthenticationError();
    return valid;
  });
  patch(JobKoreaService.prototype, "navigateToLoginPage", async () => { calls.push("login-page"); });
  patch(JobKoreaService.prototype, "login", async () => {
    calls.push("login");
    if (challenge) throw new TwoFactorAuthenticationError();
    return null;
  });
  patch(JobKoreaService.prototype, "handleLoginPopup", async () => { calls.push("popup"); });
  patch(JobKoreaService.prototype, "navigateToMypage", async () => { calls.push("mypage"); });
  patch(JobKoreaService.prototype, "updateCareerInfo", async () => { calls.push("update"); });
  return { calls, messages };
}

test("updater reuses validated auth without submitting credentials", async t => {
  const { calls } = setup(t);
  await updateResume(config);
  assert.deepEqual(calls, ["initialize", "restore", "save", "update", "close"]);
});

test("expired auth falls back to exactly one login and is saved only after mypage verification", async t => {
  const { calls } = setup(t, { valid: false });
  await updateResume(config);
  assert.deepEqual(calls, ["initialize", "restore", "login-page", "login", "popup", "mypage", "save", "update", "close"]);
});

for (const hasState of [false, true]) {
  test(`2FA stops the whole updater without save, resume mutation, or restart (saved state: ${hasState})`, async t => {
    const { calls, messages } = setup(t, { hasState, challenge: true });
    await assert.rejects(updateResume(config), TwoFactorAuthenticationError);
    assert.equal(calls.filter(call => call === "initialize").length, 1);
    assert.equal(calls.includes("save"), false);
    assert.equal(calls.includes("update"), false);
    assert.equal(messages.length, 1);
    assert.match(messages[0], /2단계 인증/);
    assert.match(messages[0], /README의 최초 인증 절차/);
    assert.doesNotMatch(messages[0], /자동 생성/);
  });
}

test("state-write failure stops before the resume mutation", async t => {
  const { calls } = setup(t, { saveFailure: true });
  await assert.rejects(updateResume(config), AuthenticationError);
  assert.equal(calls.includes("update"), false);
  assert.equal(calls.filter(call => call === "initialize").length, 1);
});

test("enabled Telegram authentication resumes the same browser and updates only after verification", async t => {
  const { calls } = setup(t, { challenge: true });
  process.env.TELEGRAM_AUTH_ENABLED = "true";
  t.after(() => { delete process.env.TELEGRAM_AUTH_ENABLED; });
  t.mock.method(telegramAuth, "authenticateViaTelegram", async () => { calls.push("telegram-auth"); });
  await updateResume(config);
  assert.deepEqual(calls, ["initialize", "restore", "telegram-auth", "save", "update", "close"]);
});
