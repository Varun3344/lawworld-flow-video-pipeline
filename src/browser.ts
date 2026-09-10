import { chromium, BrowserContext, Page } from 'playwright';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { CONFIG } from './config';

/**
 * Playwright pins one Chromium revision per release and refuses to install any browser on macOS 13
 * ("Playwright does not support chromium on mac13"), so its pinned revision is never downloaded here.
 * An already-cached older build runs fine (verified: revision 1223 / Chrome 148 on macOS 13.7.8), so fall
 * back to the newest complete build in the Playwright cache. PLAYWRIGHT_CHROMIUM_PATH overrides.
 * Returns undefined on other platforms so Playwright keeps using its own default.
 */
/**
 * Prefer the real Google Chrome installed on this machine over Playwright's "Chrome for Testing" build.
 * Google's own sign-in and Flow behave better in real Chrome, and it avoids the bundled build entirely.
 * Note this is the Chrome *binary* only — the automation still uses its own profile directory, never the
 * user's personal Chrome profile, because Chrome locks a profile while the user's browser is open and
 * automating a live profile would put their signed-in sessions at risk.
 */
function resolveChromeChannel(): string | undefined {
  if (process.env.PLAYWRIGHT_NO_CHROME_CHANNEL) return undefined;
  const candidates = process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app']
    : process.platform === 'win32'
      ? ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
         'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe']
      : ['/usr/bin/google-chrome', '/opt/google/chrome/chrome'];
  return candidates.some(p => fs.existsSync(p)) ? 'chrome' : undefined;
}

function resolveChromiumExecutable(): string | undefined {
  const override = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  if (override) {
    if (fs.existsSync(override)) return override;
    console.warn(`[Browser] PLAYWRIGHT_CHROMIUM_PATH is set but does not exist: ${override}`);
  }
  if (process.platform !== 'darwin') return undefined;

  const cacheDir = path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
  if (!fs.existsSync(cacheDir)) return undefined;

  const builds = fs.readdirSync(cacheDir)
    .filter(name => /^chromium-\d+$/.test(name))
    .map(name => ({ name, revision: parseInt(name.split('-')[1], 10) }))
    .sort((a, b) => b.revision - a.revision);

  for (const build of builds) {
    for (const arch of ['chrome-mac-x64', 'chrome-mac-arm64', 'chrome-mac']) {
      const exe = path.join(cacheDir, build.name, arch,
        'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
      if (fs.existsSync(exe)) return exe;
    }
  }
  return undefined;
}

export interface BrowserManagerOptions {
  userDataDir?: string;
  headless?: boolean;
  slowMo?: number;
}

export class BrowserManager {
  private userDataDir: string;
  private headless: boolean;
  private slowMo: number;
  private context: BrowserContext | null = null;
  private mainPage: Page | null = null;

  constructor(options: BrowserManagerOptions = {}) {
    this.userDataDir = options.userDataDir || CONFIG.USER_DATA_DIR;
    this.headless = options.headless !== undefined ? options.headless : false;
    this.slowMo = options.slowMo !== undefined ? options.slowMo : CONFIG.SLOW_MO;

    // Ensure persistent user_data directory exists
    if (!fs.existsSync(this.userDataDir)) {
      fs.mkdirSync(this.userDataDir, { recursive: true });
    }
  }

  /**
   * Initializes persistent Playwright browser context
   */
  public async init(): Promise<{ context: BrowserContext; page: Page }> {
    console.log(`[Browser] Launching Chromium (Headless: ${this.headless}) with profile at: ${this.userDataDir}`);

    // channel and executablePath are mutually exclusive: real Chrome wins, cached Chromium is the fallback.
    const channel = resolveChromeChannel();
    const executablePath = channel ? undefined : resolveChromiumExecutable();
    if (channel) {
      console.log(`[Browser] Using your installed Google Chrome (channel: ${channel}), with its own profile dir.`);
    } else if (executablePath) {
      console.log(`[Browser] Using cached Chromium: ${executablePath.replace(os.homedir(), '~')}`);
    }

    this.context = await chromium.launchPersistentContext(this.userDataDir, {
      headless: this.headless,
      ...(channel ? { channel } : {}),
      ...(executablePath ? { executablePath } : {}),
      slowMo: this.slowMo,
      viewport: CONFIG.VIEWPORT,
      args: CONFIG.STEALTH_ARGS,
      acceptDownloads: true
    });

    const pages = this.context.pages();
    this.mainPage = pages.length > 0 ? pages[0] : await this.context.newPage();

    // Prevent automation detection flag override
    await this.mainPage.addInitScript(() => {
      Object.defineProperty((window as any).navigator, 'webdriver', { get: () => undefined });
    });

    return { context: this.context, page: this.mainPage };
  }

  /**
   * Gets the active page
   */
  public getPage(): Page {
    if (!this.mainPage) {
      throw new Error('[Browser] Browser context not initialized. Call init() first.');
    }
    return this.mainPage;
  }

  /**
   * Gets the active context
   */
  public getContext(): BrowserContext {
    if (!this.context) {
      throw new Error('[Browser] Browser context not initialized. Call init() first.');
    }
    return this.context;
  }

  /**
   * Gracefully closes browser
   */
  public async close(): Promise<void> {
    if (this.context) {
      console.log('[Browser] Closing persistent browser context...');
      await this.context.close();
      this.context = null;
      this.mainPage = null;
    }
  }
}
