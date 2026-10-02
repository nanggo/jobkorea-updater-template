const test = require("node:test");
const assert = require("node:assert/strict");

process.env.LOG_LEVEL = "error";

const { JobKoreaService } = require("../dist/services/jobkorea");
const { UpdateError } = require("../dist/types");
const {
  recordBlockedTopLevelNavigation,
} = require("../dist/utils/trustedNavigation");

test("observes dialog and click failures together and closes the popup without retrying mutation", async () => {
  let updateClicks = 0;
  let popupCloses = 0;
  let popupClosed = false;
  const browserContext = {};

  const updateLocator = {
    first() {
      return this;
    },
    async isVisible() {
      return true;
    },
    async isEnabled() {
      return true;
    },
    async count() {
      return 1;
    },
    nth() {
      return this;
    },
    async click(options) {
      if (options?.trial) return;
      updateClicks += 1;
      throw new Error("update click failed");
    },
  };
  const resumePopup = {
    context: () => browserContext,
    url: () => "https://www.jobkorea.co.kr/User/Resume/View",
    waitForLoadState: async () => undefined,
    locator: () => updateLocator,
    waitForTimeout: async () => undefined,
    waitForEvent: async () => {
      throw new Error("dialog was not opened");
    },
    isClosed: () => popupClosed,
    close: async () => {
      popupClosed = true;
      popupCloses += 1;
    },
  };
  const statusLocator = {
    first() {
      return this;
    },
    async isVisible() {
      return true;
    },
  };
  const page = {
    context: () => browserContext,
    url: () => "https://www.jobkorea.co.kr/User/Mypage",
    waitForSelector: async () => undefined,
    locator: () => statusLocator,
    $: async () => null,
    waitForEvent: async event => {
      assert.equal(event, "popup");
      return resumePopup;
    },
    click: async () => undefined,
  };

  const service = new JobKoreaService(page);

  await assert.rejects(
    service.updateCareerInfo(),
    error => error instanceof UpdateError && error.retryable === false
  );

  assert.equal(updateClicks, 1);
  assert.equal(popupCloses, 1);
});

test("stops when the resume popup records a blocked navigation", async () => {
  let updateClicks = 0;
  let popupClosed = false;
  const browserContext = {};
  const resumePopup = {
    context: () => browserContext,
    url: () => "https://www.jobkorea.co.kr/User/Resume/View",
    waitForLoadState: async () => {
      recordBlockedTopLevelNavigation(
        resumePopup,
        "https://attacker.example/resume-redirect"
      );
    },
    isClosed: () => popupClosed,
    close: async () => {
      popupClosed = true;
    },
  };
  const statusLocator = {
    first() {
      return this;
    },
    async isVisible() {
      return true;
    },
  };
  const page = {
    context: () => browserContext,
    url: () => "https://www.jobkorea.co.kr/User/Mypage",
    waitForSelector: async () => undefined,
    locator: () => statusLocator,
    $: async () => null,
    waitForEvent: async () => resumePopup,
    click: async () => {
      updateClicks += 1;
    },
  };
  const service = new JobKoreaService(page);

  await assert.rejects(
    service.updateCareerInfo(),
    error => error instanceof UpdateError && error.retryable === false
  );

  assert.equal(updateClicks, 1);
  assert.equal(popupClosed, true);
});
