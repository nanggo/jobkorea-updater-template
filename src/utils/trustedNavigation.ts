import type { BrowserContext, Page } from "playwright";

const blockedTopLevelNavigations = new WeakMap<Page, string>();
const blockedContextNavigations = new WeakMap<BrowserContext, string>();
const credentialEgressGuardedContexts = new WeakSet<BrowserContext>();

export function recordBlockedTopLevelNavigation(
  page: Page,
  url: string
): void {
  blockedTopLevelNavigations.set(page, url);
}

export function recordBlockedContextNavigation(
  context: BrowserContext,
  url: string
): void {
  blockedContextNavigations.set(context, url);
}

export function consumeBlockedTopLevelNavigation(
  page: Page
): string | undefined {
  const url = blockedTopLevelNavigations.get(page);
  blockedTopLevelNavigations.delete(page);
  return url;
}

export function consumeBlockedContextNavigation(
  context: BrowserContext
): string | undefined {
  const url = blockedContextNavigations.get(context);
  blockedContextNavigations.delete(context);
  return url;
}

export function armCredentialEgressGuard(context: BrowserContext): void {
  credentialEgressGuardedContexts.add(context);
}

export function disarmCredentialEgressGuard(context: BrowserContext): void {
  credentialEgressGuardedContexts.delete(context);
}

export function isCredentialEgressGuardArmed(context: BrowserContext): boolean {
  return credentialEgressGuardedContexts.has(context);
}
