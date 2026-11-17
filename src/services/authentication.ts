import { BrowserService } from "./browser";
import { JobKoreaService } from "./jobkorea";
import { AuthenticationError, TwoFactorAuthenticationError } from "../types";
import { Logger } from "../utils/logger";
import { TelegramAuthConfig } from "./telegramAuth";
import { authenticateViaTelegram } from "./twoFactorTelegram";

export async function authenticate(options: {
  directory: string;
  accountId: string;
  password?: string;
  checkOnly: boolean;
  headless: boolean;
  debugPort?: number;
  telegram?: TelegramAuthConfig;
}): Promise<void> {
  const browser = new BrowserService({
    authStateDirectory: options.directory,
    accountId: options.accountId,
    restoreAuthState: options.checkOnly,
    headless: options.checkOnly || options.headless,
    debugPort: options.checkOnly ? undefined : options.debugPort,
  });
  let interrupted = false;
  const shutdown = (code: number) => {
    interrupted = true;
    process.exitCode = code;
    void browser.close();
  };
  const onSigint = () => shutdown(130);
  const onSigterm = () => shutdown(143);
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  try {
    await browser.initialize();
    const service = new JobKoreaService(browser.getPage());
    if (options.checkOnly) {
      if (!browser.hasStoredAuthState() || !await service.tryRestoreSession()) {
        throw new AuthenticationError("저장된 인증 상태가 없거나 만료되었습니다. README의 최초 인증 절차를 진행하세요.");
      }
      Logger.success("저장된 인증 상태로 마이페이지 접근 확인. 이력서는 변경하지 않았습니다.");
      return;
    }
    if (!options.password) throw new AuthenticationError("JOBKOREA_PWD가 필요합니다.");
    await service.navigateToLoginPage();
    try {
      const popup = await service.login(options.accountId, options.password);
      await service.handleLoginPopup(popup);
      await service.navigateToMypage();
    } catch (error) {
      if (!(error instanceof TwoFactorAuthenticationError)) throw error;
      if (options.telegram) {
        await authenticateViaTelegram(service, options.telegram);
      } else {
        Logger.info("브라우저에서 문자 또는 이메일 인증을 직접 완료하세요. 최대 10분간 기다립니다. 인증번호를 로그나 파일에 저장하지 마세요.");
        if (options.debugPort) {
          Logger.info(`SSH로 localhost:${options.debugPort}를 연결한 뒤 Chrome의 chrome://inspect에서 이 브라우저를 여세요. debugger 포트를 외부에 공개하지 마세요.`);
        }
        await service.waitForManualAuthentication();
      }
    }
    if (interrupted) throw new AuthenticationError("인증 설정을 중단했습니다.");
    await browser.saveAuthenticatedState();
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    await browser.close();
  }
  if (interrupted) throw new AuthenticationError("인증 설정을 중단했습니다.");
  // A completely new Chromium process must recognize the saved state.
  await authenticate({ ...options, checkOnly: true, debugPort: undefined });
}
