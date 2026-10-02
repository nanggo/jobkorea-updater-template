const test = require("node:test");
const assert = require("node:assert/strict");

const {
  canHonorTelegramRetryAfter,
  parseTelegramRetryAfterMs,
} = require("../dist/notify");

test("prefers Telegram response_parameters.retry_after over the HTTP header", () => {
  const body = JSON.stringify({
    ok: false,
    description: "Too Many Requests",
    parameters: { retry_after: 42 },
  });

  assert.equal(parseTelegramRetryAfterMs(body, "5"), 42_000);
});

test("falls back to Retry-After seconds and rejects malformed values", () => {
  assert.equal(parseTelegramRetryAfterMs("not-json", "3"), 3_000);
  assert.equal(parseTelegramRetryAfterMs("{}", "invalid"), undefined);
});

test("never retries earlier than Telegram requested", () => {
  assert.equal(canHonorTelegramRetryAfter(5_000, 10_000, 20_000), true);
  assert.equal(canHonorTelegramRetryAfter(42_000, 10_000, 60_000), false);
  assert.equal(canHonorTelegramRetryAfter(10_000, 10_000, 9_000), false);
});
