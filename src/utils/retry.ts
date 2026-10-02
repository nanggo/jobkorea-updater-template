import { Logger } from "./logger";
import { configManager } from "../config";

export interface RetryOptions {
  maxRetries?: number;
  baseDelay?: number;
  maxDelay?: number;
  backoffMultiplier?: number;
  operation?: string;
  shouldRetry?: (error: Error, attempt: number) => boolean;
  maxElapsedMs?: number;
}

function getRetryAfterMs(error: Error): number | undefined {
  const retryAfterMs = (error as Error & { retryAfterMs?: number }).retryAfterMs;
  if (typeof retryAfterMs === "number" && retryAfterMs > 0) {
    return retryAfterMs;
  }
  return undefined;
}

export function calculateRetryDelay(
  error: Error,
  attempt: number,
  baseDelay: number,
  maxDelay: number,
  backoffMultiplier: number
): number {
  const exponentialDelay = Math.min(
    baseDelay * Math.pow(backoffMultiplier, Math.max(0, attempt - 1)),
    maxDelay
  );
  const requestedDelay = getRetryAfterMs(error) ?? exponentialDelay;

  return Math.min(Math.max(0, requestedDelay), maxDelay);
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const retryConfig = configManager.getRetryConfig();
  const {
    maxRetries = retryConfig.maxOperationRetries,
    baseDelay = retryConfig.baseDelay,
    maxDelay = retryConfig.maxDelay,
    backoffMultiplier = retryConfig.backoffMultiplier,
    operation = "작업",
    shouldRetry = () => true,
    maxElapsedMs,
  } = options;

  let lastError: Error = new Error("No attempts made");
  const deadline =
    maxElapsedMs !== undefined ? Date.now() + maxElapsedMs : undefined;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    if (deadline !== undefined && Date.now() >= deadline) {
      Logger.warning(`${operation} 전체 제한 시간 초과`);
      throw lastError;
    }

    try {
      Logger.info(`${operation} 시도 중... (${attempt}/${maxRetries})`);
      const result = await fn();

      if (attempt > 1) {
        Logger.success(`${operation} 성공! (${attempt}번째 시도에서 성공)`);
      }

      return result;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (!shouldRetry(lastError, attempt)) {
        Logger.warning(`${operation} 재시도 중단. 오류: ${lastError.message}`);
        throw lastError;
      }

      if (attempt === maxRetries) {
        Logger.error(`${operation} 최종 실패 (${maxRetries}번 시도 후)`, lastError);
        throw lastError;
      }

      const calculatedDelay = calculateRetryDelay(
        lastError,
        attempt,
        baseDelay,
        maxDelay,
        backoffMultiplier
      );
      const remainingMs =
        deadline !== undefined ? Math.max(0, deadline - Date.now()) : undefined;
      if (remainingMs !== undefined && remainingMs === 0) {
        Logger.warning(`${operation} 전체 제한 시간 초과`);
        throw lastError;
      }
      const delay =
        remainingMs !== undefined
          ? Math.min(calculatedDelay, remainingMs)
          : calculatedDelay;
      Logger.warning(
        `${operation} 실패 (${attempt}/${maxRetries}). ${delay}ms 후 재시도... 오류: ${lastError.message}`
      );

      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

export async function withBrowserRestart<T>(
  fn: () => Promise<T>,
  browserRestartFn: () => Promise<void>,
  options: RetryOptions = {}
): Promise<T> {
  const retryConfig = configManager.getRetryConfig();
  const {
    maxRetries = retryConfig.maxProcessRetries,
    baseDelay = retryConfig.baseDelay,
    maxDelay = retryConfig.maxDelay,
    backoffMultiplier = retryConfig.backoffMultiplier,
    operation = "전체 프로세스",
    shouldRetry = () => true,
  } = options;

  let lastError: Error = new Error("No attempts made");

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      Logger.info(`${operation} 시도 중... (${attempt}/${maxRetries})`);
      const result = await fn();

      if (attempt > 1) {
        Logger.success(`${operation} 성공! (${attempt}번째 시도에서 성공)`);
      }

      return result;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (!shouldRetry(lastError, attempt)) {
        Logger.warning(`${operation} 재시도 중단. 오류: ${lastError.message}`);
        throw lastError;
      }

      if (attempt === maxRetries) {
        Logger.error(`${operation} 최종 실패 (${maxRetries}번 시도 후)`, lastError);
        throw lastError;
      }

      Logger.warning(
        `${operation} 실패 (${attempt}/${maxRetries}). 브라우저 재시작 후 재시도... 오류: ${lastError.message}`
      );

      try {
        await browserRestartFn();
      } catch (restartError) {
        Logger.error("브라우저 재시작 실패", restartError as Error);
      }

      const delay = calculateRetryDelay(
        lastError,
        attempt,
        baseDelay,
        maxDelay,
        backoffMultiplier
      );
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}
