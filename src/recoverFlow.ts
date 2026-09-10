/**
 * Recover already-rendered clips from an existing Flow project without spending credits,
 * and record how the gallery / tile detail view / "+" drawer are built (for selector fixes).
 *
 *   npx tsx src/recoverFlow.ts --project "Sep 05 - 18:45" --out downloads/<project>/recovered
 *
 * Tiles are read newest-first (top-left). Output: recovered/tile_1.mp4, tile_2.mp4 ... + logs/recover_<ts>.json + screenshots.
 */
import fs from 'fs';
import path from 'path';
import { BrowserManager } from './browser';
import { CONFIG } from './config';
import { VideoDownloader } from './downloader';

const args = process.argv.slice(2);
const argOf = (flag: string, def: string) => { const i = args.indexOf(flag); return i >= 0 && args[i + 1] ? args[i + 1] : def; };
const PROJECT = argOf('--project', '');
const OUT = path.resolve(process.cwd(), argOf('--out', 'downloads/recovered'));
const MAX_TILES = parseInt(argOf('--max', '12'), 10);

type Box = { x: number; y: number; w: number; h: number };

async function run(): Promise<void> {
  const ts = Date.now();
  const shot = (name: string) => path.join(CONFIG.LOGS_DIR, `recover_${ts}_${name}.png`);
  const report: Record<string, unknown> = {};
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(CONFIG.LOGS_DIR, { recursive: true });

  const bm = new BrowserManager({ headless: false });
  const { page } = await bm.init();
  const sceneRef = { value: '' };
  const downloader = new VideoDownloader(OUT);
  downloader.attachNetworkListener(page, sceneRef);

  console.log(`[Recover] Opening ${CONFIG.FLOW_URL}`);
  await page.goto(CONFIG.FLOW_URL, { waitUntil: 'domcontentloaded' });
  // Home shows a "Loading..." splash first; wait for it to clear and the project list to render
  await page.waitForSelector('text=Loading...', { state: 'hidden', timeout: 90000 }).catch(() => {});
  await page.waitForTimeout(4000);
  await page.screenshot({ path: shot('0_home') });

  const promptSel = '[placeholder*="What do you want to create"], p[data-placeholder*="What do you want to create"]';
  const onProject = async () => !!(await page.$(promptSel));

  // Try to open the requested project from the home page
  if (!(await onProject())) {
    const titles: { text: string; x: number; y: number }[] = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a, button, [role="button"], h1, h2, h3, h4, p, span, div'))
        .map(el => {
          const r = (el as HTMLElement).getBoundingClientRect();
          const own = Array.from(el.childNodes).filter(n => n.nodeType === 3).map(n => (n.textContent || '').trim()).join(' ').trim();
          return { text: own, x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
        })
        .filter(e => e.w > 0 && e.h > 0 && /^[A-Z][a-z]{2} \d{1,2} - \d{1,2}:\d{2}$/.test(e.text))
    );
    console.log(`[Recover] Home page project titles: ${titles.map(t => t.text).join(' | ') || '(none found)'}`);
    const target = titles.find(t => t.text === PROJECT) || titles[0];
    if (target) {
      console.log(`[Recover] Opening project "${target.text}"`);
      await page.mouse.click(target.x, target.y);
      await page.waitForTimeout(5000);
    }
  }
  if (!(await onProject())) {
    console.log(`[Recover] Not on a project page yet. Please click the project "${PROJECT || '(latest)'}" in the browser window — waiting up to 3 minutes...`);
    await page.waitForSelector(promptSel, { state: 'visible', timeout: 180000 });
  }
  await page.waitForTimeout(3000);
  report.projectUrl = page.url();
  console.log(`[Recover] On project page: ${page.url()}`);

  const getTiles = async (): Promise<Box[]> => page.evaluate(() => {
    const seen = new Set<string>();
    const out: { x: number; y: number; w: number; h: number }[] = [];
    document.querySelectorAll('img, video').forEach(el => {
      const r = (el as HTMLElement).getBoundingClientRect();
      if (r.width > 80 && r.height > 120 && r.y > 50 && r.y < window.innerHeight - 150) {
        const key = `${Math.round(r.x / 10)}_${Math.round(r.y / 10)}`;
        if (!seen.has(key)) { seen.add(key); out.push({ x: r.x, y: r.y, w: r.width, h: r.height }); }
      }
    });
    return out.sort((a, b) => a.y - b.y || a.x - b.x);
  });

  const dumpUI = async () => page.evaluate(() =>
    Array.from(document.querySelectorAll('button, a, [role="button"], [role="tab"], [role="menuitem"], input, video'))
      .map(el => {
        const r = (el as HTMLElement).getBoundingClientRect();
        return {
          tag: el.tagName.toLowerCase(),
          text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60),
          aria: el.getAttribute('aria-label'),
          type: el.getAttribute('type'),
          accept: el.getAttribute('accept'),
          src: (el as HTMLMediaElement).currentSrc || el.getAttribute('src') || null,
          visible: r.width > 0 && r.height > 0,
          box: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
        };
      })
      .filter(e => e.visible || e.tag === 'input' || e.tag === 'video')
  );

  await page.screenshot({ path: shot('1_gallery') });
  const tiles = await getTiles();
  report.tiles = tiles;
  report.galleryUI = await dumpUI();
  console.log(`[Recover] Found ${tiles.length} tile(s) in the gallery (newest first).`);

  const results: { tile: number; file: string; url: string }[] = [];
  for (let i = 0; i < Math.min(tiles.length, MAX_TILES); i++) {
    const t = tiles[i];
    const id = `tile_${i + 1}`;
    sceneRef.value = id;
    downloader.clearUrls(id);
    const cx = t.x + t.w / 2, cy = t.y + t.h / 2;
    const has = () => (downloader as any).interceptedUrls.has(id);

    await page.mouse.move(cx, cy);
    await page.waitForTimeout(3000);
    let how = has() ? 'hover' : '';
    if (!how) {
      await page.mouse.click(cx, cy);
      await page.waitForTimeout(3000);
      if (i === 0) {
        await page.screenshot({ path: shot('2_tile_detail') });
        report.detailUI = await dumpUI();
      }
      if (!has()) {
        await page.evaluate(() => {
          (Array.from(document.querySelectorAll('video')) as HTMLVideoElement[]).forEach(v => { v.muted = true; v.play().catch(() => {}); });
        }).catch(() => {});
        await page.waitForTimeout(3000);
      }
      how = has() ? 'click' : 'none';
    }

    const knownSrcs: string[] = [];
    const saved = await downloader.downloadVideo(page, id, 'button:has-text("Download"), [aria-label*="Download"]', `${id}.mp4`, knownSrcs);
    const url = (downloader as any).interceptedUrls.get(id) || '';
    console.log(`[Recover] ${id}: stream via ${how}; saved=${saved ? path.basename(saved) : 'NO'}`);
    results.push({ tile: i + 1, file: saved, url: url.slice(0, 120) });

    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(800);
    // re-read tile positions in case the layout shifted after the detail view closed
    const again = await getTiles();
    if (again.length === tiles.length) tiles.splice(0, tiles.length, ...again);
  }
  report.results = results;

  // "+" drawer: what does it contain (hidden file inputs included)?
  const buttons = await page.$$('button');
  for (const b of buttons) {
    const box = await b.boundingBox();
    const txt = (await b.textContent() || '').trim();
    if (box && box.y > 900 && box.x < 800 && (txt === '+' || txt === '' || txt.includes('+'))) { await b.click().catch(() => {}); break; }
  }
  await page.waitForTimeout(1500);
  await page.screenshot({ path: shot('3_plus_drawer') });
  report.drawerUI = await dumpUI();
  report.drawerFileInputs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('input[type="file"]')).map(i => ({ accept: i.getAttribute('accept'), id: i.id, parent: (i.parentElement?.textContent || '').trim().slice(0, 60) }))
  );
  await page.keyboard.press('Escape').catch(() => {});

  const outJson = path.join(CONFIG.LOGS_DIR, `recover_${ts}.json`);
  fs.writeFileSync(outJson, JSON.stringify(report, null, 2));
  console.log(`[Recover] Report: ${outJson}`);
  console.log(`[Recover] Saved ${results.filter(r => r.file).length}/${results.length} clip(s) to ${OUT}`);
  await bm.close();
}

run().catch(err => { console.error('[Recover] failed:', err.message); process.exit(1); });
