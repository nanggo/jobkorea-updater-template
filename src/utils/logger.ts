import { LogLevel, JobKoreaError, OperationType } from "../types";
import { configManager } from "../config";
import {
  isTrustedJobKoreaUrl,
  isTrustedJobKoreaWebSocketUrl,
} from "./jobkoreaUrl";

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  context?: Record<string, unknown>;
  operation?: OperationType;
  duration?: number;
  error?: {
    name: string;
    message: string;
    code?: string;
    stack?: string;
  };
}

export class Logger {
  private static readonly registeredSensitiveValues = new Set<string>();

  private static readonly SENSITIVE_PATTERNS = [
    { pattern: /(password|pwd|pass|secret)[\s]*[:=][\s]*["']?([^"'\s,}]+)/gi, replacement: "$1: ***" },
    { pattern: /(token|key|auth|bearer)[\s]*[:=][\s]*["']?([^"'\s,}]+)/gi, replacement: "$1: ***" },
    { pattern: /(jobkorea_?id|user_?id|login_?id)[\s]*[:=][\s]*["']?([^"'\s,}]+)/gi, replacement: "$1: ***" },
    {
      pattern: /(telegram_?bot_?token|telegram_?chat_?id)[\s]*[:=][\s]*["']?([^"'\s,}]+)/gi,
      replacement: "$1: ***",
    },
    { pattern: /(\b\d{10,}\b)/g, replacement: "***" },
  ];

  private static applySensitiveValueMasking(data: string): string {
    let maskedData = data;
    for (const { pattern, replacement } of this.SENSITIVE_PATTERNS) {
      maskedData = maskedData.replace(pattern, replacement);
    }

    const registeredValues = [...this.registeredSensitiveValues].sort(
      (left, right) => right.length - left.length
    );
    for (const value of registeredValues) {
      const variants = new Set([value]);
      try {
        variants.add(encodeURIComponent(value));
      } catch {
        // Environment strings should be valid Unicode, but raw masking still applies.
      }
      for (const variant of variants) {
        maskedData = maskedData.split(variant).join("***");
      }
    }
    return maskedData;
  }

  private static maskSensitiveData(data: string): string {
    const config = configManager.getSecurityConfig();
    return config.maskSensitiveInfo
      ? this.applySensitiveValueMasking(data)
      : data;
  }

  static registerSensitiveValues(values: readonly string[]): void {
    values
      .filter(value => value.length >= 3)
      .forEach(value => this.registeredSensitiveValues.add(value));
  }

  private static stripUrlDetails(data: string): string {
    return data.replace(/(?:https?|wss?):\/\/[^\s"'<>]+/gi, (rawUrl) => {
      try {
        const url = new URL(rawUrl);
        const trustedJobKoreaUrl =
          isTrustedJobKoreaUrl(url.toString()) ||
          isTrustedJobKoreaWebSocketUrl(url.toString());
        url.username = "";
        url.password = "";
        url.search = "";
        url.hash = "";
        return trustedJobKoreaUrl ? url.toString() : `${url.origin}/`;
      } catch {
        return rawUrl;
      }
    });
  }

  private static sanitizeLogString(data: string): string {
    return this.maskSensitiveData(this.stripUrlDetails(data));
  }

  static redactForExternalOutput(data: string): string {
    return this.applySensitiveValueMasking(this.stripUrlDetails(data));
  }

  private static isSensitiveContextKey(key: string): boolean {
    const normalized = key.replace(/[-_\s]/g, "").toLowerCase();
    const exactKeys = new Set([
      "password",
      "pwd",
      "pass",
      "secret",
      "token",
      "key",
      "auth",
      "authorization",
      "bearer",
      "jobkoreaid",
      "userid",
      "loginid",
      "telegrambottoken",
      "telegramchatid",
    ]);

    return (
      exactKeys.has(normalized) ||
      /(?:password|secret|token|apikey)$/.test(normalized)
    );
  }

  private static sanitizeContextValue(value: unknown, seen: WeakSet<object>): unknown {
    if (typeof value === "string") {
      return this.sanitizeLogString(value);
    }

    if (value === null || typeof value !== "object") {
      return value;
    }

    if (seen.has(value)) {
      return "[Circular]";
    }

    seen.add(value);
    try {
      if (value instanceof URL) {
        return this.sanitizeLogString(value.toString());
      }

      if (value instanceof Date) {
        return value;
      }

      if (Array.isArray(value)) {
        return value.map((item) => this.sanitizeContextValue(item, seen));
      }

      const sanitized: Record<string, unknown> = {};
      for (const [key, nestedValue] of Object.entries(value)) {
        sanitized[key] = this.isSensitiveContextKey(key)
          ? "***"
          : this.sanitizeContextValue(nestedValue, seen);
      }
      return sanitized;
    } finally {
      seen.delete(value);
    }
  }

  private static sanitizeContext(context: Record<string, unknown>): Record<string, unknown> {
    return this.sanitizeContextValue(context, new WeakSet<object>()) as Record<string, unknown>;
  }

  private static shouldLog(level: LogLevel): boolean {
    const loggingConfig = configManager.getLoggingConfig();
    const levels: LogLevel[] = ["error", "warn", "info", "debug"];
    const currentLevelIndex = levels.indexOf(loggingConfig.logLevel);
    const messageLevelIndex = levels.indexOf(level);
    return messageLevelIndex <= currentLevelIndex;
  }

  private static createLogEntry(
    level: LogLevel,
    message: string,
    context?: Record<string, unknown>,
    error?: Error,
    operation?: OperationType,
    duration?: number
  ): LogEntry {
    const loggingConfig = configManager.getLoggingConfig();

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message: loggingConfig.enableSensitiveDataMasking ? this.sanitizeLogString(message) : message,
      context:
        context && loggingConfig.enableSensitiveDataMasking
          ? this.sanitizeContext(context)
          : context,
      operation,
      duration,
    };

    if (error) {
      entry.error = {
        name: error.name,
        message: loggingConfig.enableSensitiveDataMasking
          ? this.sanitizeLogString(error.message)
          : error.message,
        code: error instanceof JobKoreaError ? error.code : undefined,
        stack:
          error.stack && loggingConfig.enableSensitiveDataMasking
            ? this.sanitizeLogString(error.stack)
            : error.stack,
      };
    }

    return entry;
  }

  private static formatForConsole(entry: LogEntry): string {
    const { timestamp, level, message, context, operation, duration, error } = entry;
    const loggingConfig = configManager.getLoggingConfig();

    let formatted = "";

    if (loggingConfig.includeTimestamp) {
      formatted += `[${timestamp}] `;
    }

    const levelEmoji = {
      error: "❌",
      warn: "⚠️",
      info: "ℹ️",
      debug: "🔍",
    };

    formatted += `${levelEmoji[level]} [${level.toUpperCase()}] ${message}`;

    if (operation) {
      formatted += ` [${operation}]`;
    }

    if (duration !== undefined) {
      formatted += ` (${duration}ms)`;
    }

    if (context && Object.keys(context).length > 0) {
      formatted += ` | Context: ${JSON.stringify(context)}`;
    }

    if (error) {
      formatted += ` | Error: ${error.name}: ${error.message}`;
      if (error.code) {
        formatted += ` (${error.code})`;
      }
    }

    return formatted;
  }

  static log(
    level: LogLevel,
    message: string,
    context?: Record<string, unknown>,
    error?: Error,
    operation?: OperationType,
    duration?: number
  ): void {
    if (!this.shouldLog(level)) {
      return;
    }

    const entry = this.createLogEntry(level, message, context, error, operation, duration);
    const formatted = this.formatForConsole(entry);

    switch (level) {
      case "error":
        console.error(formatted);
        break;
      case "warn":
        console.warn(formatted);
        break;
      case "info":
        console.log(formatted);
        break;
      case "debug":
        console.debug(formatted);
        break;
    }
  }

  static debug(message: string, context?: Record<string, unknown>, operation?: OperationType): void {
    this.log("debug", message, context, undefined, operation);
  }

  static info(message: string, context?: Record<string, unknown>, operation?: OperationType): void {
    this.log("info", message, context, undefined, operation);
  }

  static warning(message: string, context?: Record<string, unknown>, operation?: OperationType): void {
    this.log("warn", message, context, undefined, operation);
  }

  static error(
    message: string,
    error?: Error,
    context?: Record<string, unknown>,
    operation?: OperationType
  ): void {
    this.log("error", message, context, error, operation);
  }

  static success(
    message: string,
    context?: Record<string, unknown>,
    operation?: OperationType,
    duration?: number
  ): void {
    this.log("info", `✅ ${message}`, context, undefined, operation, duration);
  }
}
