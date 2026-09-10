/**
 * Opens the pinned project, stops any running Agent activity, reports the "Agent" chip state and screenshots.
 * No generation, no credits.   npx tsx src/stopAgent.ts
 */
import fs from 'fs';
import { BrowserManager } from './browser';
import { CONFIG } from './config';

async function run(): Promise<void> {
  const cfg = JSON.parse(fs.readFileSync('storyboard.json', 'utf-8'));
  const url: string = cfg.flowProjectUrl;
  if (!url) throw new Error('storyboard.flowProjectUrl is not set');

  const bm = new BrowserManager({ headless: false });
  const { page } = await bm.init();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('text=Loading...', { state: 'hidden', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(4000);

  const stop = await page.$('button:has-text("Stop"), [aria-label*="Stop" i]');
  console.log(`[Agent] Stop button present: ${!!stop}`);
  if (stop && await stop.isVisible().catch(() => false)) {
    await stop.click().catch(() => {});
    await page.waitForTimeout(1500);
    console.log('[Agent] Clicked Stop.');
  }

  const chip = await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find(x => (x.textContent || '').trim() === 'Agent');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { pressed: b.getAttribute('aria-pressed'), aria: b.getAttribute('aria-label'), cls: b.className.slice(0, 120), x: Math.round(r.x), y: Math.round(r.y),
      bg: getComputedStyle(b).backgroundColor, color: getComputedStyle(b).color };
  });
  console.log(`[Agent] chip: ${JSON.stringify(chip)}`);
  const thinking = await page.$(':text-is("Thinking...")');
  console.log(`[Agent] still thinking: ${!!thinking}`);

  await page.screenshot({ path: `${CONFIG.LOGS_DIR}/agent_state.png` });
  console.log(`[Agent] screenshot: ${CONFIG.LOGS_DIR}/agent_state.png`);
  await bm.close();
}

run().catch(err => { console.error('[Agent] failed:', err.message); process.exit(1); });
