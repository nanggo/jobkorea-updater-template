const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { allowsInteractiveAuthentication } = require("../dist/authenticate");

test("Actions interactive auth is limited to the manually dispatched main workflow", () => {
  const allowed = { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_WORKFLOW: "Authenticate JobKorea", GITHUB_REF: "refs/heads/main" };
  assert.equal(allowsInteractiveAuthentication({}), true);
  assert.equal(allowsInteractiveAuthentication(allowed), true);
  for (const change of [
    { GITHUB_EVENT_NAME: "schedule" },
    { GITHUB_EVENT_NAME: "pull_request" },
    { GITHUB_WORKFLOW: "Update Resume" },
    { GITHUB_REF: "refs/heads/feature" },
  ]) assert.equal(allowsInteractiveAuthentication({ ...allowed, ...change }), false);
});

test("authentication workflow has no automatic trigger, dispatch token or resume mutation", () => {
  const workflow = fs.readFileSync(path.join(__dirname, "../examples/workflows/authenticate.yml"), "utf8");
  assert.match(workflow, /^  workflow_dispatch:$/m);
  assert.doesNotMatch(workflow, /^  (schedule|push|pull_request|workflow_run):/m);
  assert.match(workflow, /group: update-resume/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /contents: read/);
  assert.doesNotMatch(workflow, /actions: write|upload-artifact|dist\/index\.js/);
  assert.match(workflow, /default: telegram/);
  assert.match(workflow, /telegram-test\) node dist\/authenticate\.js --telegram-test/);
  assert.match(workflow, /node dist\/authenticate\.js --headless --debug-port=9222/);
});
