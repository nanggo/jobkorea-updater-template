import { createHash, randomUUID } from "node:crypto";
import { constants, Stats } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import * as path from "node:path";
import type { BrowserContext } from "playwright";
import { AuthenticationError } from "../types";
import { isTrustedJobKoreaUrl } from "../utils/jobkoreaUrl";

type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;
const MAX_STATE_BYTES = 5 * 1024 * 1024;

function stateError(message: string): AuthenticationError {
  return new AuthenticationError(`인증 상태 ${message}`);
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

// Persist only JobKorea cookies and localStorage, never third-party tracking state.
// Rebuild the shape so malformed files cannot make Playwright log secret values.
export function jobKoreaStorageState(value: unknown): StorageState {
  const raw = value as StorageState;
  if (!raw || !Array.isArray(raw.cookies) || !Array.isArray(raw.origins)) {
    throw stateError("파일 형식이 올바르지 않습니다. 다시 인증하세요.");
  }
  const cookies = raw.cookies.filter(cookie => {
    if (!cookie || typeof cookie.domain !== "string") throw stateError("쿠키 형식이 올바르지 않습니다.");
    const domain = cookie.domain.replace(/^\./, "");
    return /^[a-z0-9.-]+$/i.test(domain) && isTrustedJobKoreaUrl(`https://${domain}/`);
  }).map(cookie => {
    if (
      typeof cookie.name !== "string" || typeof cookie.value !== "string" ||
      typeof cookie.path !== "string" || !cookie.path.startsWith("/") ||
      !Number.isFinite(cookie.expires) || typeof cookie.httpOnly !== "boolean" ||
      typeof cookie.secure !== "boolean" || !["Strict", "Lax", "None"].includes(cookie.sameSite)
    ) throw stateError("쿠키 형식이 올바르지 않습니다.");
    return {
      name: cookie.name, value: cookie.value, domain: cookie.domain,
      path: cookie.path, expires: cookie.expires, httpOnly: cookie.httpOnly,
      secure: cookie.secure, sameSite: cookie.sameSite,
    };
  });
  const origins = raw.origins.filter(origin => {
    if (!origin || typeof origin.origin !== "string") throw stateError("origin 형식이 올바르지 않습니다.");
    return isTrustedJobKoreaUrl(origin.origin);
  }).map(origin => {
    if (new URL(origin.origin).origin !== origin.origin || !Array.isArray(origin.localStorage)) {
      throw stateError("origin 형식이 올바르지 않습니다.");
    }
    const localStorage = origin.localStorage.map(item => {
      if (!item || typeof item.name !== "string" || typeof item.value !== "string") {
        throw stateError("localStorage 형식이 올바르지 않습니다.");
      }
      return { name: item.name, value: item.value };
    });
    return { origin: origin.origin, localStorage };
  });
  return { cookies, origins };
}

export class AuthStateStore {
  private readonly directory: string;
  private readonly account: string;
  // Both src/services and the production dist/services live two levels below
  // the checkout. Use the module location, not the caller's working directory.
  private readonly checkout = path.resolve(__dirname, "../..");

  constructor(directory: string, accountId: string) {
    if (!path.isAbsolute(directory) || !accountId.trim()) {
      throw stateError("저장에는 절대 경로와 JOBKOREA_ID가 필요합니다.");
    }
    this.directory = path.resolve(directory);
    this.assertOutsideCheckout(this.directory, this.checkout);
    this.account = createHash("sha256").update(accountId).digest("hex");
  }

  private assertOutsideCheckout(directory: string, checkout: string): void {
    const relative = path.relative(checkout, directory);
    if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
      throw stateError("디렉터리는 저장소 밖에 두어야 합니다.");
    }
  }

  private assertPrivate(stats: Stats): void {
    if (
      stats.isSymbolicLink() || (stats.mode & 0o077) !== 0 ||
      (process.getuid && stats.uid !== process.getuid())
    ) throw stateError("경로는 현재 사용자만 접근할 수 있어야 합니다 (디렉터리 700, 파일 600).");
  }

  private async checkedDirectory(create: boolean): Promise<string | undefined> {
    const checkout = await realpath(this.checkout);
    this.assertOutsideCheckout(this.directory, checkout);
    if (create) await mkdir(this.directory, { recursive: true, mode: 0o700 });
    let stats;
    try {
      stats = await lstat(this.directory);
    } catch (error) {
      if (isMissing(error) && !create) return undefined;
      throw error;
    }
    this.assertPrivate(stats);
    if (!stats.isDirectory()) throw stateError("경로가 디렉터리가 아닙니다.");
    const directory = await realpath(this.directory);
    this.assertOutsideCheckout(directory, checkout);
    return directory;
  }

  async load(): Promise<StorageState | undefined> {
    try {
      const directory = await this.checkedDirectory(false);
      if (!directory) return undefined;
      let file;
      try {
        file = await open(path.join(directory, "state.json"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      } catch (error) {
        if (isMissing(error)) return undefined;
        throw error;
      }
      try {
        const stats = await file.stat();
        this.assertPrivate(stats);
        if (!stats.isFile() || stats.nlink !== 1 || stats.size > MAX_STATE_BYTES) throw stateError("파일이 올바르지 않습니다.");
        let data;
        try {
          data = JSON.parse(await file.readFile("utf8"));
        } catch {
          throw stateError("파일을 해석할 수 없습니다. 다시 인증하세요.");
        }
        if (data?.version !== 1 || data.account !== this.account) {
          throw stateError("파일의 버전 또는 계정이 일치하지 않습니다. 해당 계정으로 다시 인증하세요.");
        }
        return jobKoreaStorageState(data.state);
      } finally {
        await file.close();
      }
    } catch (error) {
      if (error instanceof AuthenticationError) throw error;
      throw stateError("파일을 읽을 수 없습니다. 경로와 접근 권한을 확인하세요.");
    }
  }

  async save(state: StorageState): Promise<void> {
    let temporary: string | undefined;
    try {
      const data = JSON.stringify({ version: 1, account: this.account, state: jobKoreaStorageState(state) });
      if (Buffer.byteLength(data) > MAX_STATE_BYTES) throw stateError("파일 크기 제한을 초과했습니다.");
      const directory = (await this.checkedDirectory(true))!;
      const destination = path.join(directory, "state.json");
      try {
        const stats = await lstat(destination);
        this.assertPrivate(stats);
        if (!stats.isFile() || stats.nlink !== 1) throw stateError("파일이 올바르지 않습니다.");
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      temporary = path.join(directory, `.state-${randomUUID()}.tmp`);
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(data, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, destination);
      temporary = undefined;
    } catch (error) {
      if (error instanceof AuthenticationError) throw error;
      throw stateError("파일을 저장할 수 없습니다. 경로와 접근 권한을 확인하세요.");
    } finally {
      if (temporary) await unlink(temporary).catch(() => undefined);
    }
  }
}
