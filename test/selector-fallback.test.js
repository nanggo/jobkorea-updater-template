const test = require("node:test");
const assert = require("node:assert/strict");

process.env.LOG_LEVEL = "error";

const { JobKoreaService } = require("../dist/services/jobkorea");

test("selector fallback targets visible matches instead of a hidden first node", async () => {
  let waitedSelector = "";
  const page = {
    waitForSelector: async selector => {
      waitedSelector = selector;
    },
    locator: selector => ({
      first: () => ({ isVisible: async () => selector.includes(":visible") }),
    }),
  };
  const service = new JobKoreaService(page);

  const selected = await service.waitForAnySelector([".primary", ".fallback"]);

  assert.equal(selected, ".primary:visible");
  assert.equal(waitedSelector, ".primary:visible, .fallback:visible");
});

test("clickable fallback skips disabled visible matches", async () => {
  const disabled = { isEnabled: async () => false };
  const enabled = { isEnabled: async () => true };
  const page = {
    isClosed: () => false,
    locator: () => ({
      count: async () => 2,
      nth: index => (index === 0 ? disabled : enabled),
    }),
    waitForTimeout: async () => undefined,
  };
  const service = new JobKoreaService(page);

  const selected = await service.waitForClickableLocator(page, ["button"], 100);

  assert.equal(selected, enabled);
});

test("clickable fallback fails immediately when the page is closed", async () => {
  let waitCalls = 0;
  const page = {
    isClosed: () => true,
    waitForTimeout: async () => {
      waitCalls += 1;
    },
  };
  const service = new JobKoreaService(page);

  await assert.rejects(
    service.waitForClickableLocator(page, ["button"], 15000),
    /페이지가 닫혀/
  );
  assert.equal(waitCalls, 0);
});
