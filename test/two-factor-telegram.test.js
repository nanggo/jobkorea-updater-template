const test = require("node:test");
const assert = require("node:assert/strict");
const { TelegramAuthChannel } = require("../dist/services/telegramAuth");
const { authenticateViaTelegram } = require("../dist/services/twoFactorTelegram");
const { AuthenticationError } = require("../dist/types");
const config = { token: "12345:synthetic-token", chatId: "10001" };

test("waits for readiness before sending SMS and submits one code", async t => {
  const calls = [];
  t.mock.method(TelegramAuthChannel.prototype, "validate", async () => { calls.push("validate"); });
  t.mock.method(TelegramAuthChannel.prototype, "buttonPrompt", async () => { calls.push("button"); return { id: 1, date: 1 }; });
  t.mock.method(TelegramAuthChannel.prototype, "waitForButton", async () => { calls.push("ready"); });
  t.mock.method(TelegramAuthChannel.prototype, "prompt", async () => { calls.push("prompt"); return { id: 1, date: 1 }; });
  t.mock.method(TelegramAuthChannel.prototype, "waitForReply", async (_, __, accepts) => {
    assert.equal(accepts("123456"), true); calls.push("code"); return "123456";
  });
  t.mock.method(TelegramAuthChannel.prototype, "finish", async success => { calls.push(success ? "success" : "failure"); });
  await authenticateViaTelegram({ requestSmsTwoFactor: async () => { calls.push("sms"); return Date.now() + 180000; }, submitTwoFactorCode: async code => { assert.equal(code, "123456"); calls.push("submit"); } }, config);
  assert.deepEqual(calls, ["validate", "button", "ready", "sms", "prompt", "code", "submit", "success"]);
});

test("an uncertain SMS submission is permanent and never repeats the send", async t => {
  let sends = 0, submissions = 0, finished;
  t.mock.method(TelegramAuthChannel.prototype, "validate", async () => {});
  t.mock.method(TelegramAuthChannel.prototype, "buttonPrompt", async () => ({ id: 1, date: 1 }));
  t.mock.method(TelegramAuthChannel.prototype, "waitForButton", async () => {});
  t.mock.method(TelegramAuthChannel.prototype, "prompt", async () => ({ id: 1, date: 1 }));
  t.mock.method(TelegramAuthChannel.prototype, "waitForReply", async () => "인증");
  t.mock.method(TelegramAuthChannel.prototype, "finish", async success => { finished = success; });
  await assert.rejects(authenticateViaTelegram({
    requestSmsTwoFactor: async () => { sends++; throw new Error("response unavailable"); },
    submitTwoFactorCode: async () => { submissions++; },
  }, config), error => error instanceof AuthenticationError && !error.retryable);
  assert.equal(sends, 1); assert.equal(submissions, 0); assert.equal(finished, false);
});
