import { chmod, mkdir, writeFile } from "fs/promises";
import * as path from "path";
import { Dialog, Locator, Page } from "playwright";
import { configManager } from "../config";
import { Logger } from "../utils/logger";
import { withRetry } from "../utils/retry";
import {
  AuthenticationError,
  isRetryableJobKoreaError,
  NavigationError,
  UpdateError,
} from "../types";
import {
  isJobKoreaAccountRecoveryPath,
  isJobKoreaLoginPath,
  isTrustedJobKoreaUrl,
} from "../utils/jobkoreaUrl";
import {
  armCredentialEgressGuard,
  consumeBlockedContextNavigation,
  consumeBlockedTopLevelNavigation,
  disarmCredentialEgressGuard,
} from "../utils/trustedNavigation";

interface LoginForm {
  form: Locator;
  idInput: Locator;
  passwordInput: Locator;
  loginButton: Locator;
}

function describeLoginDialogs(messages: string[]): string {
  const text = messages
    .map(message => message.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(" / ");
  return text ? ` (JobKorea 안내: ${text.slice(0, 300)})` : "";
}

export class JobKoreaService {
  private readonly urls = configManager.getUrls();
  private readonly selectors = configManager.getSelectors();
  private readonly timeouts = configManager.getTimeouts();
  private readonly retryConfig = configManager.getRetryConfig();
  private readonly diagnosticsConfig = configManager.getDiagnosticsConfig();

  constructor(private readonly page: Page) {}

  private assertTrustedUrl(
    url: string,
    operation: "navigation" | "authentication" | "update"
  ): void {
    if (isTrustedJobKoreaUrl(url)) return;

    const message = `신뢰할 수 없는 JobKorea URL이 감지되었습니다: ${url}`;
    const context = { currentUrl: url };

    if (operation === "authentication") {
      throw new AuthenticationError(message, context);
    }
    if (operation === "update") {
      throw new UpdateError(message, context, false);
    }
    throw new NavigationError(message, context, false);
  }

  private assertNoBlockedNavigation(
    page: Page,
    operation: "navigation" | "authentication" | "update"
  ): void {
    const blockedUrl =
      consumeBlockedTopLevelNavigation(page) ??
      consumeBlockedContextNavigation(page.context());
    if (blockedUrl) {
      this.assertTrustedUrl(blockedUrl, operation);
    }
  }

  private async assertLoginControlOwnedByForm(
    form: Locator,
    control: Locator,
    label: string
  ): Promise<void> {
    const formHandle = await form.evaluateHandle(formElement => formElement);

    try {
      const isOwned = await control.evaluate(
        (controlElement, formElement) =>
          (controlElement as HTMLInputElement | HTMLButtonElement).form ===
          formElement,
        formHandle
      );
      if (isOwned) return;

      throw new AuthenticationError(
        `${label}의 form owner가 신뢰 로그인 폼과 일치하지 않습니다.`
      );
    } finally {
      await formHandle.dispose();
    }
  }

  private async assertTrustedLoginForm(loginForm: LoginForm): Promise<void> {
    const { form, idInput, passwordInput, loginButton } = loginForm;
    const formProperties = await form.evaluate(formElement => {
      const htmlForm = formElement as HTMLFormElement;
      return {
        action: htmlForm.action,
        method: htmlForm.method,
        target: htmlForm.target,
      };
    });
    const submitterProperties = await loginButton.evaluate(buttonElement => {
      const submitter = buttonElement as HTMLButtonElement | HTMLInputElement;
      return {
        hasFormAction: submitter.hasAttribute("formaction"),
        formAction: submitter.formAction,
        hasFormMethod: submitter.hasAttribute("formmethod"),
        formMethod: submitter.formMethod,
        hasFormTarget: submitter.hasAttribute("formtarget"),
        formTarget: submitter.formTarget,
      };
    });
    const actionUrl = submitterProperties.hasFormAction
      ? submitterProperties.formAction
      : formProperties.action;
    const method = (
      submitterProperties.hasFormMethod
        ? submitterProperties.formMethod
        : formProperties.method
    ).toLowerCase();
    const target = (
      submitterProperties.hasFormTarget
        ? submitterProperties.formTarget
        : formProperties.target
    ).toLowerCase();

    try {
      new URL(actionUrl);
    } catch {
      throw new AuthenticationError("로그인 폼 action이 올바른 URL이 아닙니다.");
    }

    if (!isTrustedJobKoreaUrl(actionUrl) || !isJobKoreaLoginPath(actionUrl)) {
      throw new AuthenticationError(
        `신뢰할 수 없는 로그인 폼 action이 감지되었습니다: ${actionUrl}`
      );
    }

    if (method !== "post") {
      throw new AuthenticationError(
        `로그인 폼의 전송 방식이 POST가 아닙니다: ${method || "unknown"}`
      );
    }

    if (target !== "" && target !== "_self") {
      throw new AuthenticationError(
        `로그인 폼의 전송 target이 현재 frame이 아닙니다: ${target}`
      );
    }

    await this.assertLoginControlOwnedByForm(form, idInput, "아이디 입력 필드");
    await this.assertLoginControlOwnedByForm(
      form,
      passwordInput,
      "비밀번호 입력 필드"
    );
    await this.assertLoginControlOwnedByForm(form, loginButton, "로그인 버튼");

    const passwordType = await passwordInput.evaluate(
      element => (element as HTMLInputElement).type.toLowerCase()
    );
    if (passwordType !== "password") {
      throw new AuthenticationError(
        "비밀번호 입력 필드가 password 타입이 아닙니다."
      );
    }
  }

  private async findEnabledLocator(
    scope: Pick<Page, "locator"> | Pick<Locator, "locator">,
    selectors: readonly string[]
  ): Promise<Locator | null> {
    for (const selector of selectors) {
      const locators = scope.locator(`${selector}:visible`);
      const count = await locators.count();
      for (let index = 0; index < count; index++) {
        const locator = locators.nth(index);
        if (await locator.isEnabled()) {
          return locator;
        }
      }
    }

    return null;
  }

  private async waitForLoginForm(
    timeout: number,
    operation: "navigation" | "authentication"
  ): Promise<LoginForm> {
    const deadline = Date.now() + timeout;
    let rejectedAction: AuthenticationError | null = null;

    while (Date.now() < deadline) {
      this.assertNoBlockedNavigation(this.page, operation);
      for (const selector of this.selectors.login.form) {
        const forms = this.page.locator(`${selector}:visible`);
        const count = await forms.count();

        for (let index = 0; index < count; index++) {
          const form = forms.nth(index);
          const idInput = await this.findEnabledLocator(
            form,
            this.selectors.login.idInput
          );
          const passwordInput = await this.findEnabledLocator(
            form,
            this.selectors.login.passwordInput
          );
          const loginButton = await this.findEnabledLocator(
            form,
            this.selectors.login.loginButton
          );

          if (!idInput || !passwordInput || !loginButton) {
            continue;
          }

          const loginForm = { form, idInput, passwordInput, loginButton };
          try {
            await this.assertTrustedLoginForm(loginForm);
          } catch (error) {
            if (error instanceof AuthenticationError) {
              rejectedAction = error;
              continue;
            }
            throw error;
          }

          this.assertNoBlockedNavigation(this.page, operation);
          Logger.info("동일한 신뢰 로그인 폼에서 자격증명 필드를 확인했습니다.");
          return loginForm;
        }
      }

      await this.page.waitForTimeout(100);
    }

    if (rejectedAction) {
      throw rejectedAction;
    }
    throw new Error(
      "동일한 로그인 폼에서 아이디, 비밀번호, 로그인 버튼을 찾지 못했습니다."
    );
  }

  private async captureFailureArtifacts(
    prefix: "navigate" | "login" | "update",
    page: Page,
    includeHtml: boolean = false
  ): Promise<void> {
    if (!this.diagnosticsConfig.captureFailureArtifacts) {
      Logger.debug(`실패 진단 파일 저장 생략: ${prefix}`);
      return;
    }

    try {
      const diagnosticsDirectory = path.join(process.cwd(), "diagnostics");
      await mkdir(diagnosticsDirectory, { recursive: true, mode: 0o700 });
      await chmod(diagnosticsDirectory, 0o700);

      const timestamp = Date.now();
      const screenshotPath = path.join(
        diagnosticsDirectory,
        `error-${prefix}-${timestamp}.png`
      );
      const tasks: Promise<unknown>[] = [
        page
          .screenshot({ path: screenshotPath, fullPage: true })
          .then(() => chmod(screenshotPath, 0o600)),
      ];
      const labels = [`스크린샷: ${screenshotPath}`];

      if (includeHtml) {
        const htmlPath = path.join(
          diagnosticsDirectory,
          `error-${prefix}-${timestamp}.html`
        );
        tasks.push(
          page.content().then(html =>
            writeFile(htmlPath, html, {
              encoding: "utf-8",
              mode: 0o600,
            })
          )
        );
        labels.push(`HTML: ${htmlPath}`);
      }

      const results = await Promise.allSettled(tasks);
      results.forEach((result, index) => {
        if (result.status === "fulfilled") {
          Logger.warning(`실패 진단 파일 저장 완료 (${labels[index]})`);
        } else {
          Logger.warning(
            `실패 진단 파일 저장 실패 (${labels[index]}): ${result.reason}`
          );
        }
      });
    } catch (error) {
      Logger.warning("실패 진단 파일 준비 중 오류가 발생했습니다.", {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async waitForClickableLocator(
    page: Page,
    selectors: readonly string[],
    timeout: number
  ): Promise<Locator> {
    const deadline = Date.now() + timeout;

    while (Date.now() < deadline) {
      if (page.isClosed()) {
        throw new Error(
          "페이지가 닫혀 클릭 가능한 셀렉터를 찾을 수 없습니다."
        );
      }

      for (const selector of selectors) {
        try {
          const visibleLocators = page.locator(`${selector}:visible`);
          const count = await visibleLocators.count();
          for (let index = 0; index < count; index++) {
            const locator = visibleLocators.nth(index);
            if (await locator.isEnabled()) {
              Logger.info(`클릭 가능한 셀렉터 성공: ${selector}`);
              return locator;
            }
          }
        } catch (error) {
          if (
            page.isClosed() ||
            (error instanceof Error && /(?:closed|closing)/i.test(error.message))
          ) {
            throw error;
          }
          Logger.debug(`클릭 가능한 셀렉터 확인 실패: ${selector}`);
        }
      }

      await page.waitForTimeout(100);
    }

    throw new Error(
      `클릭 가능한 셀렉터를 찾지 못했습니다: ${selectors.join(", ")}`
    );
  }

  private shouldSkipNavigationArtifacts(error: Error): boolean {
    return (
      error.message.includes("page.goto: Timeout") &&
      (this.page.url() === "about:blank" || this.page.url().startsWith("chrome-error://"))
    );
  }

  private async waitForAnySelector(
    selectors: readonly string[],
    options: {
      state?: "visible" | "attached" | "detached" | "hidden";
      timeout?: number;
    } = {}
  ): Promise<string> {
    const { state = "visible" } = options;
    const timeout = options.timeout || this.timeouts.element;

    if (state === "visible") {
      const visibleSelectors = selectors.map(selector => `${selector}:visible`);
      await this.page.waitForSelector(visibleSelectors.join(", "), {
        state,
        timeout,
      });

      for (const visibleSelector of visibleSelectors) {
        if (await this.page.locator(visibleSelector).first().isVisible()) {
          Logger.info(`셀렉터 성공: ${visibleSelector}`);
          return visibleSelector;
        }
      }

      throw new Error(`표시된 셀렉터를 찾지 못했습니다: ${selectors.join(", ")}`);
    }

    for (const selector of selectors) {
      try {
        await this.page.waitForSelector(selector, {
          state,
          timeout: Math.floor(timeout / selectors.length),
        });
        Logger.info(`셀렉터 성공: ${selector}`);
        return selector;
      } catch {
        Logger.warning(`셀렉터 실패: ${selector}, 다음 셀렉터 시도 중...`);
      }
    }

    throw new Error(`모든 셀렉터 실패: ${selectors.join(", ")}`);
  }

  async navigateToLoginPage(): Promise<void> {
    this.assertTrustedUrl(this.urls.login, "navigation");

    await withRetry(
      async () => {
        this.assertNoBlockedNavigation(this.page, "navigation");
        let response;
        try {
          response = await this.page.goto(this.urls.login, {
            waitUntil: "commit",
            timeout: this.timeouts.navigation,
          });
        } catch (error) {
          this.assertNoBlockedNavigation(this.page, "navigation");
          throw error;
        }
        this.assertNoBlockedNavigation(this.page, "navigation");

        Logger.info(
          "로그인 페이지 최초 응답 수신",
          {
            requestedUrl: this.urls.login,
            currentUrl: this.page.url(),
            responseUrl: response?.url() ?? null,
            status: response?.status() ?? null,
            ok: response?.ok() ?? null,
          },
          "navigation"
        );

        this.assertTrustedUrl(this.page.url(), "navigation");
        if (response && !response.ok()) {
          throw new NavigationError(
            `로그인 페이지가 HTTP ${response.status()}로 응답했습니다.`,
            { currentUrl: this.page.url(), status: response.status() }
          );
        }

        try {
          await this.page.waitForLoadState("domcontentloaded", {
            timeout: Math.floor(this.timeouts.navigation / 2),
          });
        } catch (error) {
          Logger.warning(
            "DOMContentLoaded 대기 시간 초과. 셀렉터 기준으로 계속 진행합니다.",
            {
              currentUrl: this.page.url(),
              reason: error instanceof Error ? error.message : String(error),
            },
            "navigation"
          );
        }

        this.assertNoBlockedNavigation(this.page, "navigation");
        await this.waitForLoginForm(
          this.timeouts.navigation,
          "navigation"
        );
        this.assertNoBlockedNavigation(this.page, "navigation");

        Logger.success(
          "로그인 페이지로 성공적으로 이동 및 확인 완료",
          { currentUrl: this.page.url() },
          "navigation"
        );
      },
      {
        maxRetries: this.retryConfig.maxOperationRetries,
        operation: "로그인 페이지 이동",
        shouldRetry: isRetryableJobKoreaError,
      }
    ).catch(async (originalError: Error) => {
      if (this.shouldSkipNavigationArtifacts(originalError)) {
        Logger.warning(
          "로그인 페이지 응답 미수신 상태라 스크린샷/HTML 저장을 생략합니다.",
          {
            requestedUrl: this.urls.login,
            currentUrl: this.page.url(),
            reason: originalError.message,
          },
          "navigation"
        );
      } else {
        await this.captureFailureArtifacts("navigate", this.page, true);
      }

      if (!isRetryableJobKoreaError(originalError)) {
        throw originalError;
      }

      throw new NavigationError(
        `로그인 페이지로 이동하는데 실패했습니다. (${this.retryConfig.maxOperationRetries}번 재시도): ${originalError.message}`,
        {
          requestedUrl: this.urls.login,
          currentUrl: this.page.url(),
        }
      );
    });
  }

  async login(id: string, password: string): Promise<Page | null> {
    let submissionAttempted = false;
    // JobKorea explains a refused login in an alert before redirecting, and
    // Playwright dismisses unhandled dialogs silently, so record them while submitting.
    const loginDialogMessages: string[] = [];
    const recordLoginDialog = (dialog: Dialog) => {
      loginDialogMessages.push(dialog.message());
      dialog.dismiss().catch(() => undefined);
    };
    try {
      let loginForm: LoginForm | undefined;

      // DOM 준비 과정만 재시도하고 자격증명 제출은 정확히 한 번만 수행한다.
      await withRetry(
        async () => {
          this.assertNoBlockedNavigation(this.page, "authentication");
          this.assertTrustedUrl(this.page.url(), "authentication");
          loginForm = await this.waitForLoginForm(
            this.timeouts.element,
            "authentication"
          );
          this.assertNoBlockedNavigation(this.page, "authentication");
          await this.assertTrustedLoginForm(loginForm);
          this.assertTrustedUrl(this.page.url(), "authentication");
          armCredentialEgressGuard(this.page.context());
          await loginForm.idInput.fill(id);

          this.assertNoBlockedNavigation(this.page, "authentication");
          await this.assertTrustedLoginForm(loginForm);
          this.assertTrustedUrl(this.page.url(), "authentication");
          await loginForm.passwordInput.fill(password);

          this.assertNoBlockedNavigation(this.page, "authentication");
          await this.assertTrustedLoginForm(loginForm);
          this.assertTrustedUrl(this.page.url(), "authentication");
          await loginForm.loginButton.click({ trial: true });
          this.assertNoBlockedNavigation(this.page, "authentication");
        },
        {
          maxRetries: this.retryConfig.maxOperationRetries,
          operation: "로그인 폼 준비",
          shouldRetry: error => !(error instanceof AuthenticationError),
        }
      );

      if (!loginForm) {
        throw new NavigationError("로그인 폼을 찾지 못했습니다.");
      }

      this.assertNoBlockedNavigation(this.page, "authentication");
      await this.assertTrustedLoginForm(loginForm);
      this.assertTrustedUrl(this.page.url(), "authentication");
      const popupPromise = this.page
        .waitForEvent("popup", { timeout: this.timeouts.popup })
        .catch(() => null);
      const navigationPromise = this.page.waitForURL(
        url => !isJobKoreaLoginPath(url) || isJobKoreaAccountRecoveryPath(url),
        { timeout: this.timeouts.navigation }
      );

      this.page.on("dialog", recordLoginDialog);
      submissionAttempted = true;
      await Promise.all([
        navigationPromise,
        loginForm.loginButton.click(),
      ]);

      this.assertNoBlockedNavigation(this.page, "authentication");
      this.assertTrustedUrl(this.page.url(), "authentication");
      if (isJobKoreaAccountRecoveryPath(this.page.url())) {
        throw new AuthenticationError(
          "JobKorea가 로그인을 완료하지 않고 계정 찾기 페이지로 이동시켰습니다. " +
            "비밀번호 변경이 필요할 수 있으니 JobKorea에 직접 로그인해 확인한 뒤 JOBKOREA_PWD를 갱신하세요." +
            describeLoginDialogs(loginDialogMessages),
          { currentUrl: this.page.url(), dialogMessages: loginDialogMessages }
        );
      }
      const popup = await popupPromise;
      this.assertNoBlockedNavigation(this.page, "authentication");
      this.assertTrustedUrl(this.page.url(), "authentication");
      if (popup) {
        this.assertNoBlockedNavigation(popup, "authentication");
      }
      disarmCredentialEgressGuard(this.page.context());
      Logger.success("로그인 성공 및 페이지 전환 확인 완료");
      return popup;
    } catch (error) {
      await this.captureFailureArtifacts("login", this.page);
      this.assertNoBlockedNavigation(this.page, "authentication");
      if (error instanceof AuthenticationError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      if (submissionAttempted) {
        // 실제 click 이후에는 제출 여부를 확정할 수 없으므로 계정 잠금을 피하기 위해
        // navigation timeout이나 browser 오류도 자동 재제출하지 않는다.
        throw new AuthenticationError(
          `로그인 실패: ${message}${describeLoginDialogs(loginDialogMessages)}`
        );
      }
      throw error instanceof NavigationError
        ? error
        : new NavigationError(`로그인 폼 준비 실패: ${message}`);
    } finally {
      this.page.off("dialog", recordLoginDialog);
    }
  }

  async handleLoginPopup(popup: Page | null): Promise<void> {
    if (!popup) {
      Logger.info("처리할 로그인 팝업이 없습니다.");
      return;
    }

    try {
      this.assertNoBlockedNavigation(popup, "authentication");
      await popup
        .waitForLoadState("domcontentloaded", {
          timeout: this.timeouts.navigation,
        })
        .catch(() => undefined);
      this.assertNoBlockedNavigation(popup, "authentication");
      this.assertTrustedUrl(popup.url(), "authentication");
      Logger.info("로그인 팝업 처리 중...");
      await popup.waitForSelector('a[href*="나중에 변경"]', {
        timeout: this.timeouts.element,
      });
      await Promise.all([
        popup.waitForEvent("dialog", { timeout: this.timeouts.popup }).then(async dialog => {
          this.assertNoBlockedNavigation(popup, "authentication");
          this.assertTrustedUrl(popup.url(), "authentication");
          await dialog.dismiss();
        }),
        popup.click('a[href*="나중에 변경"]', { timeout: this.timeouts.element }),
      ]);
      this.assertNoBlockedNavigation(popup, "authentication");
      Logger.success("팝업 처리 완료");
    } catch (error) {
      this.assertNoBlockedNavigation(popup, "authentication");
      if (error instanceof AuthenticationError) {
        throw error;
      }
      Logger.warning("로그인 팝업을 처리할 수 없습니다.");
    } finally {
      if (!popup.isClosed()) {
        await popup.close().catch(error =>
          Logger.warning("로그인 팝업 종료 실패", {
            reason: error instanceof Error ? error.message : String(error),
          })
        );
      }
    }
  }

  async navigateToMypage(): Promise<void> {
    this.assertTrustedUrl(this.urls.mypage, "navigation");

    await withRetry(
      async () => {
        this.assertNoBlockedNavigation(this.page, "navigation");
        let response;
        try {
          response = await this.page.goto(this.urls.mypage, {
            waitUntil: "domcontentloaded",
            timeout: this.timeouts.navigation,
          });
        } catch (error) {
          this.assertNoBlockedNavigation(this.page, "navigation");
          throw error;
        }
        this.assertNoBlockedNavigation(this.page, "navigation");

        this.assertTrustedUrl(this.page.url(), "navigation");
        if (response && !response.ok()) {
          throw new NavigationError(
            `마이페이지가 HTTP ${response.status()}로 응답했습니다.`,
            { currentUrl: this.page.url(), status: response.status() }
          );
        }
        if (isJobKoreaLoginPath(this.page.url())) {
          throw new AuthenticationError("마이페이지 접근 중 로그인 페이지로 되돌아갔습니다.");
        }

        await this.waitForAnySelector(this.selectors.mypage.statusLink, {
          state: "visible",
          timeout: this.timeouts.element,
        });
        this.assertNoBlockedNavigation(this.page, "navigation");
        Logger.success("마이페이지로 이동 완료");
      },
      {
        maxRetries: this.retryConfig.maxOperationRetries,
        operation: "마이페이지 이동",
        shouldRetry: isRetryableJobKoreaError,
      }
    ).catch((error: Error) => {
      if (!isRetryableJobKoreaError(error)) {
        throw error;
      }
      throw new NavigationError(`마이페이지 이동 실패: ${error.message}`);
    });
  }

  async updateCareerInfo(): Promise<void> {
    await withRetry(
      async () => {
        let resumePopup: Page | null = null;
        let updateSubmitted = false;
        try {
          this.assertNoBlockedNavigation(this.page, "update");
          this.assertTrustedUrl(this.page.url(), "update");
          const statusLinkSelector = await this.waitForAnySelector(
            this.selectors.mypage.statusLink,
            { timeout: this.timeouts.element }
          );
          this.assertNoBlockedNavigation(this.page, "update");

          const adModal = await this.page.$(".ab-iam-root");
          if (adModal) {
            await adModal.evaluate((node) => node.remove());
            Logger.info("광고 모달 제거됨");
          }

          const [popup] = await Promise.all([
            this.page.waitForEvent("popup", { timeout: this.timeouts.popup }),
            this.page.click(statusLinkSelector),
          ]);
          this.assertNoBlockedNavigation(this.page, "update");
          resumePopup = popup;

          if (!resumePopup) {
            throw new UpdateError("이력서 팝업창을 열 수 없습니다.");
          }

          this.assertNoBlockedNavigation(resumePopup, "update");
          await resumePopup.waitForLoadState("domcontentloaded", {
            timeout: this.timeouts.navigation,
          });
          this.assertNoBlockedNavigation(resumePopup, "update");
          this.assertTrustedUrl(resumePopup.url(), "update");

          const updateButton = await this.waitForClickableLocator(
            resumePopup,
            this.selectors.mypage.updateButton,
            this.timeouts.element
          );

          this.assertNoBlockedNavigation(resumePopup, "update");
          this.assertTrustedUrl(resumePopup.url(), "update");
          await updateButton.click({ trial: true });
          this.assertNoBlockedNavigation(resumePopup, "update");
          updateSubmitted = true;
          // A click can wait for its dialog to close. Handle the dialog while
          // the click is pending, and observe failures from both operations.
          await Promise.all([
            resumePopup.waitForEvent("dialog", {
              timeout: this.timeouts.element,
            }).then(async dialog => {
              this.assertNoBlockedNavigation(popup, "update");
              this.assertTrustedUrl(popup.url(), "update");
              const successPatterns = configManager.getUpdateConfig().successPatterns;
              const dialogMessage = dialog.message();
              const isSuccess = successPatterns.some(pattern =>
                dialogMessage.includes(pattern)
              );

              if (!isSuccess) {
                await dialog.dismiss();
                throw new UpdateError(
                  `예상치 못한 다이얼로그 발생: ${dialogMessage}`,
                  { dialogMessage, updateSubmitted },
                  false
                );
              }

              Logger.info(`성공 다이얼로그 확인: "${dialogMessage}"`);
              await dialog.accept();
            }),
            updateButton.click({ timeout: this.timeouts.element }),
          ]);
          this.assertNoBlockedNavigation(resumePopup, "update");
          this.assertTrustedUrl(resumePopup.url(), "update");
          Logger.success("경력 정보 업데이트 완료");
        } catch (caughtError) {
          let error = caughtError;
          try {
            this.assertNoBlockedNavigation(this.page, "update");
            if (resumePopup) {
              this.assertNoBlockedNavigation(resumePopup, "update");
            }
          } catch (blockedNavigationError) {
            error = blockedNavigationError;
          }
          const pageToCapture =
            resumePopup && !resumePopup.isClosed() ? resumePopup : this.page;
          await this.captureFailureArtifacts("update", pageToCapture);

          if (
            error instanceof UpdateError ||
            error instanceof NavigationError ||
            error instanceof AuthenticationError
          ) {
            throw error;
          }
          throw new UpdateError(
            `경력 정보 업데이트 실패: ${
              error instanceof Error ? error.message : String(error)
            }`,
            { updateSubmitted },
            !updateSubmitted
          );
        } finally {
          if (resumePopup && !resumePopup.isClosed()) {
            await resumePopup.close().catch(error =>
              Logger.warning("이력서 팝업 종료 실패", {
                reason: error instanceof Error ? error.message : String(error),
              })
            );
          }
        }
      },
      {
        maxRetries: this.retryConfig.maxOperationRetries,
        operation: "경력 정보 업데이트",
        shouldRetry: isRetryableJobKoreaError,
      }
    );
  }
}
