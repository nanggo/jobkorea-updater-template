const test = require("node:test");
const assert = require("node:assert/strict");
process.env.LOG_LEVEL = "error";
process.env.ELEMENT_TIMEOUT_MS = "20";
process.env.MAX_OPERATION_RETRIES = "2";
process.env.RETRY_BASE_DELAY_MS = "1";
const { JobKoreaService } = require("../dist/services/jobkorea");
const { twoFactorDeadline } = require("../dist/services/jobkorea");
const { TwoFactorAuthenticationError, NavigationError } = require("../dist/types");

function pageAt(url, overrides = {}) {
  const context = {};
  let navigations = 0;
  const page = {
    context: () => context,
    url: () => url,
    goto: async () => { navigations++; return { ok: () => true }; },
    waitForSelector: async () => {},
    locator: () => ({ first: () => ({ isVisible: async () => true }) }),
    getByRole: () => ({ getByRole: () => ({ waitFor: () => new Promise(() => {}) }) }),
    ...overrides,
  };
  return { page, count: () => navigations };
}

test("requires the authenticated mypage path and controls before accepting saved state", async () => {
  assert.equal(await new JobKoreaService(pageAt("https://www.jobkorea.co.kr/User/Mypage").page).tryRestoreSession(), true);
  for (const target of ["/", "/Login/", "/User/Other"]) {
    const fixture = pageAt(`https://www.jobkorea.co.kr${target}`);
    assert.equal(await new JobKoreaService(fixture.page).tryRestoreSession(), false);
    assert.equal(fixture.count(), 1);
  }
});

test("SMS deadline follows the website timer and never extends beyond three minutes from dispatch", () => {
  assert.equal(twoFactorDeadline("02:59", 100000, 105000), 280000);
  assert.equal(twoFactorDeadline("01:00", 100000, 105000), 165000);
  for (const value of ["04:00", "03:99", "00:00", "unknown"]) assert.throws(() => twoFactorDeadline(value, 100000, 105000));
});

test("an expired code never reaches a browser input or submit button", async () => {
  const service = new JobKoreaService({});
  await assert.rejects(service.submitTwoFactorCode("123456", Date.now() - 1), /다시 제출하지 않고 중단/);
});

test("a saved session reaching 2FA stops without retrying or falling back to login", async () => {
  const fixture = pageAt("https://www.jobkorea.co.kr/user/TwoFactorAuth/Index");
  await assert.rejects(new JobKoreaService(fixture.page).tryRestoreSession(), TwoFactorAuthenticationError);
  assert.equal(fixture.count(), 1);
});

test("network failures do not masquerade as an expired session", async () => {
  const fixture = pageAt("https://www.jobkorea.co.kr/User/Mypage", {
    goto: async () => { throw new NavigationError("network unavailable", undefined, false); },
  });
  await assert.rejects(new JobKoreaService(fixture.page).tryRestoreSession(), NavigationError);
});

test("manual authentication waits for a trusted mypage, never just any redirect", async () => {
  const fixture = pageAt("https://www.jobkorea.co.kr/User/Mypage", {
    waitForURL: async predicate => {
      assert.equal(predicate(new URL("https://evil.example/User/Mypage")), false);
      assert.equal(predicate(new URL("https://www.jobkorea.co.kr/user/TwoFactorAuth/Index")), false);
      assert.equal(predicate(new URL("https://www.jobkorea.co.kr/")), false);
      assert.equal(predicate(new URL("https://www.jobkorea.co.kr/User/Mypage")), true);
    },
  });
  await new JobKoreaService(fixture.page).waitForManualAuthentication(100);
  assert.equal(fixture.count(), 1);
});
