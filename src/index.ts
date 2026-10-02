// src/index.ts
import * as fs from "fs";
import * as path from "path";

let dotenvLoadError: unknown;
try {
  require("dotenv").config({ quiet: true });
} catch (error) {
  dotenvLoadError = error;
}

// 설정 모듈은 dotenv 처리 후 로드해야 로컬 .env override가 반영된다.
const { updateResume }: typeof import("./updateResume") = require("./updateResume");
const { ConfigValidator }: typeof import("./utils/validation") = require("./utils/validation");
const { Logger }: typeof import("./utils/logger") = require("./utils/logger");
const { configManager }: typeof import("./config") = require("./config");
const { getFailureExitCode }: typeof import("./types") = require("./types");

function cleanupOldDiagnostics(): void {
  try {
    const cwd = process.cwd();
    const directories = [cwd, path.join(cwd, "diagnostics")];
    let deletedCount = 0;

    for (const directory of directories) {
      if (!fs.existsSync(directory)) continue;

      const files = fs.readdirSync(directory);
      const diagnosticFiles = files.filter(file =>
        /^error-.*\.(png|html)$/.test(file)
      );

      for (const file of diagnosticFiles) {
        try {
          fs.unlinkSync(path.join(directory, file));
          deletedCount++;
        } catch {
          Logger.warning(`진단 파일 삭제 실패: ${file}`);
        }
      }
    }

    if (deletedCount > 0) {
      Logger.info(`이전 진단 파일 ${deletedCount}개 정리 완료`);
    }
  } catch {
    Logger.warning("진단 파일 정리 중 오류 발생");
  }
}

async function main() {
  try {
    if (dotenvLoadError) {
      Logger.debug("dotenv를 불러오지 못했습니다. 주입된 환경변수를 사용합니다.");
    }

    cleanupOldDiagnostics();

    // 환경변수 존재 여부 검증
    const envValidation = ConfigValidator.validateEnvironmentVariables();
    if (!envValidation.isValid) {
      Logger.error("환경변수 검증 실패:");
      envValidation.errors.forEach(error => Logger.error(`  - ${error}`));
      process.exitCode = 1;
      return;
    }

    const urlValidation = ConfigValidator.validateJobKoreaUrls(
      configManager.getUrls()
    );
    if (!urlValidation.isValid) {
      Logger.error("JobKorea URL 검증 실패:");
      urlValidation.errors.forEach(error => Logger.error(`  - ${error}`));
      process.exitCode = 1;
      return;
    }

    // 설정 객체 생성
    const config = {
      jobkoreaId: process.env.JOBKOREA_ID!,
      jobkoreaPwd: process.env.JOBKOREA_PWD!,
      telegramToken: process.env.TELEGRAM_BOT_TOKEN!,
      telegramChatId: process.env.TELEGRAM_CHAT_ID!,
    };
    Logger.registerSensitiveValues(Object.values(config));

    // 설정 값 형식 검증
    const configValidation = ConfigValidator.validateConfig(config);
    if (!configValidation.isValid) {
      Logger.error("설정 검증 실패. 환경변수를 확인해주세요.");
      process.exitCode = 1;
      return;
    }

    Logger.info("애플리케이션 시작");
    await updateResume(config);
    Logger.success("애플리케이션 정상 종료");
  } catch (error) {
    Logger.error("애플리케이션 실행 중 치명적 오류 발생", error as Error);
    process.exitCode = getFailureExitCode(error);
  }
}

void main();
