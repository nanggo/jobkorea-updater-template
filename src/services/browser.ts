import { Browser, chromium, Page, BrowserContext } from "playwright";
import { Logger } from "../utils/logger";
import { configManager } from "../config";
import {
  isTrustedJobKoreaUrl,
  isTrustedJobKoreaWebSocketUrl,
} from "../utils/jobkoreaUrl";
import {
  isCredentialEgressGuardArmed,
  recordBlockedContextNavigation,
  recordBlockedTopLevelNavigation,
} from "../utils/trustedNavigation";

const BROWSER_ENVIRONMENT_KEYS = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XAUTHORITY",
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
  "LD_LIBRARY_PATH",
  "DYLD_LIBRARY_PATH",
  "FONTCONFIG_PATH",
  "FONTCONFIG_FILE",
  "__CF_USER_TEXT_ENCODING",
] as const;

export function createBrowserEnvironment(
  source: NodeJS.ProcessEnv
): Record<string, string> {
  const environment: Record<string, string> = {};

  for (const key of BROWSER_ENVIRONMENT_KEYS) {
    const value = source[key];
    if (value !== undefined) {
      environment[key] = value;
    }
  }

  return environment;
}

export function shouldBlockRequest(
  url: string,
  isNavigationRequest: boolean,
  credentialEgressGuardArmed: boolean
): boolean {
  return (
    (isNavigationRequest || credentialEgressGuardArmed) &&
    !isTrustedJobKoreaUrl(url)
  );
}

export class BrowserService {
  private static readonly AD_HOSTNAMES = [
    "doubleclick.net",
    "googleadservices.com",
    "googlesyndication.com",
  ] as const;

  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private closingPromise: Promise<void> | null = null;

  private wirePageDiagnostics(page: Page): void {
    page.on("domcontentloaded", () => {
      Logger.info("메인 페이지 DOMContentLoaded", { url: page.url() }, "navigation");
    });

    page.on("load", () => {
      Logger.info("메인 페이지 load 완료", { url: page.url() }, "navigation");
    });

    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) {
        Logger.info("메인 프레임 URL 변경", { url: frame.url() }, "navigation");
      }
    });

    page.on("requestfailed", (request) => {
      if (!request.isNavigationRequest()) {
        return;
      }

      Logger.warning(
        "네비게이션 요청 실패",
        {
          url: request.url(),
          resourceType: request.resourceType(),
          method: request.method(),
          failure: request.failure()?.errorText,
        },
        "navigation"
      );
    });
  }

  private isKnownHostname(url: string, hostnames: readonly string[]): boolean {
    try {
      const hostname = new URL(url).hostname.toLowerCase();

      return hostnames.some(
        (knownHostname) =>
          hostname === knownHostname || hostname.endsWith(`.${knownHostname}`)
      );
    } catch {
      return false;
    }
  }

  async initialize(): Promise<void> {
    try {
      const browserConfig = configManager.getBrowserConfig();

      // 설정 기반 브라우저 옵션
      this.browser = await chromium.launch({
        headless: browserConfig.headless,
        chromiumSandbox: true,
        args: [...browserConfig.args],
        env: createBrowserEnvironment(process.env),
      });

      // 설정 기반 컨텍스트 설정
      this.context = await this.browser.newContext({
        viewport: {
          width: browserConfig.viewport.width,
          height: browserConfig.viewport.height,
        },
        // 불필요한 리소스 차단으로 성능 향상
        // 이미지, 폰트, 스타일시트만 로드하고 기타 리소스는 차단
        // 하지만 JobKorea 사이트의 기능에 필요한 것들은 유지
        javaScriptEnabled: true,
        serviceWorkers: "block",
        // 메모리 사용량 감소를 위한 설정
        extraHTTPHeaders: {
          "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
        },
      });

      const shouldFilterResources =
        browserConfig.blockResources.ads ||
        browserConfig.blockResources.analytics ||
        browserConfig.blockResources.socialMedia ||
        browserConfig.blockResources.unnecessaryImages;

      // 모든 frame navigation과 자격증명 입력 중 egress를 JobKorea로 제한한다.
      const browserContext = this.context;
      await browserContext.route("**/*", async route => {
        const request = route.request();
        const resourceType = request.resourceType();
        const url = request.url();

        const isNavigationRequest = request.isNavigationRequest();
        let isTopLevelFrame = false;
        let requestPage: Page | null = null;
        let frameResolved = false;
        if (isNavigationRequest) {
          try {
            const frame = request.frame();
            frameResolved = true;
            isTopLevelFrame = frame.parentFrame() === null;
            requestPage = frame.page();
          } catch {
            // Initial popup/frame requests can exist before Playwright exposes a Frame.
          }
        }
        const credentialEgressGuardArmed =
          isCredentialEgressGuardArmed(browserContext);
        if (
          shouldBlockRequest(
            url,
            isNavigationRequest,
            credentialEgressGuardArmed
          )
        ) {
          if (isTopLevelFrame && requestPage) {
            recordBlockedTopLevelNavigation(requestPage, url);
          } else if (isNavigationRequest && !frameResolved) {
            recordBlockedContextNavigation(browserContext, url);
          }
          Logger.warning(
            credentialEgressGuardArmed && !isNavigationRequest
              ? "자격증명 입력 중 외부 요청 차단"
              : "신뢰할 수 없는 frame navigation 차단",
            { url },
            "navigation"
          );
          await route.abort("blockedbyclient");
          return;
        }

        if (!shouldFilterResources) {
          await route.continue();
          return;
        }

        let shouldBlock = false;

        // 광고 차단
        if (
          browserConfig.blockResources.ads &&
          this.isKnownHostname(url, BrowserService.AD_HOSTNAMES)
        ) {
          shouldBlock = true;
        }

        // 분석 도구 차단
        if (
          browserConfig.blockResources.analytics &&
          (url.includes("google-analytics") ||
            url.includes("googletagmanager"))
        ) {
          shouldBlock = true;
        }

        // 소셜 미디어 차단
        if (
          browserConfig.blockResources.socialMedia &&
          this.isKnownHostname(url, [
            "facebook.com",
            "twitter.com",
            "instagram.com",
          ])
        ) {
          shouldBlock = true;
        }

        // 불필요한 이미지 차단
        if (
          browserConfig.blockResources.unnecessaryImages &&
          (resourceType === "media" ||
            (resourceType === "image" && !url.includes("jobkorea")))
        ) {
          shouldBlock = true;
        }

        if (shouldBlock) {
          await route.abort();
        } else {
          await route.continue();
        }
      });

      await browserContext.routeWebSocket("**/*", async webSocket => {
        if (!isTrustedJobKoreaWebSocketUrl(webSocket.url())) {
          Logger.warning(
            "신뢰할 수 없는 WebSocket 연결 차단",
            { url: webSocket.url() },
            "network"
          );
          await webSocket.close({ code: 1008, reason: "Blocked by policy" });
          return;
        }
        webSocket.connectToServer();
      });

      this.page = await browserContext.newPage();
      this.page.setDefaultNavigationTimeout(configManager.getTimeouts().navigation);
      this.page.setDefaultTimeout(configManager.getTimeouts().element);
      this.wirePageDiagnostics(this.page);

      Logger.info("브라우저 초기화 완료 (최적화 적용)");
    } catch (error) {
      Logger.error("브라우저 초기화 실패", error as Error);
      throw error;
    }
  }

  getPage(): Page {
    if (!this.page) {
      throw new Error("브라우저가 초기화되지 않았습니다.");
    }
    return this.page;
  }

  async close(): Promise<void> {
    if (this.closingPromise) {
      await this.closingPromise;
      return;
    }

    const closingPromise = this.closeResources();
    this.closingPromise = closingPromise;
    try {
      await closingPromise;
    } finally {
      if (this.closingPromise === closingPromise) {
        this.closingPromise = null;
      }
    }
  }

  private async closeResources(): Promise<void> {
    const page = this.page;
    const context = this.context;
    const browser = this.browser;
    const failedResources: string[] = [];

    // 먼저 참조를 분리해 중복 close 호출이 같은 리소스를 동시에 정리하지 않도록 한다.
    this.page = null;
    this.context = null;
    this.browser = null;

    if (page) {
      try {
        await page.close();
      } catch (error) {
        failedResources.push("page");
        Logger.error("페이지 종료 중 오류 발생", error as Error);
      }
    }

    if (context) {
      try {
        await context.close();
      } catch (error) {
        failedResources.push("context");
        Logger.error("브라우저 컨텍스트 종료 중 오류 발생", error as Error);
      }
    }

    if (browser) {
      try {
        await browser.close();
      } catch (error) {
        failedResources.push("browser");
        Logger.error("브라우저 종료 중 오류 발생", error as Error);
      }
    }

    if (failedResources.length === 0) {
      Logger.info("브라우저 종료 완료 (리소스 정리됨)");
    } else {
      Logger.warning("브라우저 종료 완료 (일부 리소스 정리 실패)", {
        failedResources,
      });
    }
  }
}
