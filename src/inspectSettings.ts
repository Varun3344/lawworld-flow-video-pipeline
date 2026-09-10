/**
 * Read-only probe of the Flow generation-settings popup: model, resolution, duration and quantity.
 * The existing --attach-test dumps the tile menu instead, which is why the model options were never visible.
 * NOTHING is submitted — no prompt is ever sent, so no credits are used.
 *
 *   npx tsx src/inspectSettings.ts --config storyboard_newformat_case1.json
 */
import fs from 'fs';
import path from 'path';
import { BrowserManager } from './browser';
import { CONFIG } from './config';

const args = process.argv.slice(2);
const ci = args.indexOf('--config');
const configPath = path.resolve(process.cwd(), ci >= 0 && args[ci + 1] ? args[ci + 1] : 'storyboard.json');
const projectUrl: string = (JSON.parse(fs.readFileSync(configPath, 'utf-8')).flowProjectUrl) || '';

async function run(): Promise<void> {
  if (!projectUrl) { console.error('[Probe] No flowProjectUrl in the config.'); process.exit(1); }
  const ts = Date.now();
  fs.mkdirSync(CONFIG.LOGS_DIR, { recursive: true });
  const bm = new BrowserManager({ headless: false });
  const { page } = await bm.init();

  console.log(`[Probe] Opening ${projectUrl}`);
  await page.goto(projectUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(6000);

  // Open the settings pill ("Video · 720p · 10s ..."), not the per-tile "more options" menu.
  const opened = await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll('button'))
      .find(b => /Video\s*·/.test(b.textContent || '') || (b.getAttribute('aria-label') || '') === 'Settings trigger');
    if (!el) return false;
    (el as HTMLElement).click();
    return true;
  }).catch(() => false);
  console.log(`[Probe] Settings pill opened: ${opened ? 'YES' : 'NO'}`);
  await page.waitForTimeout(2000);

  // Dump every small visible control in the popup — model names, resolutions, durations, quantities.
  const entries = await page.evaluate(() => {
    const out: { text: string; aria: string | null; checked: string | null; disabled: boolean }[] = [];
    document.querySelectorAll('button, [role="option"], [role="radio"], [role="menuitem"], [role="menuitemradio"], li, label')
      .forEach(e => {
        const r = (e as HTMLElement).getBoundingClientRect();
        const t = (e.textContent || '').trim().replace(/\s+/g, ' ');
        if (r.width > 0 && r.height > 0 && r.width < 520 && t && t.length < 90)
          out.push({
            text: t,
            aria: e.getAttribute('aria-label'),
            checked: e.getAttribute('aria-checked') || e.getAttribute('aria-selected'),
            disabled: (e as HTMLButtonElement).disabled === true || e.getAttribute('aria-disabled') === 'true'
          });
      });
    return out.filter((v, i, a) => a.findIndex(x => x.text === v.text) === i);
  }).catch(() => []);

  console.log(`\n[Probe] ${entries.length} visible controls in/around the settings popup:`);
  for (const e of entries) {
    const marks = [e.checked === 'true' ? 'SELECTED' : '', e.disabled ? 'DISABLED' : ''].filter(Boolean).join(' ');
    console.log(`   - "${e.text}"${e.aria ? ` [aria: ${e.aria}]` : ''}${marks ? `  <<${marks}>>` : ''}`);
  }

  // Open the "Select model family" dropdown — the resolution list depends on which model is chosen,
  // so the 720p ceiling seen on Flash may not be the account's real ceiling.
  const modelOpened = await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll('button, [role="button"], [role="combobox"]'))
      .find(b => (b.getAttribute('aria-label') || '') === 'Select model family'
        || /arrow_drop_down/.test(b.textContent || '') && /Omni|Veo/i.test(b.textContent || ''));
    if (!el) return false;
    (el as HTMLElement).click();
    return true;
  }).catch(() => false);
  console.log(`\n[Probe] Model dropdown opened: ${modelOpened ? 'YES' : 'NO'}`);
  await page.waitForTimeout(2000);

  const models = await page.evaluate(() => {
    const out: { text: string; checked: string | null; disabled: boolean }[] = [];
    document.querySelectorAll('[role="option"], [role="menuitem"], [role="menuitemradio"], li, button')
      .forEach(e => {
        const r = (e as HTMLElement).getBoundingClientRect();
        const t = (e.textContent || '').trim().replace(/\s+/g, ' ');
        if (r.width > 0 && r.height > 0 && t && t.length < 120 && /omni|veo|quality|fast|flash|pro|ultra|standard/i.test(t))
          out.push({
            text: t,
            checked: e.getAttribute('aria-checked') || e.getAttribute('aria-selected'),
            disabled: (e as HTMLButtonElement).disabled === true || e.getAttribute('aria-disabled') === 'true'
          });
      });
    return out.filter((v, i, a) => a.findIndex(x => x.text === v.text) === i);
  }).catch(() => []);

  console.log(`[Probe] Model families available (${models.length}):`);
  for (const m of models)
    console.log(`   - "${m.text}"${m.checked === 'true' ? '  <<SELECTED>>' : ''}${m.disabled ? '  <<DISABLED>>' : ''}`);

  // Pick "Veo 3.1 - Quality" and re-read the resolution list: the 720p ceiling belongs to Flash,
  // and higher families usually unlock more. Selecting a model costs nothing until a prompt is submitted.
  const picked = await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll('[role="option"], [role="menuitem"], [role="menuitemradio"], li, button'))
      .find(e => /Veo\s*3\.1\s*-\s*Quality/i.test((e.textContent || '').trim()));
    if (!el) return false;
    (el as HTMLElement).click();
    return true;
  }).catch(() => false);
  console.log(`[Probe] Selected "Veo 3.1 - Quality": ${picked ? 'YES' : 'NO'}`);
  await page.waitForTimeout(2500);

  if (picked) {
    // The pill is a toggle and the model click closes the popup, so: Escape, then reopen, then read.
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(800);
    await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll('button'))
        .find(b => /Video\s*·/.test(b.textContent || '') || (b.getAttribute('aria-label') || '') === 'Settings trigger');
      if (el) (el as HTMLElement).click();
    }).catch(() => {});
    await page.waitForTimeout(2500);

    const opts = await page.evaluate(() => {
      const out: { text: string; checked: string | null; disabled: boolean }[] = [];
      document.querySelectorAll('button, [role="option"], [role="radio"], li').forEach(e => {
        const r = (e as HTMLElement).getBoundingClientRect();
        const t = (e.textContent || '').trim().replace(/\s+/g, ' ');
        if (r.width > 0 && r.height > 0 && /^(360p|480p|720p|1080p|2K|4K|\d+\s*s)(info)?$/i.test(t))
          out.push({ text: t, checked: e.getAttribute('aria-checked') || e.getAttribute('aria-selected'),
                     disabled: (e as HTMLButtonElement).disabled === true || e.getAttribute('aria-disabled') === 'true' });
      });
      return out.filter((v, i, a) => a.findIndex(x => x.text === v.text) === i);
    }).catch(() => []);

    console.log(`[Probe] Durations + resolutions offered on Veo 3.1 - Quality (${opts.length}):`);
    for (const o of opts)
      console.log(`   - "${o.text}"${o.checked === 'true' ? '  <<SELECTED>>' : ''}${o.disabled ? '  <<DISABLED>>' : ''}`);

    const pill = await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('button')).find(x => /Video\s*·/.test(x.textContent || ''));
      return b ? (b.textContent || '').trim().replace(/\s+/g, ' ') : '(not found)';
    }).catch(() => '(error)');
    console.log(`[Probe] Pill now reads: ${pill}`);
  }

  const shotModels = path.join(CONFIG.LOGS_DIR, `settings_probe_models_${ts}.png`);
  await page.screenshot({ path: shotModels, fullPage: false }).catch(() => {});
  console.log(`[Probe] Model dropdown screenshot: ${shotModels}`);

  const shot = path.join(CONFIG.LOGS_DIR, `settings_probe_${ts}.png`);
  await page.screenshot({ path: shot, fullPage: false }).catch(() => {});
  console.log(`\n[Probe] Screenshot: ${shot}`);
  console.log('[Probe] Done — nothing was generated, no credits used.');
  await bm.close?.().catch(() => {});
  process.exit(0);
}
run().catch(e => { console.error('[Probe] failed:', e); process.exit(1); });
