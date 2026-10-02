const test = require("node:test");
const assert = require("node:assert/strict");

process.env.LOG_LEVEL = "error";

const { BrowserService } = require("../dist/services/browser");

test("continues closing context and browser when page.close fails", async () => {
  const service = new BrowserService();
  let contextCloses = 0;
  let browserCloses = 0;

  service.page = {
    close: async () => {
      throw new Error("page close failed");
    },
  };
  service.context = {
    close: async () => {
      contextCloses += 1;
    },
  };
  service.browser = {
    close: async () => {
      browserCloses += 1;
    },
  };

  const originalError = console.error;
  console.error = () => undefined;
  try {
    await service.close();
  } finally {
    console.error = originalError;
  }

  assert.equal(contextCloses, 1);
  assert.equal(browserCloses, 1);
  assert.equal(service.page, null);
  assert.equal(service.context, null);
  assert.equal(service.browser, null);
});

test("concurrent close callers wait for the same cleanup", async () => {
  const service = new BrowserService();
  let releasePageClose;
  const pageCloseGate = new Promise(resolve => {
    releasePageClose = resolve;
  });
  let browserCloses = 0;

  service.page = { close: async () => pageCloseGate };
  service.context = { close: async () => undefined };
  service.browser = {
    close: async () => {
      browserCloses += 1;
    },
  };

  const firstClose = service.close();
  let secondResolved = false;
  const secondClose = service.close().then(() => {
    secondResolved = true;
  });

  await new Promise(resolve => setImmediate(resolve));
  assert.equal(secondResolved, false);

  releasePageClose();
  await Promise.all([firstClose, secondClose]);

  assert.equal(browserCloses, 1);
  assert.equal(secondResolved, true);
});
