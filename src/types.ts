// 기본 설정 타입
export interface Config {
  readonly jobkoreaId: string;
  readonly jobkoreaPwd: string;
  readonly telegramToken: string;
  readonly telegramChatId: string;
}

// 로그 레벨 타입
export type LogLevel = "error" | "warn" | "info" | "debug";

// 작업 타입
export type OperationType = "navigation" | "element" | "popup" | "network";

// 에러 코드 상수
export const ERROR_CODES = {
  AUTH_ERROR: "AUTH_ERROR",
  NAVIGATION_ERROR: "NAVIGATION_ERROR",
  UPDATE_ERROR: "UPDATE_ERROR",
} as const;

export type ErrorCode = typeof ERROR_CODES[keyof typeof ERROR_CODES];

// 강화된 에러 클래스
export class JobKoreaError extends Error {
  public readonly timestamp: number;
  public readonly context?: Record<string, unknown>;

  constructor(
    message: string,
    public readonly code: ErrorCode,
    context?: Record<string, unknown>,
    public readonly retryable: boolean = true
  ) {
    super(message);
    this.name = "JobKoreaError";
    this.timestamp = Date.now();
    this.context = context;

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, JobKoreaError);
    }
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      timestamp: this.timestamp,
      context: this.context,
      retryable: this.retryable,
    };
  }
}

export class AuthenticationError extends JobKoreaError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, ERROR_CODES.AUTH_ERROR, context, false);
    this.name = "AuthenticationError";
  }
}

export class NavigationError extends JobKoreaError {
  constructor(
    message: string,
    context?: Record<string, unknown>,
    retryable: boolean = true
  ) {
    super(message, ERROR_CODES.NAVIGATION_ERROR, context, retryable);
    this.name = "NavigationError";
  }
}

export class UpdateError extends JobKoreaError {
  constructor(
    message: string,
    context?: Record<string, unknown>,
    retryable: boolean = true
  ) {
    super(message, ERROR_CODES.UPDATE_ERROR, context, retryable);
    this.name = "UpdateError";
  }
}

// EX_TEMPFAIL: the workflow may start a fresh runner only for a navigation
// failure that is explicitly safe to retry. Authentication and update errors
// keep the ordinary failure code so credentials or mutations are not repeated.
export const RETRYABLE_NAVIGATION_EXIT_CODE = 75;

export function getFailureExitCode(error: unknown): number {
  return error instanceof NavigationError && error.retryable
    ? RETRYABLE_NAVIGATION_EXIT_CODE
    : 1;
}

export function isRetryableJobKoreaError(error: Error): boolean {
  return !(error instanceof JobKoreaError) || error.retryable;
}
