const test = require("node:test");
const assert = require("node:assert/strict");

process.env.LOG_LEVEL = "info";

const { Logger } = require("../dist/utils/logger");

test("masks sensitive nested context and removes URL query/hash details", () => {
  const originalLog = console.log;
  let output = "";
  console.log = value => {
    output += String(value);
  };

  try {
    Logger.registerSensitiveValues(["runtime-secret-value"]);
    Logger.info("context test", {
      password: "correct horse battery staple",
      nested: {
        auth: "Bearer secret-token",
        url: "https://www.jobkorea.co.kr/path?token=abc123#private",
        detail: "request failed for runtime-secret-value",
      },
    });
  } finally {
    console.log = originalLog;
  }

  assert.doesNotMatch(output, /correct horse battery staple/);
  assert.doesNotMatch(output, /secret-token/);
  assert.doesNotMatch(output, /runtime-secret-value/);
  assert.doesNotMatch(output, /abc123|#private/);
  assert.match(output, /https:\/\/www\.jobkorea\.co\.kr\/path/);
});

test("external redaction removes encoded secrets and untrusted URL paths", () => {
  const secret = "p@ss word";
  Logger.registerSensitiveValues([secret]);

  const redacted = Logger.redactForExternalOutput(
    `fill failed: ${secret} https://evil.example/${encodeURIComponent(secret)}?session=abc#private wss://socket.evil.example/${encodeURIComponent(secret)}`
  );

  assert.doesNotMatch(redacted, /p@ss word|p%40ss%20word|session=abc|private/);
  assert.equal(
    redacted,
    "fill failed: *** https://evil.example/ wss://socket.evil.example/"
  );
});
