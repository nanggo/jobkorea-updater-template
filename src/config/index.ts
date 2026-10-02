// src/config/index.ts
export interface AppConfig {
  // URL 설정
  urls: {
    login: string;
    mypage: string;
  };

  // CSS 셀렉터 설정 (fallback 포함)
  selectors: {
    login: {
      form: readonly string[];
      idInput: readonly string[];
      passwordInput: readonly string[];
      loginButton: readonly string[];
    };
    mypage: {
      statusLink: readonly string[];
      updateButton: readonly string[];
    };
  };

  // 타임아웃 설정
  timeouts: {
    navigation: number;
    element: number;
    popup: number;
    telegram: number;
    telegramOverall: number;
  };

  // 재시도 설정
  retry: {
    maxOperationRetries: number;
    maxProcessRetries: number;
    baseDelay: number;
    maxDelay: number;
    backoffMultiplier: number;
  };

  // 브라우저 설정
  browser: {
    headless: boolean;
    viewport: {
      width: number;
      height: number;
    };
    args: readonly string[];
    blockResources: {
      ads: boolean;
      analytics: boolean;
      socialMedia: boolean;
      unnecessaryImages: boolean;
    };
  };

  // 로깅 설정
  logging: {
    enableSensitiveDataMasking: boolean;
    logLevel: "error" | "warn" | "info" | "debug";
    includeTimestamp: boolean;
  };

  // 업데이트 검증 설정
  update: {
    successPatterns: readonly string[];
  };

  // 보안 설정
  security: {
    maskSensitiveInfo: boolean;
  };

  diagnostics: {
    captureFailureArtifacts: boolean;
  };
}

export const defaultConfig: AppConfig = {
  urls: {
    login: "https://www.jobkorea.co.kr/Login/",
    mypage: "https://www.jobkorea.co.kr/User/Mypage",
  },

  selectors: {
    login: {
      form: ["form"],
      idInput: [
        "input.input-id",
        "input#user_id",
        'input[name="user_id"]',
      ],
      passwordInput: [
        "input.input-password",
        "input#user_pwd",
        'input[name="user_pwd"]',
      ],
      loginButton: [
        "button.login-button",
        "button#login_btn",
        "button.btn-login",
        'button[type="submit"]',
        "input.login-button",
        "input#login_btn",
        "input.btn-login",
        'input[type="submit"]',
      ],
    },
    mypage: {
      statusLink: [".status a", ".my-status a", 'a[href*="status"]', ".resume-status a"],
      updateButton: [
        ".button-update",
        ".btn-update",
        'button[onclick*="update"]',
        ".update-btn",
      ],
    },
  },

  timeouts: {
    navigation: 20000,
    element: 15000,
    popup: 10000,
    telegram: 10000,
    telegramOverall: 60000,
  },

  retry: {
    maxOperationRetries: 3,
    maxProcessRetries: 3,
    baseDelay: 2000,
    maxDelay: 10000,
    backoffMultiplier: 2,
  },

  browser: {
    headless: true,
    viewport: {
      width: 1280,
      height: 720,
    },
    args: [
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--no-first-run",
      "--disable-gpu",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--memory-pressure-off",
    ],
    blockResources: {
      ads: true,
      analytics: true,
      socialMedia: true,
      unnecessaryImages: true,
    },
  },

  logging: {
    enableSensitiveDataMasking: true,
    logLevel: "info",
    includeTimestamp: true,
  },

  update: {
    successPatterns: [
      "이력서 수정일이 오늘날짜로 업데이트 되었습니다",
      "이력서 수정일이 오늘날짜로 업데이트되었습니다",
      "이력서 수정일이 오늘 날짜로 업데이트되었습니다",
    ],
  },

  security: {
    maskSensitiveInfo: true,
  },

  diagnostics: {
    captureFailureArtifacts: false,
  },
};

function loadEnvironmentOverrides(baseConfig: AppConfig): AppConfig {
  const config: AppConfig = {
    ...baseConfig,
    urls: { ...baseConfig.urls },
    timeouts: { ...baseConfig.timeouts },
    retry: { ...baseConfig.retry },
    browser: { ...baseConfig.browser },
    logging: { ...baseConfig.logging },
    diagnostics: { ...baseConfig.diagnostics },
  };

  const readPositiveInt = (
    name: string,
    maximum: number
  ): number | undefined => {
    const value = process.env[name];
    if (!value) return undefined;

    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= maximum
      ? parsed
      : undefined;
  };

  const readPositiveFloat = (
    name: string,
    maximum: number
  ): number | undefined => {
    const value = process.env[name];
    if (!value) return undefined;

    const parsed = Number(value);
    return !isNaN(parsed) && parsed > 0 && parsed <= maximum
      ? parsed
      : undefined;
  };

  const readBoolean = (name: string): boolean | undefined => {
    const value = process.env[name]?.toLowerCase();
    if (value === "true") return true;
    if (value === "false") return false;
    return undefined;
  };

  if (process.env.JOBKOREA_LOGIN_URL) {
    config.urls.login = process.env.JOBKOREA_LOGIN_URL;
  }

  if (process.env.JOBKOREA_MYPAGE_URL) {
    config.urls.mypage = process.env.JOBKOREA_MYPAGE_URL;
  }

  const browserHeadless = readBoolean("BROWSER_HEADLESS");
  if (browserHeadless !== undefined) {
    config.browser.headless = browserHeadless;
  }

  const navigationTimeout = readPositiveInt("NAVIGATION_TIMEOUT_MS", 120000);
  if (navigationTimeout) {
    config.timeouts.navigation = navigationTimeout;
  }

  const elementTimeout = readPositiveInt("ELEMENT_TIMEOUT_MS", 60000);
  if (elementTimeout) {
    config.timeouts.element = elementTimeout;
  }

  const popupTimeout = readPositiveInt("POPUP_TIMEOUT_MS", 60000);
  if (popupTimeout) {
    config.timeouts.popup = popupTimeout;
  }

  const telegramTimeout = readPositiveInt("TELEGRAM_TIMEOUT_MS", 60000);
  if (telegramTimeout) {
    config.timeouts.telegram = telegramTimeout;
  }

  const telegramOverallTimeout = readPositiveInt(
    "TELEGRAM_OVERALL_TIMEOUT_MS",
    300000
  );
  if (telegramOverallTimeout) {
    config.timeouts.telegramOverall = telegramOverallTimeout;
  }

  if (process.env.MAX_RETRIES) {
    const maxRetries = readPositiveInt("MAX_RETRIES", 10);
    if (maxRetries) {
      config.retry.maxOperationRetries = maxRetries;
      config.retry.maxProcessRetries = maxRetries;
    }
  }

  const maxOperationRetries = readPositiveInt("MAX_OPERATION_RETRIES", 10);
  if (maxOperationRetries) {
    config.retry.maxOperationRetries = maxOperationRetries;
  }

  const maxProcessRetries = readPositiveInt("MAX_PROCESS_RETRIES", 10);
  if (maxProcessRetries) {
    config.retry.maxProcessRetries = maxProcessRetries;
  }

  const retryBaseDelay = readPositiveInt("RETRY_BASE_DELAY_MS", 300000);
  if (retryBaseDelay) {
    config.retry.baseDelay = retryBaseDelay;
  }

  const retryMaxDelay = readPositiveInt("RETRY_MAX_DELAY_MS", 300000);
  if (retryMaxDelay) {
    config.retry.maxDelay = retryMaxDelay;
  }

  const retryBackoffMultiplier = readPositiveFloat(
    "RETRY_BACKOFF_MULTIPLIER",
    10
  );
  if (retryBackoffMultiplier) {
    config.retry.backoffMultiplier = retryBackoffMultiplier;
  }

  if (process.env.LOG_LEVEL && ["error", "warn", "info", "debug"].includes(process.env.LOG_LEVEL)) {
    config.logging.logLevel = process.env.LOG_LEVEL as "error" | "warn" | "info" | "debug";
  }

  const captureFailureArtifacts = readBoolean("CAPTURE_FAILURE_ARTIFACTS");
  if (captureFailureArtifacts !== undefined) {
    config.diagnostics.captureFailureArtifacts = captureFailureArtifacts;
  }

  return config;
}

const appConfig = loadEnvironmentOverrides(defaultConfig);

export const configManager = {
  getConfig(): AppConfig {
    return appConfig;
  },

  getUrls() {
    return appConfig.urls;
  },

  getSelectors() {
    return appConfig.selectors;
  },

  getTimeouts() {
    return appConfig.timeouts;
  },

  getRetryConfig() {
    return appConfig.retry;
  },

  getBrowserConfig() {
    return appConfig.browser;
  },

  getLoggingConfig() {
    return appConfig.logging;
  },

  getUpdateConfig() {
    return appConfig.update;
  },

  getSecurityConfig() {
    return appConfig.security;
  },

  getDiagnosticsConfig() {
    return appConfig.diagnostics;
  },
};

export default configManager;
