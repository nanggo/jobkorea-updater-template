const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = name => fs.readFileSync(path.join(root, name), "utf8");
const examples = "examples/workflows/";

test("CI runs without account access or a self-hosted runner", () => {
  const active = fs.readdirSync(path.join(root, ".github/workflows"))
    .filter(name => /\.ya?ml$/.test(name));
  const runtimeNames = ["update_resume.yml", "update_resume_watchdog.yml", "auto_rerun_update_resume.yml"];
  // Operational copies can install these examples; check the template's CI boundary separately.
  assert.ok(active.includes("ci.yml"));
  for (const name of active.filter(name => !runtimeNames.includes(name))) {
    const source = read(`.github/workflows/${name}`);
    assert.doesNotMatch(source, /self-hosted|secrets\.|\bschedule:|\bworkflow_run:|\bpull_request_target:/);
    assert.doesNotMatch(source, /pnpm start|node dist\/index\.js/);
  }
});

test("runtime examples require explicit activation before accessing the account", () => {
  for (const [file, job] of [
    ["update_resume.yml", "probe-job"],
    ["update_resume_watchdog.yml", "check-slot"],
  ]) {
    assert.ok(read(examples + file).includes(`  ${job}:\n    if: vars.ENABLE_AUTOMATION == 'true'\n`));
  }
  assert.match(read(examples + "auto_rerun_update_resume.yml"), /if: >\n      vars\.ENABLE_AUTOMATION == 'true' &&/);
});

test("each scheduled example has an independent, least-privilege keepalive", () => {
  for (const file of ["update_resume.yml", "update_resume_watchdog.yml"]) {
    const source = read(examples + file);
    const job = source.slice(source.indexOf("\n  workflow-keepalive:\n"));
    assert.match(job, /if: github\.event_name == 'schedule' && vars\.ENABLE_AUTOMATION == 'true'/);
    assert.match(job, /runs-on: ubuntu-latest/);
    assert.match(job, /permissions:\n      actions: write/);
    assert.match(job, /liskin\/gh-workflow-keepalive@[a-f0-9]{40}/);
    assert.match(job, /continue-on-error: true/);
    assert.doesNotMatch(job, /needs:|self-hosted|checkout|secrets\.|contents: write/);
  }
});

test("the distributed environment file contains no configured credentials", () => {
  const assignments = read(".env.example").split("\n")
    .filter(line => line.trim() && !line.startsWith("#"));
  assert.deepEqual(assignments, ["JOBKOREA_ID=", "JOBKOREA_PWD=", "TELEGRAM_BOT_TOKEN=", "TELEGRAM_CHAT_ID="]);
});
