export function allowsInteractiveAuthentication(environment: NodeJS.ProcessEnv): boolean {
  return environment.GITHUB_ACTIONS !== "true" || (
    environment.GITHUB_EVENT_NAME === "workflow_dispatch" &&
    environment.GITHUB_WORKFLOW === "Authenticate JobKorea" &&
    environment.GITHUB_REF === "refs/heads/main"
  );
}

// Load local overrides before loading the configuration module, like index.ts.
try {
  require("dotenv").config({ quiet: true });
} catch {
  // A runner may supply credentials directly through its environment.
}

async function main(): Promise<void> {
  const { authenticate }: typeof import("./services/authentication") = require("./services/authentication");
  const { Logger }: typeof import("./utils/logger") = require("./utils/logger");
  const args = process.argv.slice(2);
  if (args.some(arg => !["--check", "--headless", "--telegram", "--telegram-test"].includes(arg) && !/^--debug-port=\d+$/.test(arg))) {
    throw new Error("사용법: node dist/authenticate.js [--check | --telegram | --telegram-test] [--headless --debug-port=9222]");
  }
  const checkOnly = args.includes("--check");
  const useTelegram = args.includes("--telegram");
  const testTelegram = args.includes("--telegram-test");
  if ([checkOnly, useTelegram, testTelegram].filter(Boolean).length > 1) throw new Error("인증 모드는 하나만 선택하세요.");
  const headless = args.includes("--headless") || useTelegram;
  const portArgument = args.find(arg => arg.startsWith("--debug-port="));
  const debugPort = portArgument ? Number(portArgument.split("=")[1]) : undefined;
  if (!checkOnly && !allowsInteractiveAuthentication(process.env)) {
    throw new Error("Actions 수동 인증은 main의 Authenticate JobKorea workflow에서만 실행할 수 있습니다.");
  }
  if (!checkOnly && !useTelegram && !testTelegram && headless && debugPort === undefined) {
    throw new Error("headless 수동 인증에는 SSH로 연결할 --debug-port가 필요합니다.");
  }
  if ((useTelegram || testTelegram) && debugPort !== undefined) throw new Error("Telegram 인증 모드에서는 debugger를 열지 않습니다.");
  let telegram: import("./services/telegramAuth").TelegramAuthConfig | undefined;
  if (useTelegram || testTelegram) {
    const token = process.env.TELEGRAM_AUTH_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_AUTH_CHAT_ID || process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) throw new Error("Telegram 인증용 bot token과 개인 chat ID를 설정하세요.");
    telegram = { token, chatId };
    if (testTelegram) {
      const { testTelegramAuthChannel }: typeof import("./services/telegramAuth") = require("./services/telegramAuth");
      await testTelegramAuthChannel(telegram);
      return;
    }
  }
  const directory = process.env.JOBKOREA_AUTH_STATE_DIR;
  const accountId = process.env.JOBKOREA_ID;
  const password = process.env.JOBKOREA_PWD;
  if (!directory || !accountId || (!checkOnly && !password)) {
    throw new Error("JOBKOREA_AUTH_STATE_DIR, JOBKOREA_ID와 (최초 인증 시) JOBKOREA_PWD를 설정하세요.");
  }
  Logger.registerSensitiveValues([accountId, password ?? ""]);
  await authenticate({ directory, accountId, password, checkOnly, headless, debugPort, telegram });
}

if (require.main === module) {
  main().catch(error => {
    const { Logger }: typeof import("./utils/logger") = require("./utils/logger");
    Logger.error("인증 설정 또는 검증 실패", error instanceof Error ? error : undefined);
    process.exitCode ||= 1;
  });
}
