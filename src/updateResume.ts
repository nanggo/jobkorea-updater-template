// src/updateResume.ts
import {
  Config,
  isRetryableJobKoreaError,
  JobKoreaError,
  NavigationError,
} from "./types";
import { Logger } from "./utils/logger";
import { BrowserService } from "./services/browser";
import { JobKoreaService } from "./services/jobkorea";
import { sendTelegramMessage } from "./notify";
import { withBrowserRestart } from "./utils/retry";
import { configManager } from "./config";

export async function updateResume(config: Config): Promise<void> {
  const browserService = new BrowserService();
  const retryConfig = configManager.getRetryConfig();
  let retryCount = 0;

  // 프로세스 종료 시그널 수신 시 브라우저 정리
  let isShuttingDown = false;
  const signalCodes: Record<string, number> = { SIGINT: 130, SIGTERM: 143 };
  const gracefulShutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    Logger.info(`${signal} 수신. 브라우저 정리 중...`);
    await browserService.close();
    process.exit(signalCodes[signal] ?? 1);
  };
  const handleSigint = () => void gracefulShutdown("SIGINT");
  const handleSigterm = () => void gracefulShutdown("SIGTERM");
  process.once("SIGINT", handleSigint);
  process.once("SIGTERM", handleSigterm);

  try {
    await withBrowserRestart(
      async () => {
        retryCount++;
        Logger.info(`이력서 업데이트 프로세스 시작 (시도 ${retryCount}/${retryConfig.maxProcessRetries})`);

        await browserService.initialize();
        const page = browserService.getPage();
        const jobKoreaService = new JobKoreaService(page);

        // 1. 로그인 페이지로 이동
        await jobKoreaService.navigateToLoginPage();

        // 2. 로그인 수행
        const loginPopup = await jobKoreaService.login(
          config.jobkoreaId,
          config.jobkoreaPwd
        );

        // 3. 로그인 후 팝업 처리
        await jobKoreaService.handleLoginPopup(loginPopup);

        // 4. 마이페이지로 이동
        await jobKoreaService.navigateToMypage();

        // 5. 경력 정보 업데이트
        await jobKoreaService.updateCareerInfo();

        Logger.success("이력서 업데이트 프로세스 완료");
      },
      async () => {
        Logger.info("브라우저 재시작 중...");
        await browserService.close();
        await new Promise(resolve => setTimeout(resolve, 1000));
      },
      {
        maxRetries: retryConfig.maxProcessRetries,
        operation: "이력서 업데이트 전체 프로세스",
        shouldRetry: isRetryableJobKoreaError,
      }
    );

    // 6. 성공 메시지 전송과 브라우저 정리를 병렬로 처리
    const results = await Promise.allSettled([
      sendSuccessNotification(config.telegramToken, config.telegramChatId, retryCount),
      browserService.close(),
    ]);

    if (results[0].status === 'rejected') {
      Logger.warning("성공 알림 전송 실패. Telegram 설정을 확인해주세요.");
    }
  } catch (error) {
    // 에러 처리와 브라우저 정리를 병렬로 처리
    const results = await Promise.allSettled([
      handleError(error, config.telegramToken, config.telegramChatId, retryCount),
      browserService.close(),
    ]);

    if (results[0].status === 'rejected') {
      Logger.warning("실패 알림 전송 실패. Telegram 설정을 확인해주세요.");
    }

    throw error instanceof Error ? error : new Error(String(error));
  } finally {
    process.off("SIGINT", handleSigint);
    process.off("SIGTERM", handleSigterm);
  }
}

async function sendSuccessNotification(
  token: string,
  chatId: string,
  retryCount: number
): Promise<void> {
  const now = new Date();
  const retryInfo = retryCount > 1 ? `\n재시도 횟수: ${retryCount - 1}번` : "";
  const message = `<blockquote>✅ 이력서 업데이트 완료!\n날짜: ${now.toLocaleDateString(
    "ko-KR",
    { timeZone: "Asia/Seoul" }
  )} 시간: ${now.toLocaleTimeString("ko-KR", {
    timeZone: "Asia/Seoul",
  })}${retryInfo}</blockquote>`;

  await sendTelegramMessage(token, chatId, message, "HTML");
  Logger.success("성공 메시지 전송 완료");
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function sanitizeNotificationErrorDetail(
  text: string,
  maxLength: number = 2800
): string {
  const suffix = "… [생략됨]";
  const redacted = Logger.redactForExternalOutput(text);
  let escaped = "";

  for (const character of redacted) {
    const escapedCharacter = escapeHtml(character);
    if (escaped.length + escapedCharacter.length + suffix.length > maxLength) {
      return `${escaped}${suffix}`;
    }
    escaped += escapedCharacter;
  }

  return escaped;
}

async function handleError(
  error: unknown,
  token: string,
  chatId: string,
  retryCount: number
): Promise<void> {
  const errorMessage = formatFailureNotification(
    error,
    retryCount,
    process.env.WORKFLOW_ATTEMPT
  );

  Logger.error("최종 에러 발생", error instanceof Error ? error : undefined);
  await sendTelegramMessage(token, chatId, errorMessage);
  Logger.info("실패 메시지 전송 완료");
}

export function formatFailureNotification(
  error: unknown,
  retryCount: number,
  workflowAttemptValue?: string
): string {
  const maxWorkflowAttempts = 4;
  const workflowAttempt = /^[1-4]$/.test(workflowAttemptValue ?? "")
    ? Number(workflowAttemptValue)
    : undefined;
  const retryInfo =
    retryCount > 1
      ? `\n재시도 횟수: ${retryCount - 1}번 (모든 재시도 실패)`
      : "";
  const rawMessage =
    error instanceof JobKoreaError
      ? error.message
      : error instanceof Error
        ? error.message
        : "알 수 없는 오류";
  const safeMessage = sanitizeNotificationErrorDetail(rawMessage);
  const retryableWorkflowFailure =
    error instanceof NavigationError &&
    error.retryable &&
    workflowAttempt !== undefined &&
    workflowAttempt < maxWorkflowAttempts;

  if (retryableWorkflowFailure) {
    return `⚠️ 이력서 업데이트 일시 실패\n이유: ${safeMessage} (${error.code})${retryInfo}\n조치: workflow ${workflowAttempt + 1}/${maxWorkflowAttempts}번째 시도를 자동 생성할 예정입니다.`;
  }

  return (
    error instanceof JobKoreaError
      ? `❌ 이력서 업데이트 최종 실패!\n이유: ${safeMessage} (${error.code})${retryInfo}`
      : `❌ 이력서 업데이트 최종 실패!\n이유: ${safeMessage}${retryInfo}`
  );
}
