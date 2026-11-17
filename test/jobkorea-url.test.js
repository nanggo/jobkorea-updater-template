const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isJobKoreaAccountRecoveryPath,
  isJobKoreaLoginPath,
  isJobKoreaTwoFactorPath,
  isJobKoreaMypagePath,
  isTrustedJobKoreaUrl,
  isTrustedJobKoreaWebSocketUrl,
  requireTrustedJobKoreaUrl,
} = require("../dist/utils/jobkoreaUrl");

test("recognizes 2FA and mypage paths without matching similar names or query strings", () => {
  for (const pathname of ["/user/TwoFactorAuth/Index", "/User/TwoFactorAuth", "/user/twofactorauth/"]) {
    assert.equal(isJobKoreaTwoFactorPath(`https://www.jobkorea.co.kr${pathname}`), true);
  }
  for (const pathname of ["/user/TwoFactorAuthentication", "/?next=/user/TwoFactorAuth/Index", "/Login/"]) {
    assert.equal(isJobKoreaTwoFactorPath(`https://www.jobkorea.co.kr${pathname}`), false);
  }
  assert.equal(isJobKoreaMypagePath("https://www.jobkorea.co.kr/User/Mypage/"), true);
  assert.equal(isJobKoreaMypagePath("https://www.jobkorea.co.kr/User/MypageFake"), false);
});

test("allows only HTTPS JobKorea hosts on the default port", () => {
  assert.equal(isTrustedJobKoreaUrl("https://jobkorea.co.kr/Login/"), true);
  assert.equal(
    isTrustedJobKoreaUrl("https://www.jobkorea.co.kr/User/Mypage"),
    true
  );
  assert.equal(
    isTrustedJobKoreaUrl("https://accounts.jobkorea.co.kr:443/login"),
    true
  );
});

test("allows only secure JobKorea WebSocket endpoints", () => {
  assert.equal(
    isTrustedJobKoreaWebSocketUrl("wss://events.jobkorea.co.kr/socket"),
    true
  );
  assert.equal(
    isTrustedJobKoreaWebSocketUrl("ws://events.jobkorea.co.kr/socket"),
    false
  );
  assert.equal(
    isTrustedJobKoreaWebSocketUrl("wss://jobkorea.co.kr.evil.example/socket"),
    false
  );
  assert.equal(
    isTrustedJobKoreaWebSocketUrl("wss://events.jobkorea.co.kr:8443/socket"),
    false
  );
});

test("recognizes login paths with or without a trailing slash", () => {
  assert.equal(isJobKoreaLoginPath("https://www.jobkorea.co.kr/Login"), true);
  assert.equal(
    isJobKoreaLoginPath("https://www.jobkorea.co.kr/Login/Login_Tot.asp"),
    true
  );
  assert.equal(isJobKoreaLoginPath("https://www.jobkorea.co.kr/User/Mypage"), false);
});

test("recognizes only the login ID/password recovery pages", () => {
  for (const path of ["/Login/Search/Search_Pwd.asp", "/login/search/Search_Id.asp", "/Login/Search"]) {
    assert.equal(isJobKoreaAccountRecoveryPath(`https://www.jobkorea.co.kr${path}`), true, path);
  }
  for (const path of ["/Login/Login_Tot.asp", "/Login/Searching", "/User/Search/Search_Pwd.asp"]) {
    assert.equal(isJobKoreaAccountRecoveryPath(`https://www.jobkorea.co.kr${path}`), false, path);
  }
});

test("rejects lookalike, insecure, credentialed, and nonstandard-port URLs", () => {
  const rejected = [
    "http://www.jobkorea.co.kr/Login/",
    "https://jobkorea.co.kr.evil.example/Login/",
    "https://evil.example/?next=jobkorea.co.kr",
    "https://user:password@www.jobkorea.co.kr/Login/",
    "https://www.jobkorea.co.kr:8443/Login/",
    "not-a-url",
  ];

  rejected.forEach(url => assert.equal(isTrustedJobKoreaUrl(url), false, url));
  assert.throws(
    () => requireTrustedJobKoreaUrl(rejected[1], "로그인 URL"),
    /HTTPS JobKorea/
  );
});
