const test = require("node:test");
const assert = require("node:assert/strict");

process.env.LOG_LEVEL = "error";

const {
  calculateRetryDelay,
  withBrowserRestart,
  withRetry,
} = require("../dist/utils/retry");
const {
  AuthenticationError,
  getFailureExitCode,
  isRetryableJobKoreaError,
  NavigationError,
  RETRYABLE_NAVIGATION_EXIT_CODE,
} = require("../dist/types");

test("caps server-requested retry delays at the configured maximum", () => {
  const error = Object.assign(new Error("rate limited"), {
    retryAfterMs: 60_000,
  });

  assert.equal(calculateRetryDelay(error, 1, 100, 5_000, 2), 5_000);
  assert.equal(calculateRetryDelay(new Error("network"), 3, 100, 5_000, 2), 400);
});

test("withRetry stops immediately for a non-retryable error", async () => {
  let attempts = 0;

  await assert.rejects(
    withRetry(
      async () => {
        attempts += 1;
        throw new Error("permanent");
      },
      {
        maxRetries: 3,
        baseDelay: 1,
        maxDelay: 1,
        shouldRetry: () => false,
      }
    ),
    /permanent/
  );

  assert.equal(attempts, 1);
});

test("withBrowserRestart skips restart when retry is disallowed", async () => {
  let attempts = 0;
  let restarts = 0;

  await assert.rejects(
    withBrowserRestart(
      async () => {
        attempts += 1;
        throw new Error("authentication rejected");
      },
      async () => {
        restarts += 1;
      },
      { maxRetries: 3, shouldRetry: () => false }
    ),
    /authentication rejected/
  );

  assert.equal(attempts, 1);
  assert.equal(restarts, 0);
});

test("authentication errors are permanent while navigation errors remain retryable", () => {
  assert.equal(
    isRetryableJobKoreaError(new AuthenticationError("rejected")),
    false
  );
  assert.equal(
    isRetryableJobKoreaError(new NavigationError("temporary")),
    true
  );
  assert.equal(
    isRetryableJobKoreaError(
      new NavigationError("security boundary", undefined, false)
    ),
    false
  );
  assert.equal(isRetryableJobKoreaError(new Error("generic")), true);
});

test("workflow retry exit code is limited to safe navigation failures", () => {
  assert.equal(
    getFailureExitCode(new NavigationError("temporary")),
    RETRYABLE_NAVIGATION_EXIT_CODE
  );
  assert.equal(
    getFailureExitCode(
      new NavigationError("security boundary", undefined, false)
    ),
    1
  );
  assert.equal(getFailureExitCode(new AuthenticationError("rejected")), 1);
  assert.equal(getFailureExitCode(new Error("unexpected")), 1);
});

test("withRetry stops when the overall retry budget is exhausted", async () => {
  let attempts = 0;
  const startedAt = Date.now();

  await assert.rejects(
    withRetry(
      async () => {
        attempts += 1;
        throw new Error("temporary");
      },
      {
        maxRetries: 10,
        baseDelay: 100,
        maxDelay: 100,
        maxElapsedMs: 15,
      }
    ),
    /temporary/
  );

  assert.ok(attempts <= 2);
  assert.ok(Date.now() - startedAt < 200);
});
