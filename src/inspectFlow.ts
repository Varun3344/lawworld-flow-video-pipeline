/**
 * Read-only Flow UI inspector. Enters a project via "New project" (the reliable path),
 * then maps the prompt bar, the "+" drawer (including hidden file inputs) and any mode selector.
 * NOTHING is generated — no prompt is ever submitted, so no credits are used.
 *
 *   npx tsx src/inspectFlow.ts
 */
import fs from 'fs';
import path from 'path';
import { BrowserManager } from './browser';
import { CONFIG } from './config';

async function run(): Promise<void> {
  const ts = Date.now();
  const shot = (n: string) => path.join(CONFIG.LOGS_DIR, `ui_${ts}_${n}.png`);
  const report: Record<string, unknown> = {};
  fs.mkdirSync(CONFIG.LOGS_DIR, { recursive: true });

  const bm = new BrowserManager({ headless: false });
  const { page } = await bm.init();

  const dump = async () => page.evaluate(() =>
    Array.from(document.querySelectorAll('button, a, input, [role="button"], [role="tab"], [role="menuitem"], [role="option"], label, video'))
      .map(el => {
        const r = (el as HTMLElement).getBoundingClientRect();
        return {
          tag: el.tagName.toLowerCase(),
          text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 70),
          aria: el.getAttribute('aria-label'),
          type: el.getAttribute('type'),
          accept: el.getAttribute('accept'),
          cls: (typeof (el as HTMLElement).className === 'string' ? (el as HTMLElement).className : '').slice(0, 90),
          visible: r.width > 0 && r.height > 0,
          box: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
        };
      })
      .filter(e => e.visible || e.tag === 'input')
  );

  const fileInputs = async () => page.evaluate(() =>
    Array.from(document.querySelectorAll('input[type="file"]')).map(i => ({
      accept: i.getAttribute('accept'),
      multiple: (i as HTMLInputElement).multiple,
      id: i.id,
      cls: (i as HTMLElement).className.slice(0, 90),
      parentText: (i.parentElement?.textContent || '').trim().slice(0, 70)
    }))
  );

  console.log(`[UI] Opening ${CONFIG.FLOW_URL}`);
  await page.goto(CONFIG.FLOW_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('text=Loading...', { state: 'hidden', timeout: 90000 }).catch(() => {});
  await page.waitForTimeout(3000);

  // Use the exact selector list the working automation uses
  const findFirst = async (sels: string[], timeout = 4000): Promise<string | null> => {
    for (const s of sels) {
      const el = await page.waitForSelector(s, { state: 'visible', timeout }).catch(() => null);
      if (el) return s;
    }
    return null;
  };

  let promptSel = await findFirst(CONFIG.SELECTORS.PROMPT_INPUT, 3000);
  if (!promptSel) {
    const np = await findFirst(CONFIG.SELECTORS.NEW_PROJECT_BTN, 4000);
    console.log(`[UI] New-project button: ${np || 'not found'}`);
    if (np) {
      await page.click(np).catch(() => {});
      await page.waitForTimeout(4000);
    }
    promptSel = await findFirst(CONFIG.SELECTORS.PROMPT_INPUT, 8000);
  }
  if (!promptSel) {
    await page.screenshot({ path: shot('0_no_prompt') });
    console.log('[UI] Prompt box not found. Open a project in the browser — waiting 2 minutes...');
    for (let i = 0; i < 24 && !promptSel; i++) {
      promptSel = await findFirst(CONFIG.SELECTORS.PROMPT_INPUT, 2000);
    }
  }
  if (!promptSel) throw new Error('Could not reach a project page');
  console.log(`[UI] Prompt box matched: ${promptSel}`);
  report.promptSelector = promptSel;
  await page.waitForTimeout(2000);
  report.projectUrl = page.url();
  console.log(`[UI] Inside project: ${page.url()}`);

  // A. Prompt bar as-is (mode pills, Agent button, settings pill)
  await page.screenshot({ path: shot('1_prompt_bar') });
  report.promptBar = await dump();
  report.fileInputs_initial = await fileInputs();

  // B. Open the ingredients drawer (button renders the icon ligature "add", aria-label is the reliable hook)
  const addBtn = await page.$('button[aria-label="Add ingredients to the prompt box"], button[aria-label*="ingredient" i], button[aria-label*="Add" i]');
  const opened = !!addBtn;
  if (addBtn) await addBtn.click().catch(() => {});
  console.log(`[UI] ingredients drawer clicked: ${opened}`);
  await page.waitForTimeout(2000);
  await page.screenshot({ path: shot('2_plus_drawer') });
  report.drawer = await dump();
  report.fileInputs_drawer = await fileInputs();

  // C. Walk every tab inside the drawer and record file inputs per tab
  const tabTexts = ['Upload', 'Frames', 'Frame', 'Images', 'Image', 'Avatars', 'Characters', 'Scenes', 'Media', 'Assets', 'Ingredients', 'Gallery'];
  const tabs: Record<string, unknown> = {};
  for (const t of tabTexts) {
    const el = await page.$(`.cdk-overlay-container :text-is("${t}"), div[role="dialog"] :text-is("${t}"), button:has-text("${t}")`);
    if (!el) continue;
    const vis = await el.isVisible().catch(() => false);
    if (!vis) continue;
    await el.click().catch(() => {});
    await page.waitForTimeout(1200);
    await page.screenshot({ path: shot(`3_tab_${t}`) });
    tabs[t] = { fileInputs: await fileInputs(), ui: await dump() };
    console.log(`[UI] Tab "${t}": ${(tabs[t] as any).fileInputs.length} file input(s)`);
  }
  report.tabs = tabs;
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(800);

  // D. Mode selector near the settings pill (text-to-video / frames-to-video / ingredients)
  const pill = await page.$('button:has-text("Video"), button:has-text("720p"), button:has-text("10s")');
  if (pill) {
    await pill.click().catch(() => {});
    await page.waitForTimeout(1500);
    await page.screenshot({ path: shot('4_settings_pill') });
    report.settingsPanel = await dump();
    await page.keyboard.press('Escape').catch(() => {});
  }

  const out = path.join(CONFIG.LOGS_DIR, `ui_${ts}.json`);
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`[UI] Report: ${out}`);
  console.log(`[UI] file inputs -> initial:${(report.fileInputs_initial as unknown[]).length} drawer:${(report.fileInputs_drawer as unknown[]).length}`);
  console.log('[UI] Nothing was generated. No credits used.');
  await bm.close();
}

run().catch(err => { console.error('[UI] failed:', err.message); process.exit(1); });
