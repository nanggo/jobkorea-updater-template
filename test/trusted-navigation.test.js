const test = require("node:test");
const assert = require("node:assert/strict");

process.env.LOG_LEVEL = "error";
process.env.MAX_OPERATION_RETRIES = "3";

const { JobKoreaService } = require("../dist/services/jobkorea");
const { NavigationError } = require("../dist/types");
const {
  recordBlockedContextNavigation,
  recordBlockedTopLevelNavigation,
} = require("../dist/utils/trustedNavigation");

test("a route-blocked redirect fails navigation once without retrying", async () => {
  let gotoAttempts = 0;
  const browserContext = {};
  const page = {
    context: () => browserContext,
    url: () => "https://www.jobkorea.co.kr/Login/",
    goto: async () => {
      gotoAttempts += 1;
      recordBlockedTopLevelNavigation(
        page,
        "https://attacker.example/credential-redirect"
      );
      throw new Error("page.goto: net::ERR_BLOCKED_BY_CLIENT");
    },
  };
  const service = new JobKoreaService(page);

  await assert.rejects(
    service.navigateToLoginPage(),
    error => error instanceof NavigationError && error.retryable === false
  );

  assert.equal(gotoAttempts, 1);
});

test("a blocked initial navigation without a Frame uses context fallback", async () => {
  let gotoAttempts = 0;
  const browserContext = {};
  const page = {
    context: () => browserContext,
    url: () => "about:blank",
    goto: async () => {
      gotoAttempts += 1;
      recordBlockedContextNavigation(
        browserContext,
        "https://attacker.example/initial-popup"
      );
      throw new Error("page.goto: net::ERR_BLOCKED_BY_CLIENT");
    },
  };
  const service = new JobKoreaService(page);

  await assert.rejects(
    service.navigateToLoginPage(),
    error => error instanceof NavigationError && error.retryable === false
  );

  assert.equal(gotoAttempts, 1);
});

test("a route-blocked mypage redirect also bypasses operation retries", async () => {
  let gotoAttempts = 0;
  const browserContext = {};
  const page = {
    context: () => browserContext,
    url: () => "https://www.jobkorea.co.kr/User/Mypage",
    goto: async () => {
      gotoAttempts += 1;
      recordBlockedTopLevelNavigation(
        page,
        "https://attacker.example/mypage-redirect"
      );
      throw new Error("page.goto: net::ERR_BLOCKED_BY_CLIENT");
    },
  };
  const service = new JobKoreaService(page);

  await assert.rejects(
    service.navigateToMypage(),
    error => error instanceof NavigationError && error.retryable === false
  );

  assert.equal(gotoAttempts, 1);
});
