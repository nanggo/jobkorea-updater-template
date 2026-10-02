const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createBrowserEnvironment,
  shouldBlockRequest,
} = require("../dist/services/browser");
const {
  armCredentialEgressGuard,
  isCredentialEgressGuardArmed,
} = require("../dist/utils/trustedNavigation");

test("passes only runtime essentials to Chromium and excludes application secrets", () => {
  const environment = createBrowserEnvironment({
    PATH: "/usr/bin:/bin",
    HOME: "/home/runner",
    LANG: "ko_KR.UTF-8",
    JOBKOREA_ID: "private-id",
    JOBKOREA_PWD: "private-password",
    TELEGRAM_BOT_TOKEN: "private-token",
    TELEGRAM_CHAT_ID: "private-chat",
    GITHUB_TOKEN: "private-github-token",
    GH_TOKEN: "private-gh-token",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "private-oidc-token",
  });

  assert.deepEqual(environment, {
    PATH: "/usr/bin:/bin",
    HOME: "/home/runner",
    LANG: "ko_KR.UTF-8",
  });
});

test("blocks untrusted navigation in every frame but not subresources", () => {
  assert.equal(
    shouldBlockRequest("https://attacker.example/login", true, false),
    true
  );
  assert.equal(
    shouldBlockRequest(
      "https://www.jobkorea.co.kr/User/Mypage",
      true,
      false
    ),
    false
  );
  assert.equal(
    shouldBlockRequest("https://attacker.example/script.js", false, false),
    false
  );
  assert.equal(
    shouldBlockRequest("https://attacker.example/frame", true, false),
    true
  );
});

test("blocks every external HTTP request while credentials are present", () => {
  assert.equal(
    shouldBlockRequest("https://attacker.example/collect", false, true),
    true
  );
  assert.equal(
    shouldBlockRequest(
      "https://api.jobkorea.co.kr/Login/Authenticate",
      false,
      true
    ),
    false
  );
});

test("credential egress guard covers popups in the same browser context", () => {
  const browserContext = {};
  const mainPage = { context: () => browserContext };
  const popup = { context: () => browserContext };

  armCredentialEgressGuard(mainPage.context());

  assert.equal(isCredentialEgressGuardArmed(popup.context()), true);
  assert.equal(
    shouldBlockRequest(
      "https://attacker.example/popup-collect",
      false,
      isCredentialEgressGuardArmed(popup.context())
    ),
    true
  );
});
