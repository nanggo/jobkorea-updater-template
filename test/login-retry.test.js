const test = require("node:test");
const assert = require("node:assert/strict");

process.env.LOG_LEVEL = "error";
process.env.ELEMENT_TIMEOUT_MS = "20";
process.env.NAVIGATION_TIMEOUT_MS = "20";
process.env.MAX_OPERATION_RETRIES = "2";
process.env.RETRY_BASE_DELAY_MS = "1";
process.env.RETRY_MAX_DELAY_MS = "1";

const { JobKoreaService } = require("../dist/services/jobkorea");
const { AuthenticationError, NavigationError } = require("../dist/types");
const {
  isCredentialEgressGuardArmed,
  recordBlockedTopLevelNavigation,
} = require("../dist/utils/trustedNavigation");

function locatorCollection(items) {
  return {
    async count() {
      return items.length;
    },
    nth(index) {
      return items[index];
    },
    first() {
      return items[0];
    },
  };
}

function createLoginForm({
  action = "https://www.jobkorea.co.kr/Login/Login_Tot.asp",
  method = "post",
  target = "",
  buttonFormAction,
  buttonFormMethod,
  buttonFormTarget,
  ownerMismatch = false,
  detachedControlFailures = 0,
  onFill = () => undefined,
  onTrial = () => undefined,
  onClick = () => undefined,
} = {}) {
  let remainingDetachedControlFailures = detachedControlFailures;
  const formElement = { action, method, target };
  const differentForm = { action, method, target };
  const createControl = (element, behavior) => ({
    async isEnabled() {
      return true;
    },
    async evaluate(callback, argument) {
      if (
        argument &&
        element === idElement &&
        remainingDetachedControlFailures > 0
      ) {
        remainingDetachedControlFailures -= 1;
        throw new Error("control detached during evaluation");
      }
      return callback(element, argument?.element ?? argument);
    },
    ...behavior,
  });
  const idElement = {
    form: ownerMismatch ? differentForm : formElement,
    type: "text",
  };
  const passwordElement = { form: formElement, type: "password" };
  const buttonAttributes = new Set();
  if (buttonFormAction !== undefined) buttonAttributes.add("formaction");
  if (buttonFormMethod !== undefined) buttonAttributes.add("formmethod");
  if (buttonFormTarget !== undefined) buttonAttributes.add("formtarget");
  const loginButtonElement = {
    form: formElement,
    formAction: buttonFormAction ?? action,
    formMethod: buttonFormMethod ?? method,
    formTarget: buttonFormTarget ?? target,
    hasAttribute(name) {
      return buttonAttributes.has(name);
    },
  };
  const idInput = createControl(idElement, {
    async fill(value) {
      onFill("id", value);
    },
  });
  const passwordInput = createControl(passwordElement, {
    async fill(value) {
      onFill("password", value);
    },
  });
  const loginButton = createControl(loginButtonElement, {
    async click(options) {
      if (options?.trial) {
        onTrial();
      } else {
        onClick();
      }
    },
  });

  return {
    async evaluate(callback, argument) {
      return callback(formElement, argument?.element ?? argument);
    },
    async evaluateHandle(callback) {
      return {
        element: callback(formElement),
        async dispose() {},
      };
    },
    locator(selector) {
      if (selector.includes("input-id")) return locatorCollection([idInput]);
      if (selector.includes("input-password")) {
        return locatorCollection([passwordInput]);
      }
      if (selector.includes("login-button")) {
        return locatorCollection([loginButton]);
      }
      return locatorCollection([]);
    },
  };
}

function createPage(form, overrides = {}) {
  const browserContext = {};
  const dialogListeners = new Set();
  return {
    context: () => browserContext,
    url: () => "https://www.jobkorea.co.kr/Login/Login_Tot.asp",
    locator: selector =>
      selector === "form:visible"
        ? locatorCollection([form])
        : locatorCollection([]),
    waitForEvent: async () => null,
    waitForURL: async () => undefined,
    waitForTimeout: async () => undefined,
    on(event, listener) {
      if (event === "dialog") dialogListeners.add(listener);
    },
    off(event, listener) {
      if (event === "dialog") dialogListeners.delete(listener);
    },
    // Without a listener the dialog is dropped, like Playwright's auto-dismiss.
    emitDialog(message, onDismiss = () => undefined) {
      for (const listener of dialogListeners) {
        listener({ message: () => message, dismiss: async () => onDismiss() });
      }
    },
    dialogListenerCount: () => dialogListeners.size,
    ...overrides,
  };
}

test("submits credentials once and registers popup/navigation waits before click", async () => {
  const sequence = [];
  const fills = [];
  let clickCount = 0;
  const form = createLoginForm({
    onFill: (field, value) => fills.push([field, value]),
    onClick: () => {
      sequence.push("click");
      clickCount += 1;
    },
  });
  const page = createPage(form, {
    waitForEvent: async () => {
      sequence.push("popup-wait");
      throw new Error("no popup");
    },
    waitForURL: async predicate => {
      sequence.push("navigation-wait");
      assert.equal(
        predicate(new URL("https://www.jobkorea.co.kr/Login")),
        false
      );
      throw new Error("login result unavailable");
    },
  });

  const service = new JobKoreaService(page);

  await assert.rejects(
    service.login("user-id", "wrong-password"),
    error => error instanceof AuthenticationError && error.retryable === false
  );

  assert.deepEqual(fills, [
    ["id", "user-id"],
    ["password", "wrong-password"],
  ]);
  assert.equal(clickCount, 1);
  assert.ok(sequence.indexOf("popup-wait") < sequence.indexOf("click"));
  assert.ok(sequence.indexOf("navigation-wait") < sequence.indexOf("click"));
  assert.equal(isCredentialEgressGuardArmed(page.context()), true);
});

test("does not fill credentials after a cross-origin navigation race", async () => {
  let urlChecks = 0;
  let fills = 0;
  let clicks = 0;
  const form = createLoginForm({
    onFill: () => {
      fills += 1;
    },
    onClick: () => {
      clicks += 1;
    },
  });
  const page = createPage(form, {
    url: () => {
      urlChecks += 1;
      return urlChecks < 2
        ? "https://www.jobkorea.co.kr/Login/Login_Tot.asp"
        : "https://attacker.example/login";
    },
  });

  const service = new JobKoreaService(page);

  await assert.rejects(
    service.login("user-id", "password"),
    error => error instanceof AuthenticationError && error.retryable === false
  );

  assert.equal(fills, 0);
  assert.equal(clicks, 0);
});

test("a delayed blocked-navigation event stops credential preparation", async () => {
  const fills = [];
  let clicks = 0;
  let page;
  const form = createLoginForm({
    onFill: field => {
      fills.push(field);
      if (field === "id") {
        recordBlockedTopLevelNavigation(
          page,
          "https://attacker.example/delayed-redirect"
        );
      }
    },
    onClick: () => {
      clicks += 1;
    },
  });
  page = createPage(form);
  const service = new JobKoreaService(page);

  await assert.rejects(
    service.login("user-id", "password"),
    error => error instanceof AuthenticationError && error.retryable === false
  );

  assert.deepEqual(fills, ["id"]);
  assert.equal(clicks, 0);
  assert.equal(isCredentialEgressGuardArmed(page.context()), true);
});

test("never mixes credential fields and submit buttons across forms", async () => {
  let decoyFills = 0;
  let validFills = 0;
  let validClicks = 0;
  const decoyForm = {
    async getAttribute() {
      return "/search";
    },
    locator(selector) {
      if (selector.includes("input-id")) {
        return locatorCollection([
          {
            async isEnabled() {
              return true;
            },
            async fill() {
              decoyFills += 1;
            },
          },
        ]);
      }
      return locatorCollection([]);
    },
  };
  const validForm = createLoginForm({
    onFill: () => {
      validFills += 1;
    },
    onClick: () => {
      validClicks += 1;
    },
  });
  const page = createPage(validForm, {
    locator: selector =>
      selector === "form:visible"
        ? locatorCollection([decoyForm, validForm])
        : locatorCollection([]),
  });

  const service = new JobKoreaService(page);
  await service.login("user-id", "password");

  assert.equal(decoyFills, 0);
  assert.equal(validFills, 2);
  assert.equal(validClicks, 1);
  assert.equal(isCredentialEgressGuardArmed(page.context()), false);
});

test("rejects a login form that submits outside the trusted login path", async () => {
  let fills = 0;
  let clicks = 0;
  const form = createLoginForm({
    action: "https://attacker.example/collect",
    onFill: () => {
      fills += 1;
    },
    onClick: () => {
      clicks += 1;
    },
  });
  const service = new JobKoreaService(createPage(form));

  await assert.rejects(
    service.login("user-id", "password"),
    error => error instanceof AuthenticationError && error.retryable === false
  );

  assert.equal(fills, 0);
  assert.equal(clicks, 0);
});

test("rejects submitter action, method, target, and form-owner overrides", async () => {
  const unsafeForms = [
    createLoginForm({
      buttonFormAction: "https://attacker.example/collect",
      buttonFormTarget: "credential-frame",
    }),
    createLoginForm({ buttonFormMethod: "get" }),
    createLoginForm({ buttonFormTarget: "_blank" }),
    createLoginForm({ ownerMismatch: true }),
  ];

  for (const form of unsafeForms) {
    const service = new JobKoreaService(createPage(form));
    await assert.rejects(
      service.login("user-id", "password"),
      error => error instanceof AuthenticationError && error.retryable === false
    );
  }
});

test("keeps pre-submit readiness failures retryable", async () => {
  const serviceWithoutForm = new JobKoreaService(
    createPage(null, {
      locator: () => locatorCollection([]),
    })
  );
  await assert.rejects(
    serviceWithoutForm.login("user-id", "password"),
    error => error instanceof NavigationError && error.retryable === true
  );

  const serviceWithTrialFailure = new JobKoreaService(
    createPage(
      createLoginForm({
        onTrial: () => {
          throw new Error("button detached before submit");
        },
      })
    )
  );
  await assert.rejects(
    serviceWithTrialFailure.login("user-id", "password"),
    error => error instanceof NavigationError && error.retryable === true
  );

  const serviceWithDetachedControl = new JobKoreaService(
    createPage(
      createLoginForm({ detachedControlFailures: Number.POSITIVE_INFINITY })
    )
  );
  await assert.rejects(
    serviceWithDetachedControl.login("user-id", "password"),
    error => error instanceof NavigationError && error.retryable === true
  );
});

test("recovers from a transient ownership detach without duplicate submit", async () => {
  const fills = [];
  let clickCount = 0;
  const form = createLoginForm({
    detachedControlFailures: 1,
    onFill: field => fills.push(field),
    onClick: () => {
      clickCount += 1;
    },
  });
  const service = new JobKoreaService(createPage(form));

  await service.login("user-id", "password");

  assert.deepEqual(fills, ["id", "password"]);
  assert.equal(clickCount, 1);
});

// JobKorea answers a login that must change its password with an alert on
// Login.asp and then redirects to /Login/Search/Search_Pwd.asp.
const passwordChangeNotice =
  "고객님의 개인정보를 안전하게 보호하기 위한 비밀번호 변경을 실시하고 있습니다.\n\n번거로우시겠지만 비밀번호를 변경 후 서비스를 이용해주세요.";

test("stops at the account recovery redirect and reports JobKorea's notice", async () => {
  let currentUrl = "https://www.jobkorea.co.kr/Login/Login_Tot.asp";
  let clickCount = 0;
  let dismissed = 0;
  let page;
  const form = createLoginForm({
    onClick: () => {
      clickCount += 1;
      page.emitDialog(passwordChangeNotice, () => {
        dismissed += 1;
      });
      currentUrl = "https://www.jobkorea.co.kr/Login/Search/Search_Pwd.asp";
    },
  });
  page = createPage(form, {
    url: () => currentUrl,
    waitForURL: async predicate => {
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(predicate(new URL(currentUrl)), true);
    },
  });

  await assert.rejects(
    new JobKoreaService(page).login("user-id", "password"),
    error =>
      error instanceof AuthenticationError &&
      error.retryable === false &&
      error.message.includes("계정 찾기 페이지") &&
      error.message.includes(
        "JobKorea 안내: 고객님의 개인정보를 안전하게 보호하기 위한 비밀번호 변경을 실시하고 있습니다. 번거로우시겠지만"
      )
  );
  assert.equal(clickCount, 1);
  assert.equal(dismissed, 1);
  assert.equal(page.dialogListenerCount(), 0);
});

test("adds a login alert to the failure when the login page stays", async () => {
  let page;
  const form = createLoginForm({
    onClick: () => page.emitDialog("아이디 또는 비밀번호를 다시 확인해주세요."),
  });
  page = createPage(form, {
    waitForURL: async () => {
      await new Promise(resolve => setImmediate(resolve));
      throw new Error("Timeout 20ms exceeded.");
    },
  });

  await assert.rejects(
    new JobKoreaService(page).login("user-id", "password"),
    error =>
      error instanceof AuthenticationError &&
      error.message ===
        "로그인 실패: Timeout 20ms exceeded. (JobKorea 안내: 아이디 또는 비밀번호를 다시 확인해주세요.)"
  );
  assert.equal(page.dialogListenerCount(), 0);
});
