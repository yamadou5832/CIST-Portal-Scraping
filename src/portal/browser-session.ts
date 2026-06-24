import { promises as fs } from "node:fs";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

import type { AppConfig } from "../config.js";
import type { PortalUserCredentials } from "../auth/types.js";
import { normalizeUrl } from "./url-utils.js";

export class PortalBrowserSession {
  private browser: Browser | null = null;

  constructor(
    private readonly config: Pick<AppConfig, "portalUrl" | "headless">,
    private readonly credentials: PortalUserCredentials,
    private readonly storageStatePath: string,
  ) {}

  get portalUrl(): string {
    return this.config.portalUrl;
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  async withAuthenticatedPage<T>(handler: (page: Page) => Promise<T>): Promise<T> {
    const browser = await this.ensureBrowser();
    const context = await this.newContext(browser);
    const page = await context.newPage();

    try {
      await this.ensureLoggedIn(page, context);
      await page.goto(this.targetUrl, { waitUntil: "domcontentloaded" });
      return await handler(page);
    } finally {
      await context.close();
    }
  }

  private async ensureBrowser(): Promise<Browser> {
    if (!this.browser) {
      this.browser = await chromium.launch({ headless: this.config.headless });
    }
    return this.browser;
  }

  private async newContext(browser: Browser): Promise<BrowserContext> {
    const hasState = await this.pathExists(this.storageStatePath);
    if (hasState) {
      return browser.newContext({ storageState: this.storageStatePath });
    }
    return browser.newContext();
  }

  private async ensureLoggedIn(page: Page, context: BrowserContext): Promise<void> {
    await page.goto(this.targetUrl, { waitUntil: "domcontentloaded" });

    const target = normalizeUrl(this.targetUrl);
    const login = normalizeUrl(this.loginUrl);
    let current = normalizeUrl(page.url());

    if (current === target) {
      await this.persistStorageState(context);
      return;
    }

    if (current.startsWith(login)) {
      current = await this.tryLogin(page, this.credentials.cistUserId);
    }

    if (current !== target) {
      throw new Error(`Failed to login with stored CIST account userId. currentUrl=${page.url()}`);
    }

    await this.persistStorageState(context);
  }

  private async persistStorageState(context: BrowserContext): Promise<void> {
    await fs.mkdir(path.dirname(this.storageStatePath), { recursive: true });
    await context.storageState({ path: this.storageStatePath });
  }

  private async pathExists(targetPath: string): Promise<boolean> {
    try {
      await fs.access(targetPath);
      return true;
    } catch {
      return false;
    }
  }

  private async tryLogin(page: Page, loginId: string): Promise<string> {
    const usernameInput = page.locator("#username");
    const passwordInput = page.locator("#password");
    const loginButton = page.locator("#login");

    await usernameInput.waitFor({ state: "visible", timeout: 15000 });
    await usernameInput.fill(loginId);
    await passwordInput.fill(this.credentials.cistPassword);

    await Promise.all([
      page.waitForURL((url) => normalizeUrl(url.toString()) === normalizeUrl(this.targetUrl), { timeout: 15000 }).catch(() => undefined),
      loginButton.click(),
    ]);

    let current = normalizeUrl(page.url());
    if (current !== normalizeUrl(this.targetUrl)) {
      await page.goto(this.targetUrl, { waitUntil: "domcontentloaded" });
      current = normalizeUrl(page.url());
    }
    return current;
  }

  private get targetUrl(): string {
    return `${this.config.portalUrl}/portal/MyPage`;
  }

  private get loginUrl(): string {
    return `${this.config.portalUrl}/portal`;
  }
}
