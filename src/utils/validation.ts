import { Config } from "../types";
import { Logger } from "./logger";
import { isTrustedJobKoreaUrl } from "./jobkoreaUrl";

interface ValidationResult {
  isValid: boolean;
  errors: string[];
}

export class ConfigValidator {
  private static validateJobKoreaId(id: string): string[] {
    const errors: string[] = [];

    if (!id || id.trim().length === 0) {
      errors.push("JobKorea ID가 비어있습니다.");
      return errors;
    }

    if (id.length < 3) {
      errors.push("JobKorea ID는 최소 3자 이상이어야 합니다.");
    }

    if (id.length > 50) {
      errors.push("JobKorea ID는 50자를 초과할 수 없습니다.");
    }

    // 특수문자나 공백 체크
    if (/\s/.test(id)) {
      errors.push("JobKorea ID에는 공백이 포함될 수 없습니다.");
    }

    return errors;
  }

  private static validateJobKoreaPassword(password: string): string[] {
    const errors: string[] = [];

    if (!password || password.trim().length === 0) {
      errors.push("JobKorea 비밀번호가 비어있습니다.");
      return errors;
    }

    if (password.length < 4) {
      errors.push("JobKorea 비밀번호는 최소 4자 이상이어야 합니다.");
    }

    if (password.length > 100) {
      errors.push("JobKorea 비밀번호는 100자를 초과할 수 없습니다.");
    }

    return errors;
  }

  private static validateTelegramToken(token: string): string[] {
    const errors: string[] = [];

    if (!token || token.trim().length === 0) {
      errors.push("Telegram 봇 토큰이 비어있습니다.");
      return errors;
    }

    // Telegram 봇 토큰 형식: 숫자:영숫자_하이픈 (예: 123456789:ABCdefGHIjklMNOpqrsTUVwxyz-_)
    const telegramTokenRegex = /^\d+:[A-Za-z0-9_-]+$/;
    if (!telegramTokenRegex.test(token)) {
      errors.push("Telegram 봇 토큰 형식이 올바르지 않습니다. (형식: 숫자:영숫자_하이픈)");
    }

    if (token.length < 20) {
      errors.push("Telegram 봇 토큰이 너무 짧습니다.");
    }

    if (token.length > 100) {
      errors.push("Telegram 봇 토큰이 너무 깁니다.");
    }

    return errors;
  }

  private static validateTelegramChatId(chatId: string): string[] {
    const errors: string[] = [];

    if (!chatId || chatId.trim().length === 0) {
      errors.push("Telegram 채팅 ID가 비어있습니다.");
      return errors;
    }

    // Telegram 채팅 ID는 숫자이거나 @로 시작하는 문자열
    const telegramChatIdRegex = /^(-?\d+|@[a-zA-Z][a-zA-Z0-9_]{4,31})$/;
    if (!telegramChatIdRegex.test(chatId)) {
      errors.push("Telegram 채팅 ID 형식이 올바르지 않습니다. (숫자 또는 @username)");
    }

    return errors;
  }

  static validateConfig(config: Config): ValidationResult {
    const errors: string[] = [];

    // 각 필드별 검증
    errors.push(...this.validateJobKoreaId(config.jobkoreaId));
    errors.push(...this.validateJobKoreaPassword(config.jobkoreaPwd));
    errors.push(...this.validateTelegramToken(config.telegramToken));
    errors.push(...this.validateTelegramChatId(config.telegramChatId));

    const isValid = errors.length === 0;

    if (!isValid) {
      Logger.error("환경변수 검증 실패:");
      errors.forEach(error => Logger.error(`  - ${error}`));
    } else {
      Logger.success("환경변수 검증 완료");
    }

    return { isValid, errors };
  }

  static validateEnvironmentVariables(): ValidationResult {
    const requiredVars = [
      'JOBKOREA_ID',
      'JOBKOREA_PWD',
      'TELEGRAM_BOT_TOKEN',
      'TELEGRAM_CHAT_ID'
    ];

    const errors: string[] = [];

    for (const varName of requiredVars) {
      const value = process.env[varName];
      if (!value) {
        errors.push(`환경변수 ${varName}이 설정되지 않았습니다.`);
      }
    }

    return { isValid: errors.length === 0, errors };
  }

  static validateJobKoreaUrls(urls: {
    login: string;
    mypage: string;
  }): ValidationResult {
    const errors: string[] = [];

    if (!isTrustedJobKoreaUrl(urls.login)) {
      errors.push(
        "JOBKOREA_LOGIN_URL은 HTTPS JobKorea 도메인이어야 합니다."
      );
    }

    if (!isTrustedJobKoreaUrl(urls.mypage)) {
      errors.push(
        "JOBKOREA_MYPAGE_URL은 HTTPS JobKorea 도메인이어야 합니다."
      );
    }

    return { isValid: errors.length === 0, errors };
  }
}
