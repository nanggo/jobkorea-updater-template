// src/notify.ts
import { withRetry } from "./utils/retry";
import { configManager } from "./config";
import { Logger } from "./utils/logger";

class NonRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableError";
  }
}

class RetryableError extends Error {
  retryAfterMs?: number;

  constructor(message: string, retryAfterMs?: number) {
    super(message);
    this.name = "RetryableError";
    this.retryAfterMs = retryAfterMs;
  }
}

function parseRetryAfterHeaderMs(retryAfterHeader: string | null): number | undefined {
  if (!retryAfterHeader) return undefined;

  const seconds = Number(retryAfterHeader);
  if (!Number.isNaN(seconds) && seconds > 0) {
    return seconds * 1000;
  }

  const retryAt = Date.parse(retryAfterHeader);
  if (!Number.isNaN(retryAt)) {
    const diffMs = retryAt - Date.now();
    if (diffMs > 0) {
      return diffMs;
    }
  }

  return undefined;
}

interface TelegramErrorResponse {
  description?: unknown;
  parameters?: {
    retry_after?: unknown;
  };
}

function parseTelegramErrorBody(body: string): TelegramErrorResponse | undefined {
  try {
    const value = JSON.parse(body) as unknown;
    return typeof value === "object" && value !== null
      ? (value as TelegramErrorResponse)
      : undefined;
  } catch {
    return undefined;
  }
}

export function parseTelegramRetryAfterMs(
  body: string,
  retryAfterHeader: string | null
): number | undefined {
  const payload = parseTelegramErrorBody(body);
  const seconds = payload?.parameters?.retry_after;

  if (typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0) {
    return seconds * 1000;
  }

  return parseRetryAfterHeaderMs(retryAfterHeader);
}

export function canHonorTelegramRetryAfter(
  retryAfterMs: number,
  maxDelayMs: number,
  remainingMs: number
): boolean {
  return retryAfterMs <= maxDelayMs && retryAfterMs < remainingMs;
}

export async function sendTelegramMessage(
  token: string,
  chatId: string,
  message: string,
  parseMode: string = "HTML"
): Promise<void> {
  const retryConfig = configManager.getRetryConfig();
  const timeoutConfig = configManager.getTimeouts();
  const timeoutMs = timeoutConfig.telegram;
  const overallTimeoutMs = timeoutConfig.telegramOverall;
  const deadline = Date.now() + overallTimeoutMs;

  await withRetry(
    async () => {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new NonRetryableError("Telegram 알림 전체 제한 시간 초과");
      }

      const response = await fetch(
        `https://api.telegram.org/bot${token}/sendMessage`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            chat_id: chatId,
            text: message,
            parse_mode: parseMode,
          }),
          signal: AbortSignal.timeout(Math.max(1, Math.min(timeoutMs, remainingMs))),
        }
      );

      if (!response.ok) {
        const errorBody = await response.text().catch(() => "Unknown error");
        const errorPayload = parseTelegramErrorBody(errorBody);
        const description =
          typeof errorPayload?.description === "string"
            ? errorPayload.description
            : "응답 본문을 확인할 수 없습니다.";
        const errorMessage = `Telegram API error: ${response.status} ${response.statusText} - ${description}`;

        // Telegram 429는 일시적 throttling이므로 재시도 대상이다.
        if (response.status >= 400 && response.status < 500 && response.status !== 429) {
          Logger.error(`Telegram API 영구적 오류 (재시도 안함): ${errorMessage}`);
          throw new NonRetryableError(errorMessage);
        }

        const retryAfterMs =
          response.status === 429
            ? parseTelegramRetryAfterMs(
                errorBody,
                response.headers.get("retry-after")
              )
            : undefined;
        if (
          retryAfterMs !== undefined &&
          !canHonorTelegramRetryAfter(
            retryAfterMs,
            retryConfig.maxDelay,
            deadline - Date.now()
          )
        ) {
          Logger.warning(
            `Telegram API가 요청한 ${retryAfterMs}ms 대기 시간이 허용된 재시도 예산을 초과합니다.`
          );
          throw new NonRetryableError(errorMessage);
        }
        Logger.warning(`Telegram API 임시적 오류 (재시도 예정): ${errorMessage}`);
        throw new RetryableError(errorMessage, retryAfterMs);
      }

      await response.text().catch(() => undefined);
      Logger.info("Telegram 메시지 전송 성공");
    },
    {
      maxRetries: retryConfig.maxOperationRetries,
      baseDelay: retryConfig.baseDelay,
      maxDelay: retryConfig.maxDelay,
      backoffMultiplier: retryConfig.backoffMultiplier,
      operation: "Telegram 메시지 전송",
      shouldRetry: (error) => !(error instanceof NonRetryableError),
      maxElapsedMs: overallTimeoutMs,
    }
  );
}
