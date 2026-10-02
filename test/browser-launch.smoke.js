process.env.BROWSER_HEADLESS = "true";
process.env.LOG_LEVEL = "error";
process.env.ELEMENT_TIMEOUT_MS = "1000";
process.env.POPUP_TIMEOUT_MS = "1000";

const { BrowserService } = require("../dist/services/browser");
const { verifyBrowserUpdateFlow } = require("./browser-update.smoke");

async function main() {
  const browserService = new BrowserService();
  try {
    await browserService.initialize();
    await verifyBrowserUpdateFlow(browserService.getPage());
  } finally {
    await browserService.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
