const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { BrowserService } = require("../dist/services/browser");
const { JobKoreaService } = require("../dist/services/jobkorea");
const { TwoFactorAuthenticationError } = require("../dist/types");
const { authenticate } = require("../dist/services/authentication");

async function availablePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

exports.verifyBrowserAuthFlow = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "jobkorea-browser-auth-"));
  const options = { authStateDirectory: path.join(root, "auth"), accountId: "synthetic-account", headless: true };
  let browser;
  let loginSubmits = 0;
  let verifySubmits = 0;
  let loginNavigation = 0;
  const initialize = BrowserService.prototype.initialize;
  // The repository's real browser and auth helper run against local HTTP fixtures.
  const wireFixtures = async instance => {
    await instance.getPage().context().route("**/*", async route => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      const headers = { "content-type": "text/html; charset=utf-8" };
      if (pathname.startsWith("/Login")) loginNavigation++;
      if (pathname === "/Login/" || pathname === "/Login/Login_Tot.asp") {
        return route.fulfill({ headers, body: '<form method="post" action="/Login/Login.asp"><input class="input-id"><input class="input-password" type="password"><button class="login-button">Login</button></form>' });
      }
      if (pathname === "/Login/Login.asp") {
        loginSubmits++;
        // Playwright routing handles only the first URL of an HTTP redirect
        // chain. Script navigation keeps every request inside the fixture.
        return route.fulfill({ headers, body: '<script>location.replace("/user/TwoFactorAuth/Index")</script>' });
      }
      if (pathname === "/user/TwoFactorAuth/Index") {
        return route.fulfill({ headers, body: '<p>2단계 인증 확인</p><form method="post" action="/user/TwoFactorAuth/Verify"><label>인증번호<input name="code"></label><button>인증</button></form>' });
      }
      if (pathname === "/user/TwoFactorAuth/Verify") {
        assert.equal(request.postData(), "code=123456");
        verifySubmits++;
        return route.fulfill({ headers: { ...headers, "set-cookie": "session=synthetic-authenticated; Path=/; Secure; HttpOnly; SameSite=Lax" }, body: '<div role="dialog" aria-label="2단계 인증 완료"><p>2단계 인증이 완료되었습니다.</p><button onclick="location.replace(\'/User/Mypage\')">확인</button></div>' });
      }
      if (pathname === "/User/Mypage") {
        const authenticated = (await request.allHeaders()).cookie?.includes("session=synthetic-authenticated");
        return authenticated
          ? route.fulfill({ headers, body: '<div class="status"><a href="/User/Resume/View">Resume</a></div><script>localStorage.setItem("device", "synthetic-remembered")</script>' })
          : route.fulfill({ headers, body: '<script>location.replace("/")</script>' });
      }
      if (pathname === "/") return route.fulfill({ headers, body: "Sign in" });
      if (pathname.includes("Resume")) assert.fail("Authentication must never open or update a resume");
      return route.abort();
    });
  };
  try {
    // Scheduled execution must stop at 2FA, with no saved half-authenticated state.
    browser = new BrowserService(options);
    await browser.initialize();
    await wireFixtures(browser);
    const service = new JobKoreaService(browser.getPage());
    await service.navigateToLoginPage();
    let loginError;
    try {
      await service.login("synthetic-account", "synthetic-password");
    } catch (error) {
      loginError = error;
    }
    assert.ok(loginError instanceof TwoFactorAuthenticationError, `Expected 2FA error; URL=${browser.getPage().url()}, submits=${loginSubmits}, error=${loginError?.message}`);
    assert.equal(loginSubmits, 1);
    await assert.rejects(fs.access(path.join(options.authStateDirectory, "state.json")));
    await browser.close();

    // Simulate a human entering an OTP into the browser, then let the helper
    // save state and verify it in a separate Chromium process.
    const port = await availablePort();
    const actors = [];
    let actorError;
    let initialized = 0;
    BrowserService.prototype.initialize = async function () {
      await initialize.call(this);
      initialized++;
      await wireFixtures(this);
      if (!this.hasStoredAuthState()) {
        const page = this.getPage();
        actors.push((async () => {
          await page.waitForURL("**/user/TwoFactorAuth/Index");
          const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
          assert.ok(targets.some(target => target.url.endsWith("/user/TwoFactorAuth/Index")), "The SSH-forwarded debugger can inspect the auth page");
          // Let the helper detect the challenge before the synthetic human acts.
          await new Promise(resolve => setTimeout(resolve, 100));
          await page.getByLabel("인증번호").fill("123456");
          await page.getByRole("button", { name: "인증", exact: true }).click();
        })().catch(async error => { actorError = error; await page.close(); }));
      }
    };
    await authenticate({ directory: options.authStateDirectory, accountId: "synthetic-account", password: "synthetic-password", headless: true, debugPort: port, checkOnly: false });
    await Promise.all(actors);
    if (actorError) throw actorError;
    BrowserService.prototype.initialize = initialize;
    assert.equal(initialized, 2, "Setup must verify in a fresh Chromium process");
    assert.equal(loginSubmits, 2, "The verification browser must not submit credentials");
    assert.equal(verifySubmits, 1);
    await assert.rejects(fetch(`http://127.0.0.1:${port}/json/list`), "Debugger closes after setup");
    console.log("Browser auth setup, loopback debugger and fresh-process verification passed");

    browser = new BrowserService(options);
    await browser.initialize();
    await wireFixtures(browser);
    assert.equal(browser.hasStoredAuthState(), true);
    const beforeNavigation = loginNavigation;
    assert.equal(await new JobKoreaService(browser.getPage()).tryRestoreSession(), true);
    assert.equal(loginNavigation, beforeNavigation, "Restoring a session must not visit Login");
    assert.equal(await browser.getPage().evaluate(() => localStorage.getItem("device")), "synthetic-remembered");
    await browser.getPage().context().clearCookies();
    assert.equal(await new JobKoreaService(browser.getPage()).tryRestoreSession(), false, "Expired sessions require login");
    console.log("Browser auth reuse and expired-session detection passed");
  } finally {
    BrowserService.prototype.initialize = initialize;
    await browser?.close();
    await fs.rm(root, { recursive: true, force: true });
  }
};
