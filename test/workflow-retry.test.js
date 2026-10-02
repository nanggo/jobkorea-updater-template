const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const readWorkflow = name => fs.readFileSync(
  path.join(__dirname, "../examples/workflows", name), "utf8"
);
const mainWorkflow = readWorkflow("update_resume.yml");
const fallbackWorkflow = readWorkflow("auto_rerun_update_resume.yml");
const dispatchFunctions = [mainWorkflow, fallbackWorkflow].flatMap(source =>
  [...source.matchAll(/^( +)dispatch_retry\(\) \{\n.*?^\1\}/gms)]
    .map(match => match[0].split("\n").map(line => line.slice(match[1].length)).join("\n"))
);
assert.equal(dispatchFunctions.length, 3);

function stepScript(source, name) {
  const step = source.slice(source.indexOf(`      - name: ${name}\n`));
  const lines = step.slice(step.indexOf("        run: |\n") + "        run: |\n".length).split("\n");
  const result = [];
  for (const line of lines) {
    if (line.trim() && !line.startsWith("          ")) break;
    result.push(line.slice(10));
  }
  return result.join("\n");
}

function runShell(script, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jobkorea-retry-test-"));
  try {
    const callLog = path.join(directory, "calls");
    const output = path.join(directory, "output");
    const preamble = `
      set -euo pipefail
      timeout() { shift; "$@"; }
      sleep() { :; }
      gh() {
        printf '%s ' "$@" >> "$CALL_LOG"
        printf '\\n' >> "$CALL_LOG"
        case "$1 $2" in
          'run view')
            if [[ "$*" == *jobs,displayTitle* ]]; then
              printf '%s' "$RUN_METADATA"
            else
              printf '%s' "$CHAIN_CREATED_AT"
              return "$CREATED_EXIT_CODE"
            fi ;;
          'api --paginate')
            if [ "$LOOKUP_EXIT_CODE" != 0 ]; then return "$LOOKUP_EXIT_CODE"; fi
            if [ -f "$DISPATCH_MARKER" ]; then
              printf '%s' "$API_PAGES_AFTER_DISPATCH"
            else
              printf '%s' "$API_PAGES"
            fi ;;
          'workflow run')
            touch "$DISPATCH_MARKER"
            return "$DISPATCH_EXIT_CODE" ;;
          *) echo 'Unexpected mock gh command' >&2; return 90 ;;
        esac
      }
    `;
    const result = spawnSync("bash", ["-c", preamble + script], {
      encoding: "utf8", timeout: 5000,
      env: {
        PATH: process.env.PATH,
        CHAIN_ID: "123", NEXT_ATTEMPT: "2", RETRY_REF: "main", GH_REPO: "synthetic/repo",
        RUN_ID: "456", RUN_METADATA: "{}",
        CHAIN_CREATED_AT: "2026-09-07T00:00:00Z", CREATED_EXIT_CODE: "0",
        API_PAGES: '[{"workflow_runs":[]}]', API_PAGES_AFTER_DISPATCH: '[{"workflow_runs":[]}]',
        LOOKUP_EXIT_CODE: "0", DISPATCH_EXIT_CODE: "0",
        CALL_LOG: callLog, GITHUB_OUTPUT: output,
        DISPATCH_MARKER: path.join(directory, "dispatched"),
        ...overrides,
      },
    });
    assert.ifError(result.error);
    return {
      ...result,
      calls: fs.existsSync(callLog) ? fs.readFileSync(callLog, "utf8") : "",
      outputs: fs.existsSync(output) ? fs.readFileSync(output, "utf8") : "",
    };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

const pages = (chain = "123", attempt = 2, status = "completed", conclusion = "success") =>
  JSON.stringify([{ workflow_runs: [{ display_title: `Update Resume (attempt ${attempt}, chain ${chain})`, status, conclusion }] }]);
const dispatchCount = result => (result.calls.match(/^workflow run /gm) || []).length;

for (const [index, body] of dispatchFunctions.entries()) {
  const script = body + "\ndispatch_retry\n";
  test(`dispatch path ${index + 1}: recognizes queued and completed runs in the same chain`, () => {
    for (const [status, conclusion] of [["queued", null], ["completed", "success"], ["completed", "failure"]]) {
      const result = runShell(script, { API_PAGES: pages("123", 2, status, conclusion) });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(dispatchCount(result), 0);
    }
  });

  test(`dispatch path ${index + 1}: isolates other chains and attempts and forwards identity`, () => {
    for (const fixture of [pages("999"), pages("123", 3)]) {
      const result = runShell(script, { API_PAGES: fixture });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(dispatchCount(result), 1);
      assert.match(result.calls, /-f attempt=2 -f chain_id=123/);
      assert.match(result.calls, /--paginate --slurp --method GET/);
      assert.match(result.calls, /-f created=>=2026-09-07T00:00:00Z/);
    }
  });

  test(`dispatch path ${index + 1}: finds a completed retry on a later API page`, () => {
    const result = runShell(script, { API_PAGES: JSON.stringify([
      { workflow_runs: [] }, ...JSON.parse(pages()),
    ]) });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(dispatchCount(result), 0);
  });

  test(`dispatch path ${index + 1}: an accepted but errored dispatch is not repeated after completion`, () => {
    const result = runShell(script, { DISPATCH_EXIT_CODE: "1", API_PAGES_AFTER_DISPATCH: pages() });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(dispatchCount(result), 1);
  });

  test(`dispatch path ${index + 1}: unverifiable state never dispatches`, () => {
    for (const overrides of [
      { LOOKUP_EXIT_CODE: "1" }, { CREATED_EXIT_CODE: "1" },
      { CHAIN_CREATED_AT: "invalid" }, { CHAIN_ID: "invalid" },
      { API_PAGES: "invalid json" }, { API_PAGES: '[{"message":"error"}]' },
      { NEXT_ATTEMPT: "5" },
    ]) {
      const result = runShell(script, overrides);
      assert.notEqual(result.status, 0);
      assert.equal(dispatchCount(result), 0);
    }
  });
}

const recoveryScript = stepScript(fallbackWorkflow, "Check retry dispatch failure");
const metadata = (title, job = "retry-update-resume-2", step = "Dispatch retry after update failure") => JSON.stringify({
  displayTitle: title,
  jobs: [{ name: job, steps: [{ name: step, conclusion: "failure" }] }],
});

test("fallback carries the original chain through later attempts", () => {
  const result = runShell(recoveryScript, { RUN_METADATA: metadata("Update Resume (attempt 2, chain 123)") });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.outputs, /chain_id=123/);
  assert.match(result.outputs, /source_attempt=2/);
  assert.match(result.outputs, /should_dispatch=true/);
});

test("fallback refuses a recoverable legacy run without an identifiable chain", () => {
  const result = runShell(recoveryScript, { RUN_METADATA: metadata("Update Resume (attempt 2)") });
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.outputs, /should_dispatch=true/);
});

test("fallback recovers a failed probe retry dispatch from a scheduled run", () => {
  const result = runShell(recoveryScript, {
    RUN_METADATA: metadata("Update Resume (attempt 1, chain 123, schedule 50 23 * * *)", "probe-failure-1", "Notify JobKorea probe failure"),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.outputs, /chain_id=123/);
  assert.match(result.outputs, /source_attempt=1/);
  assert.match(result.outputs, /should_dispatch=true/);
});

test("fallback skips terminal and unrelated failures", () => {
  for (const [job, step] of [
    ["retry-update-resume-4", "Dispatch retry after update failure"],
    ["probe-failure-4", "Notify JobKorea probe failure"],
    ["update-resume-probe-2", "Probe JobKorea login endpoint"],
    ["update-resume", "Run update script"],
  ]) {
    const result = runShell(recoveryScript, { RUN_METADATA: metadata("Update Resume (attempt 4, chain 123)", job, step) });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.outputs, /should_dispatch=false/);
  }
});

test("self-hosted jobs receive no dispatch token and need no sudo", () => {
  const jobs = mainWorkflow.slice(mainWorkflow.indexOf("\njobs:\n"))
    .split(/\n(?=  \S)/)
    .filter(chunk => /^  [a-z-]+:\n/.test(chunk));
  const selfHosted = jobs.filter(job => job.includes("runs-on: [self-hosted, jobkorea]"));
  assert.deepEqual(selfHosted.map(job => job.match(/^  ([a-z-]+):/)[1]), ["probe-job", "update-resume"]);
  for (const job of selfHosted) {
    assert.doesNotMatch(job, /actions: write|GH_TOKEN|--with-deps|install-deps/);
  }

  // Set up the project's Node version before installing pnpm.
  const update = selfHosted.find(job => job.startsWith("  update-resume:"));
  assert.ok(update.indexOf("uses: actions/setup-node@") < update.indexOf("uses: pnpm/action-setup@"));
  assert.match(update, /package-manager-cache: false/);
  assert.doesNotMatch(update, /cache: "pnpm"/);
});

const watchdogScript = stepScript(readWorkflow("update_resume_watchdog.yml"), "Check scheduled update outcome");
const epoch = iso => String(Date.parse(iso) / 1000);
const MORNING = "50 23 * * *";
const AFTERNOON = "50 3 * * *";
const run = (id, event, createdAt, { chain = id, attempt = 1, cron = MORNING, status = "completed", conclusion = "success" } = {}) => ({
  id, event, created_at: createdAt, status, conclusion,
  display_title: `Update Resume (attempt ${attempt}, chain ${chain}${event === "schedule" ? `, schedule ${cron}` : ""})`,
});

function runWatchdog(runs, overrides = {}) {
  const mocks = `
    date() { printf '%s\\n' "$NOW_EPOCH"; }
    curl() { printf 'curl %s\\n' "$*" >> "$CALL_LOG"; return "$CURL_EXIT_CODE"; }
  `;
  const result = runShell(mocks + watchdogScript, {
    TRIGGER_SCHEDULE: "50 7 * * *", INPUT_SLOT: "", NOW_EPOCH: epoch("2026-09-27T07:50:00Z"),
    API_PAGES: JSON.stringify([{ workflow_runs: runs }]), CURL_EXIT_CODE: "0",
    TELEGRAM_BOT_TOKEN: "synthetic-token", TELEGRAM_CHAT_ID: "1", RUNS_URL: "https://example.test/runs",
    ...overrides,
  });
  return { ...result, alerts: (result.calls.match(/^curl .*sendMessage/gm) || []).length };
}

test("watchdog stays quiet when the slot's retry chain succeeded", () => {
  const result = runWatchdog([
    run(10, "schedule", "2026-09-27T01:50:00Z", { conclusion: "failure" }),
    run(11, "workflow_dispatch", "2026-09-27T01:56:00Z", { chain: 10, attempt: 2 }),
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.alerts, 0);
  assert.match(result.calls, /-f created=>=2026-09-26T23:50:00Z/);
});

test("watchdog alerts once when the slot has no scheduled run", () => {
  const result = runWatchdog([
    run(20, "workflow_dispatch", "2026-09-27T01:00:00Z"),
    run(21, "schedule", "2026-09-27T04:10:00Z", { cron: AFTERNOON }),
    run(22, "schedule", "2026-09-26T02:00:00Z"),
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.alerts, 1);
  assert.match(result.calls, /2026-09-27 08:50 KST/);
  assert.match(result.calls, /시작되지 않았습니다/);
});

test("watchdog keeps a late scheduled run in its own slot", () => {
  const runs = [
    run(40, "schedule", "2026-09-27T04:10:00Z", { conclusion: "failure" }),
    run(41, "schedule", "2026-09-27T04:30:00Z", { cron: AFTERNOON }),
  ];
  const morning = runWatchdog(runs);
  assert.equal(morning.status, 0, morning.stderr);
  assert.equal(morning.alerts, 1);
  assert.match(morning.calls, /성공 없이 끝났습니다/);

  const afternoon = runWatchdog(runs, { TRIGGER_SCHEDULE: "50 11 * * *", NOW_EPOCH: epoch("2026-09-27T11:50:00Z") });
  assert.equal(afternoon.status, 0, afternoon.stderr);
  assert.equal(afternoon.alerts, 0);
});

test("watchdog slots match the update schedule and its run names", () => {
  const updateCrons = [...mainWorkflow.matchAll(/- cron: "([^"]+)"/g)].map(match => match[1]);
  const slotCrons = [...watchdogScript.matchAll(/SLOT_CRON="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(slotCrons.sort(), updateCrons.sort());
  assert.match(mainWorkflow, /^run-name: .*format\(', schedule \{0\}', github\.event\.schedule\)/m);
});

test("watchdog reports unfinished and unsuccessful chains", () => {
  for (const [status, conclusion, reason] of [
    ["queued", null, /자체 runner가 오프라인/],
    ["completed", "failure", /성공 없이 끝났습니다/],
  ]) {
    const result = runWatchdog([
      run(10, "schedule", "2026-09-27T01:50:00Z", { conclusion: "failure" }),
      run(11, "workflow_dispatch", "2026-09-27T01:56:00Z", { chain: 10, attempt: 2, status, conclusion }),
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.alerts, 1);
    assert.match(result.calls, reason);
  }
});

test("watchdog maps the afternoon schedule and manual input to the same slot", () => {
  for (const overrides of [{}, { TRIGGER_SCHEDULE: "", INPUT_SLOT: "afternoon" }]) {
    const result = runWatchdog([run(30, "schedule", "2026-09-27T09:00:00Z", { cron: AFTERNOON })], {
      TRIGGER_SCHEDULE: "50 11 * * *", NOW_EPOCH: epoch("2026-09-27T11:50:00Z"), ...overrides,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.alerts, 0);
    assert.match(result.calls, /-f created=>=2026-09-27T03:50:00Z/);
  }
});

test("watchdog fails visibly when it cannot check or alert", () => {
  for (const overrides of [
    { LOOKUP_EXIT_CODE: "1" }, { API_PAGES: "invalid json" }, { API_PAGES: '[{"message":"error"}]' },
    { TRIGGER_SCHEDULE: "0 0 * * *" }, { TRIGGER_SCHEDULE: "", INPUT_SLOT: "" },
  ]) {
    const result = runWatchdog([], overrides);
    assert.notEqual(result.status, 0);
    assert.equal(result.alerts, 0);
  }
  const unsent = runWatchdog([], { CURL_EXIT_CODE: "1" });
  assert.notEqual(unsent.status, 0);
});
