const JOBKOREA_ROOT_HOSTNAME = "jobkorea.co.kr";

function hasTrustedJobKoreaAuthority(
  value: string,
  protocol: "https:" | "wss:"
): boolean {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    const isTrustedHostname =
      hostname === JOBKOREA_ROOT_HOSTNAME ||
      hostname.endsWith(`.${JOBKOREA_ROOT_HOSTNAME}`);

    return (
      url.protocol === protocol &&
      (url.port === "" || url.port === "443") &&
      url.username === "" &&
      url.password === "" &&
      isTrustedHostname
    );
  } catch {
    return false;
  }
}

export function isTrustedJobKoreaUrl(value: string): boolean {
  return hasTrustedJobKoreaAuthority(value, "https:");
}

export function isTrustedJobKoreaWebSocketUrl(value: string): boolean {
  return hasTrustedJobKoreaAuthority(value, "wss:");
}

export function requireTrustedJobKoreaUrl(value: string, label: string): URL {
  if (!isTrustedJobKoreaUrl(value)) {
    throw new Error(
      `${label}은(는) HTTPS JobKorea 도메인이어야 합니다: ${value}`
    );
  }

  return new URL(value);
}

export function isJobKoreaLoginPath(value: string | URL): boolean {
  try {
    const url = value instanceof URL ? value : new URL(value);
    return /^\/login(?:\/|$)/i.test(url.pathname);
  } catch {
    return false;
  }
}

// ID/password recovery pages, where JobKorea sends a login it will not complete,
// such as one that must change its password first.
export function isJobKoreaAccountRecoveryPath(value: string | URL): boolean {
  try {
    const url = value instanceof URL ? value : new URL(value);
    return /^\/login\/search(?:\/|$)/i.test(url.pathname);
  } catch {
    return false;
  }
}
