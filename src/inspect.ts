import readline from 'readline';
import fs from 'fs';
import path from 'path';
import { BrowserManager } from './browser';
import { CONFIG } from './config';

async function runInspect(): Promise<void> {
  console.log(`======================================================`);
  console.log(` Google Flow AI Video - Workspace Inspector Utility`);
  console.log(`======================================================\n`);

  console.log(`[INFO] Launching Browser with profile from: ${CONFIG.USER_DATA_DIR}`);
  const browserManager = new BrowserManager({ headless: false });
  const { page } = await browserManager.init();

  console.log(`[INFO] Navigating to Google Flow (${CONFIG.FLOW_URL})...`);
  await page.goto(CONFIG.FLOW_URL, { waitUntil: 'domcontentloaded' });

  console.log(`\n------------------------------------------------------`);
  console.log(` INSTRUCTIONS:`);
  console.log(` 1. The browser window is now open on your screen.`);
  console.log(` 2. Please manually click your Avatar and Video Size (9:16).`);
  console.log(` 3. Once you finish clicking, return here and press ENTER.`);
  console.log(`    The script will capture the exact DOM selectors for automation!`);
  console.log(`------------------------------------------------------\n`);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  await new Promise<void>((resolve) => {
    rl.question('[INFO] Press ENTER here after you finish your manual clicks... ', () => {
      rl.close();
      resolve();
    });
  });

  // Capture DOM snapshot and screenshot
  try {
    const logsDir = CONFIG.LOGS_DIR;
    if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

    const screenshotPath = path.join(logsDir, 'inspect_user_clicks.png');
    await page.screenshot({ path: screenshotPath, fullPage: true });

    const domSummary = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button, div[role="button"], a, input, select')).map(el => ({
        tagName: el.tagName,
        text: el.textContent?.trim().substring(0, 50),
        ariaLabel: el.getAttribute('aria-label'),
        className: el.className,
        id: el.id
      }));
      return buttons;
    });

    fs.writeFileSync(path.join(logsDir, 'inspect_dom_summary.json'), JSON.stringify(domSummary, null, 2));

    console.log(`\n[SUCCESS] Captured UI snapshot to: ${screenshotPath}`);
    console.log(`[SUCCESS] Saved DOM elements to: logs/inspect_dom_summary.json`);
  } catch (err) {
    console.warn(`[Warning] Could not capture inspect snapshot: ${(err as Error).message}`);
  }

  await browserManager.close();
  console.log('[INFO] Inspector closed cleanly.');
}

runInspect().catch((err) => {
  console.error('[Error] Inspector failed:', err.message);
  process.exit(1);
});
