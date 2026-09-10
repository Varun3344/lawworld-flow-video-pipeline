import { Page, ElementHandle } from 'playwright';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { BrowserManager } from './browser';
import { CONFIG } from './config';
import { PromptSanitizer } from './sanitizer';
import { VideoDownloader } from './downloader';
import { FFmpegMerger } from './merger';
import { AutomationOptions, GenerationProgress, StoryboardConfig } from './types';

export class FlowAutomation {
  private options: AutomationOptions;
  private config!: StoryboardConfig;
  private browserManager!: BrowserManager;
  private page!: Page;
  private sanitizer: PromptSanitizer;
  private downloader!: VideoDownloader;
  private currentSceneRef: { value: string } = { value: '' };
  private projectDownloadDir: string = '';
  private lastNewTileIndex: number = 0;
  private lastFailureKind: 'policy' | 'transient' | null = null;

  constructor(options: AutomationOptions) {
    this.options = options;
    this.sanitizer = new PromptSanitizer();
  }

  /**
   * Main entry point to run full storyboard automation
   */
  public async run(): Promise<void> {
    this.loadConfig();
    this.setupDirectories();

    console.log(`\n======================================================`);
    console.log(` Starting Google Flow AI Video Automation Workflow`);
    console.log(` Project: "${this.config.projectTitle}" (${this.config.scenes.length} scenes)`);
    console.log(` Headless: ${this.options.headless} | Config: ${this.options.configPath}`);
    console.log(`======================================================\n`);

    if (this.options.dryRun) {
      this.runDryRun();
      return;
    }

    // Merge-only: stitch whatever scene clips are on disk, no browser involved
    if (this.options.mergeOnly) {
      const dir = this.config.downloadFolder
        ? path.resolve(process.cwd(), this.config.downloadFolder)
        : path.join(CONFIG.DOWNLOAD_DIR, this.config.projectTitle);
      const out = FFmpegMerger.mergeScenes(
        dir,
        this.config.projectTitle,
        this.config.speedMultiplier || 1,
        this.config.transition || { type: 'crossfade', durationSeconds: 0.25 }
      );
      if (!out) throw new Error('Merge produced no output');
      this.copyFinal(out);
      return;
    }

    // Initialize browser
    this.browserManager = new BrowserManager({ headless: this.options.headless });
    const { page } = await this.browserManager.init();
    this.page = page;

    // Attach downloader and network stream listener
    const projectDownloadDir = this.config.downloadFolder
      ? path.resolve(process.cwd(), this.config.downloadFolder)
      : path.join(CONFIG.DOWNLOAD_DIR, this.config.projectTitle);
    this.projectDownloadDir = projectDownloadDir;

    this.downloader = new VideoDownloader(projectDownloadDir);
    this.downloader.attachNetworkListener(this.page, this.currentSceneRef);

    try {
      // 1. Navigate to Google Flow & Check Auth
      await this.navigateToFlow();

      // 1b. Recovery mode: open an existing project and download its clips with the production probe/download path
      if (this.options.recover) {
        await this.runRecover(this.options.recover);
        return;
      }

      // 2. One Flow project per judgment: reopen the saved one, or create it once and remember its URL
      await this.openOrCreateProject();

      // 2c. B-roll mode: one animation clip per scene (no avatar, no seed), then exit
      if (this.options.broll) {
        await this.runBroll();
        return;
      }

      // 2b. Attach-only test mode: prove the avatar + seed frame land in the prompt bar, never generate
      if (this.options.attachTest) {
        await this.runAttachTest();
        return;
      }

      // 3. Upload Character Avatar Anchor (if provided)
      if (this.config.avatarImage) {
        await this.setupAvatarAnchor(this.config.avatarImage);
      }

      // 4. Scene Generation Loop (Scenes 1 to N)
      let progress: GenerationProgress = {
        projectTitle: this.config.projectTitle,
        completedScenes: [],
        failedScenes: [],
        lastUpdated: new Date().toISOString()
      };

      // Load existing progress if available
      if (fs.existsSync('storyboard_progress.json')) {
        try {
          const savedProgress = JSON.parse(fs.readFileSync('storyboard_progress.json', 'utf-8'));
          if (savedProgress.projectTitle === this.config.projectTitle) {
            progress = savedProgress;
            console.log(`[Resume] Loaded previous progress state: ${progress.completedScenes.length} scenes already completed.`);
          }
        } catch {
          // ignore error loading progress
        }
      }

      for (let i = 0; i < this.config.scenes.length; i++) {
        const scene = this.config.scenes[i];
        if (this.options.sceneId && scene.sceneId !== this.options.sceneId) {
          continue;
        }
        if (this.options.limit && i >= this.options.limit) {
          console.log(`
[Limit] Reached --limit ${this.options.limit}; stopping before ${scene.sceneId}.`);
          break;
        }
        this.currentSceneRef.value = scene.sceneId;

        console.log(`\n------------------------------------------------------`);
        console.log(` Checking Scene ${i + 1}/${this.config.scenes.length}: [${scene.sceneId}]`);
        console.log(`------------------------------------------------------`);

        const expectedFile = path.join(projectDownloadDir, `${scene.sceneId}.mp4`);
        if (fs.existsSync(expectedFile) && fs.statSync(expectedFile).size > 1024) {
          console.log(`[SKIP DUPLICATE] Scene video "${scene.sceneId}.mp4" already exists in download folder!`);
          console.log(`[INFO] Path: ${expectedFile}`);
          console.log(`[INFO] Skipping Google Flow generation to prevent duplicate video creation.`);
          this.extractLastFrame(expectedFile, scene.sceneId);
          if (!progress.completedScenes.includes(scene.sceneId)) {
            progress.completedScenes.push(scene.sceneId);
          }
          fs.writeFileSync('storyboard_progress.json', JSON.stringify(progress, null, 2));
          continue;
        }

        this.lastFailureKind = null;
        let success = await this.processScene(i, scene);
        if (!success && this.lastFailureKind === 'transient') {
          console.log(`[Retry] ${scene.sceneId}: transient Flow failure (uncharged) — retrying once...`);
          await this.page.waitForTimeout(5000);
          this.lastFailureKind = null;
          success = await this.processScene(i, scene);
        }
        if (success) {
          if (!progress.completedScenes.includes(scene.sceneId)) {
            progress.completedScenes.push(scene.sceneId);
          }
        } else {
          if (!progress.failedScenes.includes(scene.sceneId)) {
            progress.failedScenes.push(scene.sceneId);
          }
        }

        // Save progress state after each scene
        progress.lastUpdated = new Date().toISOString();
        fs.writeFileSync('storyboard_progress.json', JSON.stringify(progress, null, 2));
      }

      // 5. Method 4: Timeline Assembly & Automated FFmpeg Local Video Stitching
      if (this.options.noMerge) {
        console.log(`\n[Merge] Skipped (--no-merge). Scenes are in: ${projectDownloadDir}`);
      } else if (progress.completedScenes.length > 0) {
        // The final video is assembled locally by ffmpeg. (The legacy in-Flow "Scenes/Export" click-through is
        // disabled: it only created stray "Untitled Scene" items in the project and never produced a file.)
        const finalPath = FFmpegMerger.mergeScenes(
          projectDownloadDir,
          this.config.projectTitle,
          this.config.speedMultiplier || 1,
          this.config.transition || { type: 'crossfade', durationSeconds: 0.25 }
        );
        if (finalPath) this.copyFinal(finalPath);
      }

      console.log(`\n======================================================`);
      console.log(` Automation Finished Successfully!`);
      console.log(` Output Folder: ${projectDownloadDir}`);
      console.log(`======================================================\n`);

    } catch (err) {
      console.error(`\n[Fatal Error] Workflow interrupted: ${(err as Error).message}`);
      await this.saveErrorSnapshot('fatal_error');
    } finally {
      await this.browserManager.close();
    }
  }

  /**
   * Copies the merged final video into storyboard.finalCopyDir (e.g. the user's "New short" folder), if set
   */
  private copyFinal(finalPath: string): void {
    const dir = this.config.finalCopyDir;
    if (!dir) return;
    try {
      fs.mkdirSync(dir, { recursive: true });
      const target = path.join(dir, path.basename(finalPath));
      fs.copyFileSync(finalPath, target);
      console.log(`[Final] Copied to: ${target}`);
    } catch (err) {
      console.warn(`[Final] Could not copy to ${dir}: ${(err as Error).message}`);
    }
  }

  /**
   * Navigates to Google Flow and handles OAuth session expiry
   */
  private async navigateToFlow(): Promise<void> {
    console.log(`[Navigation] Opening Google Flow: ${CONFIG.FLOW_URL}`);
    await this.page.goto(CONFIG.FLOW_URL, { waitUntil: 'domcontentloaded' });
    await this.page.waitForTimeout(3000);

    // Check if redirected to Google sign-in page
    if (this.page.url().includes('accounts.google.com') || (await this.page.$('text="Sign in with Google"'))) {
      console.warn(`\n[ALERT] Google Session Expired! Please sign in manually in the open browser window.`);
      console.warn(`[INFO] Once logged in and on the Google Flow interface, press ENTER in this terminal to resume...`);

      await new Promise<void>((resolve) => {
        process.stdin.once('data', () => resolve());
      });
    }

    console.log(`[Auth] Session active on Google Flow dashboard.`);
  }

  /**
   * Opens an existing project from the Flow home page by its title ("latest" = first in the list)
   */
  private async openProjectByTitle(title: string): Promise<boolean> {
    await this.page.waitForSelector('text=Loading...', { state: 'hidden', timeout: 90000 }).catch(() => {});
    await this.page.waitForTimeout(3000);
    const titles: { text: string; x: number; y: number }[] = await this.page.evaluate(() =>
      Array.from(document.querySelectorAll('a, button, [role="button"], h1, h2, h3, h4, p, span, div'))
        .map(el => {
          const r = (el as HTMLElement).getBoundingClientRect();
          const own = Array.from(el.childNodes).filter(n => n.nodeType === 3).map(n => (n.textContent || '').trim()).join(' ').trim();
          return { text: own, x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
        })
        .filter(e => e.w > 0 && e.h > 0 && /^[A-Z][a-z]{2} \d{1,2} - \d{1,2}:\d{2}$/.test(e.text))
    );
    console.log(`[Recover] Projects on home page: ${titles.map(t => t.text).join(' | ') || '(none)'}`);
    const target = title === 'latest' ? titles[0] : titles.find(t => t.text === title);
    if (!target) return false;

    const promptVisible = async () => !!(await this.findFirstSelector(CONFIG.SELECTORS.PROMPT_INPUT, 2500));
    // Try the title, then the card thumbnail above it
    for (const dy of [0, -120, -200]) {
      console.log(`[Recover] Opening "${target.text}" (click offset ${dy})`);
      await this.page.mouse.click(target.x, target.y + dy).catch(() => {});
      await this.page.waitForTimeout(4000);
      if (await promptVisible()) return true;
    }
    return false;
  }

  /**
   * Recovery: download every clip in an existing project through the same probe/download code generation uses
   */
  private async runRecover(title: string): Promise<void> {
    console.log(`\n[Recover] Zero-credit mode — downloading existing clips from project "${title}".`);
    if (/^https?:\/\//.test(title)) {
      await this.page.goto(title, { waitUntil: 'domcontentloaded' });
      await this.page.waitForSelector('text=Loading...', { state: 'hidden', timeout: 90000 }).catch(() => {});
      if (!(await this.findFirstSelector(CONFIG.SELECTORS.PROMPT_INPUT, 15000))) throw new Error(`Could not open ${title}`);
    } else if (!(await this.openProjectByTitle(title))) {
      throw new Error(`Could not open project "${title}"`);
    }
    console.log(`[Recover] Project URL: ${this.page.url()}`);
    await this.page.waitForTimeout(2500);

    // one sub-folder per Flow project so recoveries never overwrite each other
    const projectId = (this.page.url().match(/\/project\/([^/?#]+)/) || [])[1] || String(Date.now());
    const outDir = path.join(this.projectDownloadDir, 'recovered', projectId);
    const recoverer = new VideoDownloader(outDir);
    recoverer.attachNetworkListener(this.page, this.currentSceneRef);
    this.downloader = recoverer;

    const tiles = await this.getTiles();
    console.log(`[Recover] ${tiles.length} tile(s) found (newest first).`);
    let saved = 0;
    for (let i = 0; i < tiles.length; i++) {
      const id = `tile_${i + 1}`;
      this.currentSceneRef.value = id;
      recoverer.clearUrls(id);
      let file = '';
      for (let attempt = 1; attempt <= 2 && !file; attempt++) {
        const ready = await this.nudgeTileForStream(id, i);
        if (ready) {
          file = await recoverer.downloadVideo(this.page, id, 'button:has-text("Download")', `${id}.mp4`, []);
        }
        if (!file) {
          await this.page.keyboard.press('Escape').catch(() => {});
          await this.page.waitForTimeout(1000);
          file = await this.downloadViaTileMenu(i, path.join(outDir, `${id}.mp4`));
        }
        if (!file) {
          console.log(`[Recover] ${id}: attempt ${attempt} did not yield media; retrying...`);
          await this.page.mouse.move(10, 10).catch(() => {});
          await this.page.waitForTimeout(2500);
        }
      }
      console.log(`[Recover] ${id}: ${file ? 'saved ' + path.basename(file) : 'NOT saved'}`);
      if (file) saved++;
      await this.page.keyboard.press('Escape').catch(() => {});
      await this.page.waitForTimeout(800);
    }
    console.log(`[Recover] Done: ${saved}/${tiles.length} clip(s) in ${outDir}`);
  }

  /**
   * B-roll: for every scene without a clip in <project>/broll, generate a full-frame 3D animation of that scene's
   * visual (scene.broll, else derived from visual3D) — no avatar chip, no seed frame — and download it.
   */
  private async runBroll(): Promise<void> {
    // Style: "2d" (flat-vector animation, default) or "realistic" (photoreal cinematic footage). Each style keeps
    // its own clip folder so switching styles never overwrites the other version.
    const styleRaw = String((this.config as any).brollStyle || '2d');
    const brollStyle: string = ['realistic', '3d'].includes(styleRaw) ? styleRaw : '2d';
    const STYLE_DIR: Record<string, string> = { '2d': 'broll', realistic: 'broll_realistic', '3d': 'broll_3d' };
    const brollDir = path.join(this.projectDownloadDir, STYLE_DIR[brollStyle]);
    fs.mkdirSync(brollDir, { recursive: true });
    console.log(`[B-roll] Style: ${brollStyle} -> ${brollDir}`);
    const brollDownloader = new VideoDownloader(brollDir);
    brollDownloader.attachNetworkListener(this.page, this.currentSceneRef);
    const mainDownloader = this.downloader;
    this.downloader = brollDownloader;

    let made = 0;
    for (let i = 0; i < this.config.scenes.length; i++) {
      const scene = this.config.scenes[i];
      if (this.options.sceneId && scene.sceneId !== this.options.sceneId) continue;
      if (this.options.limit && i >= this.options.limit) break;
      const outFile = path.join(brollDir, `${scene.sceneId}_broll.mp4`);
      if (fs.existsSync(outFile) && fs.statSync(outFile).size > 1024) {
        console.log(`[B-roll] ${scene.sceneId}: exists, skipped.`);
        continue;
      }
      this.currentSceneRef.value = scene.sceneId;
      brollDownloader.clearUrls(scene.sceneId);
      await this.ensureGalleryView();

      const fallbackSubject = scene.visual3D.replace(/^Ravi[^.]*\.\s*/i, '').replace(/Left anchor:|Right anchor:/g, '').replace(/The 3D elements sit.*$/s, '').trim();
      const subject = brollStyle === 'realistic'
        ? (scene.brollRealistic || scene.broll || fallbackSubject)
        : brollStyle === '3d'
          ? (scene.broll3D || scene.brollRealistic || scene.broll || fallbackSubject)
          : (scene.broll || fallbackSubject);
      const brollAspect: string = (this.config as any).brollAspect || '16:9';
      const orientation = brollAspect === '16:9' ? 'landscape 16:9' : 'vertical 9:16';
      const composition = `IMPORTANT COMPOSITION: keep every subject and all the action inside the central 60% of the frame width and fully inside the frame ` +
        `at all times; nothing may touch or leave the edges of the frame. `;
      const setting: string = (this.config as any).brollSetting ? `${String((this.config as any).brollSetting).trim().replace(/\.?$/, '.')} ` : '';
      const raw = brollStyle === 'realistic'
        ? `Photorealistic cinematic live-action footage, ${orientation}, 35mm lens look, shallow depth of field, natural motivated lighting, ` +
          `rich filmic colour grade, smooth slow camera movement, real people and real locations. ` +
          `${subject} ${setting}` + composition +
          `Continuous footage for the full 10 seconds. ` +
          `No readable text, no letters, no numbers, no captions, no logos, no watermarks, no cartoon or illustration style, no speech, no music.`
        : brollStyle === '3d'
        ? `High-end stylised 3D animation, ${orientation}, rendered in a polished cinematic CGI style like a modern animated feature film. ` +
          `Fully three-dimensional characters and environments with real depth and volume, soft global illumination, volumetric light rays, ` +
          `subtle depth of field, rich saturated colour, smooth cinematic camera move with parallax. ` +
          `Appealing stylised 3D characters with clean simple features, not photoreal humans. ` +
          `${subject} ${setting}` + composition +
          `Continuous animation for the full 10 seconds. ` +
          `No readable text, no letters, no numbers, no captions, no logos, no watermarks, no flat 2D drawing, no live-action footage, no speech, no music.`
        : `2D flat vector explainer animation, ${orientation}, clean bold shapes, minimal modern illustration style, ` +
          `smooth motion-graphics movement, vibrant limited palette of deep blue, purple and orange with a light background. ` +
          `${subject} Stylised simple characters without detailed faces are fine. ` +
          composition.replace('at all times;', 'at all times, with plain empty background at the left and right edges;') +
          `Continuous animation for the full 10 seconds. ` +
          `No readable text, no letters, no numbers, no captions, no logos, no watermarks, no photorealism, no speech, no music.`;
      const prompt = this.sanitizer.sanitizeText(raw).sanitizedPrompt;
      console.log(`\n[B-roll] ${scene.sceneId}: "${prompt.slice(0, 140)}..."`);

      // Prompt box: clear and insert
      await this.page.keyboard.press('Escape').catch(() => {});
      const promptSel = await this.findFirstSelector(CONFIG.SELECTORS.PROMPT_INPUT, 8000);
      if (!promptSel) throw new Error('Prompt box not found');
      await this.page.click(promptSel, { force: true }).catch(() => {});
      await this.page.keyboard.press('Control+A').catch(() => {});
      await this.page.keyboard.press('Backspace').catch(() => {});
      await this.page.evaluate((sel) => { const el = document.querySelector(sel); if (el) { while (el.firstChild) el.removeChild(el.firstChild); el.dispatchEvent(new Event('input', { bubbles: true })); } }, promptSel);
      // Remove any leftover ingredient chips (avatar/seed) — B-roll must not contain the presenter
      for (let k = 0; k < 3 && (await this.chipCount()) > 0; k++) {
        await this.page.evaluate(() => {
          const h = innerHeight;
          const chips = Array.from(document.querySelectorAll('img')).filter(img => { const r = img.getBoundingClientRect(); return r.width >= 24 && r.width <= 140 && r.y > h * 0.72 && r.y < h - 60; });
          const chip = chips[0]; if (!chip) return;
          const r = chip.getBoundingClientRect();
          const btn = Array.from(document.querySelectorAll('button')).find(b => { const rb = b.getBoundingClientRect(); return rb.width > 0 && rb.width < 40 && Math.abs(rb.x - r.right) < 30 && Math.abs(rb.y - r.top) < 30; });
          if (btn) btn.click();
        }).catch(() => {});
        await this.page.waitForTimeout(600);
      }
      if ((await this.chipCount()) > 0) {
        console.warn(`[B-roll] ${scene.sceneId}: could not clear ingredient chips; skipping to avoid an avatar in the B-roll.`);
        continue;
      }
      await this.page.evaluate(({ selector, text }) => {
        const el = document.querySelector(selector); if (!el) return;
        (el as HTMLElement).focus(); el.appendChild(document.createTextNode(' ' + text));
        el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
      }, { selector: promptSel, text: prompt });
      await this.page.waitForTimeout(500);

      await this.ensureAgentOff();
      await this.selectModelFamily((this.config as any).model || '');
      await this.selectResolution((this.config as any).resolution || '');
      await this.selectAspectRatioUI(brollAspect);
      const pillText = await this.page.evaluate(() => { const b = Array.from(document.querySelectorAll('button')).find(x => /Video\s*·/.test(x.textContent || '')); return b ? (b.textContent || '').trim().replace(/\s+/g, ' ') : ''; }).catch(() => '');
      const wantWide = brollAspect === '16:9';
      const aspectOk = wantWide ? /16:9|crop_16_9/.test(pillText) : /9:16|crop_9_16/.test(pillText);
      console.log(`[B-roll] Pill now reads: ${pillText}`);
      const wantSecB = this.config.clipDurationSeconds || 10;
      if (!new RegExp(`(^|[^\\d])${wantSecB}\\s?s`).test(pillText) || !/x1/.test(pillText) || !aspectOk) {
        console.error(`[B-roll] ${scene.sceneId}: settings pill reads "${pillText}" (need ${wantSecB}s / ${brollAspect} / x1) — refusing to submit.`);
        await this.saveErrorSnapshot(`broll_settings_wrong_${scene.sceneId}`);
        continue;
      }

      let ok = false;
      for (let attempt = 1; attempt <= 2 && !ok; attempt++) {
        if (attempt > 1) {
          // Flow's "Sorry, this video failed to generate" (uncharged): the prompt box was emptied on submit, so refill it
          console.log(`[Retry] ${scene.sceneId}: transient Flow failure (uncharged) — re-submitting the animation prompt...`);
          await this.page.waitForTimeout(5000);
          await this.ensureGalleryView();
          await this.page.click(promptSel, { force: true }).catch(() => {});
          await this.page.evaluate(({ selector, text }) => {
            const el = document.querySelector(selector); if (!el) return;
            while (el.firstChild) el.removeChild(el.firstChild);
            (el as HTMLElement).focus(); el.appendChild(document.createTextNode(' ' + text));
            el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
          }, { selector: promptSel, text: prompt });
          await this.page.waitForTimeout(500);
          await this.ensureAgentOff();
          await this.selectAspectRatioUI(brollAspect);
          const pill2 = await this.page.evaluate(() => { const b = Array.from(document.querySelectorAll('button')).find(x => /Video\s*·/.test(x.textContent || '')); return b ? (b.textContent || '').trim().replace(/\s+/g, ' ') : ''; }).catch(() => '');
          const aspect2 = wantWide ? /16:9|crop_16_9/.test(pill2) : /9:16|crop_9_16/.test(pill2);
          if (!/(10s|10 s)/.test(pill2) || !/x1/.test(pill2) || !aspect2 || (await this.chipCount()) > 0) {
            console.error(`[B-roll] ${scene.sceneId}: retry aborted (pill "${pill2}", chips ${await this.chipCount()}).`);
            break;
          }
        }
        const initialVideoCount = (await this.page.$$('video')).length;
        const initialTiles = await this.getTiles();
        const initialSrcs = new Set(initialTiles.map(t => t.src).filter(Boolean));
        await this.page.keyboard.press('Escape').catch(() => {});
        await this.saveErrorSnapshot(`presubmit_broll_${scene.sceneId}`);
        const gen = await this.findFirstSelector(CONFIG.SELECTORS.GENERATE_BTN);
        if (gen) await this.page.click(gen); else await this.page.keyboard.press('Enter');
        await this.page.waitForTimeout(1000);

        this.lastFailureKind = null;
        ok = await this.monitorGenerationProgress(i, scene, prompt, initialVideoCount, initialTiles.length, initialSrcs);
        if (!ok && this.lastFailureKind !== 'transient') break;
      }
      if (!ok) { console.error(`[B-roll] ${scene.sceneId}: generation failed/blocked.`); continue; }
      let saved = await brollDownloader.downloadVideo(this.page, scene.sceneId, 'button:has-text("Download")', `${scene.sceneId}_broll.mp4`, []);
      if (!saved) saved = await this.downloadViaTileMenu(this.lastNewTileIndex, outFile);
      if (saved) { made++; console.log(`[B-roll] ${scene.sceneId}: saved.`); } else console.error(`[B-roll] ${scene.sceneId}: download failed.`);
    }
    this.downloader = mainDownloader;
    console.log(`\n[B-roll] Done: ${made} clip(s) generated into ${brollDir}. Next: npx tsx src/compose.ts`);
  }

  /**
   * Attach-only test: avatar + seed frame into the prompt bar, screenshot, exit. The generate button is never touched.
   */
  private async runAttachTest(): Promise<void> {
    console.log(`\n[Attach Test] Zero-credit check — nothing will be submitted.`);
    const promptInputSelector = await this.findFirstSelector(CONFIG.SELECTORS.PROMPT_INPUT, 8000);
    if (!promptInputSelector) throw new Error('Prompt box not found');
    await this.page.click(promptInputSelector, { force: true }).catch(() => {});
    await this.page.waitForTimeout(500);

    const avatarOk = await this.ensureAvatarBadgeAttached();
    console.log(`[Attach Test] Avatar attached: ${avatarOk ? 'YES' : 'NO'}`);

    // Use this judgment's own last-frame if it has one, else any existing last-frame
    let seed: string | null = null;
    const ownFrames = path.join(this.projectDownloadDir, 'frames');
    if (fs.existsSync(ownFrames)) {
      const f = fs.readdirSync(ownFrames).find(n => n.endsWith('_last.jpg'));
      if (f) seed = path.join(ownFrames, f);
    }
    for (const dir of seed ? [] : fs.readdirSync(CONFIG.DOWNLOAD_DIR)) {
      const framesDir = path.join(CONFIG.DOWNLOAD_DIR, dir, 'frames');
      if (fs.existsSync(framesDir)) {
        const f = fs.readdirSync(framesDir).find(n => n.endsWith('_last.jpg'));
        if (f) { seed = path.join(framesDir, f); break; }
      }
    }
    // The seed upload lands in the judgment's real project media, so it is opt-in (ATTACH_TEST_SEED=1) to avoid clutter
    let seedOk = false;
    if (!process.env.ATTACH_TEST_SEED) {
      console.log(`[Attach Test] Seed-frame upload skipped (set ATTACH_TEST_SEED=1 to test it; it uploads an image into the project).`);
      seed = null;
    } else if (seed) {
      seedOk = await this.attachReferenceImage(seed);
      console.log(`[Attach Test] Seed frame attached (${path.basename(seed)}): ${seedOk ? 'YES' : 'NO'}`);
    } else {
      console.log(`[Attach Test] No *_last.jpg found under downloads/; skipping seed-frame test.`);
    }

    await this.page.keyboard.press('Escape').catch(() => {});
    await this.page.waitForTimeout(800);
    const ts = Date.now();

    // Map the prompt-bar controls of this account's layout (Agent chip state, settings trigger) — no clicks that generate
    const barButtons = await this.page.evaluate(() => {
      const h = innerHeight;
      return Array.from(document.querySelectorAll('button')).filter(b => {
        const r = b.getBoundingClientRect();
        return r.width > 0 && r.y > h * 0.85;
      }).map(b => ({
        text: (b.textContent || '').trim().slice(0, 40),
        aria: b.getAttribute('aria-label'),
        pressed: b.getAttribute('aria-pressed'),
        cls: (typeof b.className === 'string' ? b.className : '').slice(0, 80),
        x: Math.round(b.getBoundingClientRect().x), y: Math.round(b.getBoundingClientRect().y)
      }));
    }).catch(() => []);
    console.log(`[Attach Test] Prompt-bar buttons: ${JSON.stringify(barButtons)}`);

    const tune = await this.page.evaluate(() => {
      const h = innerHeight;
      const b = Array.from(document.querySelectorAll('button')).find(b => {
        const r = b.getBoundingClientRect();
        const t = (b.textContent || '').trim();
        const a = (b.getAttribute('aria-label') || '').toLowerCase();
        return r.width > 0 && r.y > h * 0.85 && (t === 'tune' || /setting|tune|option/.test(a));
      });
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }).catch(() => null);
    if (tune) {
      await this.page.mouse.click(tune.x, tune.y).catch(() => {});
      await this.page.waitForTimeout(1500);
      await this.page.screenshot({ path: path.join(CONFIG.LOGS_DIR, `attach_test_${ts}_settings.png`) }).catch(() => {});
      const panel = await this.page.evaluate(() =>
        Array.from(document.querySelectorAll('button, [role="option"], [role="radio"], [role="menuitem"], [role="tab"], label'))
          .map(e => { const r = (e as HTMLElement).getBoundingClientRect(); return { text: (e.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40), aria: e.getAttribute('aria-label'), checked: e.getAttribute('aria-checked') || e.getAttribute('aria-pressed') || e.getAttribute('aria-selected'), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width) }; })
          .filter(e => e.w > 0 && e.y > innerHeight * 0.4 && e.text)
      ).catch(() => []);
      console.log(`[Attach Test] Settings panel entries: ${JSON.stringify(panel)}`);
      await this.page.keyboard.press('Escape').catch(() => {});
      await this.page.waitForTimeout(500);
    } else {
      console.log(`[Attach Test] No settings/tune button found in the prompt bar.`);
    }

    // Drive the settings exactly as a generation run would, and report what ended up checked
    await this.selectAspectRatioUI(this.config.aspectRatio || '9:16');

    const full = path.join(CONFIG.LOGS_DIR, `attach_test_${ts}.png`);
    await this.page.screenshot({ path: full, fullPage: false });
    const bar = path.join(CONFIG.LOGS_DIR, `attach_test_${ts}_promptbar.png`);
    await this.page.screenshot({ path: bar, clip: { x: 560, y: 820, width: 800, height: 240 } }).catch(() => {});
    console.log(`[Attach Test] Screenshots: ${full}\n                            ${bar}`);
    console.log(`[Attach Test] RESULT avatar=${avatarOk ? 'OK' : 'FAIL'} seed=${seed ? (seedOk ? 'OK' : 'FAIL') : 'SKIPPED'} — no generation was started.`);
  }

  /**
   * Some accounts open projects with the Agent side panel ("Untitled session") docked on the right. Its own prompt
   * box shadows the real prompt bar and the top toolbar (Add media menu) is not rendered while it is open — close it.
   */
  private async closeAgentPanel(): Promise<void> {
    // Open = the prompt bar's ingredients button sits in the right-hand dock (x > 70% of the viewport), or the panel header is visible
    const isOpen = async () => this.page.evaluate(() => {
      const b = document.querySelector('button[aria-label="Add ingredients to the prompt box"]');
      const docked = !!b && b.getBoundingClientRect().x > innerWidth * 0.7;
      const header = Array.from(document.querySelectorAll('*')).some(el => /^(Untitled session|Hi [A-Z][a-z]+)$/.test((el.textContent || '').trim()) && (el as HTMLElement).getBoundingClientRect().width > 0);
      return docked || header;
    }).catch(() => false);
    if (!(await isOpen())) return;
    console.log(`[Project] Agent panel is open; closing it to reach the normal prompt bar...`);
    for (let attempt = 0; attempt < 3 && (await isOpen()); attempt++) {
      const pt = await this.page.evaluate(() => {
        const w = innerWidth;
        const btns = Array.from(document.querySelectorAll('button')).filter(b => {
          const r = b.getBoundingClientRect();
          const t = (b.textContent || '').trim();
          const a = (b.getAttribute('aria-label') || '').toLowerCase();
          return r.width > 0 && r.x > w * 0.75 && r.y < 90 && (t === 'close' || a.includes('close'));
        });
        if (!btns.length) return null;
        const r = btns[0].getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }).catch(() => null);
      if (pt) {
        await this.page.mouse.click(pt.x, pt.y).catch(() => {});
      } else {
        // Fallback: the "Agent" chip toggles the panel
        const chip = await this.page.$('button:has-text("Agent")');
        if (chip) await chip.click().catch(() => {});
        else await this.page.keyboard.press('Escape').catch(() => {});
      }
      await this.page.waitForTimeout(1500);
    }
    console.log(`[Project] Agent panel ${await isOpen() ? 'STILL open' : 'closed'}.`);
  }

  /**
   * Flow sometimes leaves us inside a clip's editor view ("Describe how to edit this video…", Done button) after a
   * tile was clicked. That view has no Add-media toolbar and its own prompt bar, so every scene must start from the
   * project gallery. Click "Done"/back, and if that fails reload the project URL.
   */
  private async ensureGalleryView(): Promise<void> {
    const inEditor = async () => this.page.evaluate(() =>
      !!Array.from(document.querySelectorAll('*')).find(el => /Describe how to edit this video/i.test((el.textContent || '').trim()) && (el as HTMLElement).getBoundingClientRect().width > 0)
      || !!Array.from(document.querySelectorAll('button')).find(b => (b.textContent || '').trim() === 'Done' && b.getBoundingClientRect().y < 80)
    ).catch(() => false);
    if (!(await inEditor())) return;

    console.log(`[Project] Clip editor view is open; returning to the project gallery...`);
    const done = await this.page.$('button:has-text("Done")');
    if (done && await done.isVisible().catch(() => false)) {
      await done.click().catch(() => {});
      await this.page.waitForTimeout(2000);
    }
    if (await inEditor()) {
      const back = await this.page.$('button[aria-label*="Back" i], button:has-text("arrow_back")');
      if (back) { await back.click().catch(() => {}); await this.page.waitForTimeout(2000); }
    }
    if (await inEditor() && this.config.flowProjectUrl) {
      await this.page.goto(this.config.flowProjectUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await this.page.waitForSelector('text=Loading...', { state: 'hidden', timeout: 60000 }).catch(() => {});
      await this.page.waitForTimeout(2500);
      await this.closeAgentPanel();
    }
    console.log(`[Project] Gallery view: ${await inEditor() ? 'STILL in editor' : 'restored'}.`);
  }

  /**
   * "Agent" chip state in the prompt bar: 'on' | 'off' | 'absent'
   */
  private async agentChipState(): Promise<string> {
    return this.page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('button')).find(x => (x.textContent || '').trim() === 'Agent');
      if (!b) return 'absent';
      const on = b.getAttribute('aria-pressed') === 'true' || /active|selected|checked/i.test(b.className);
      return on ? 'on' : 'off';
    }).catch(() => 'unknown');
  }

  /**
   * Agent mode routes the prompt to Flow's assistant instead of the video generator — keep it off
   */
  private async ensureAgentOff(): Promise<void> {
    const state = await this.agentChipState();
    if (state !== 'on') {
      console.log(`[Prompt UI] Agent chip: ${state}.`);
      return;
    }
    const chip = await this.page.$('button:has-text("Agent")');
    if (chip) { await chip.click().catch(() => {}); await this.page.waitForTimeout(1200); }
    console.log(`[Prompt UI] Agent chip was on; toggled off (now: ${await this.agentChipState()}).`);
  }

  /**
   * Reopens this judgment's Flow project (storyboard.flowProjectUrl); creates it only if none is saved yet.
   */
  private async openOrCreateProject(): Promise<void> {
    if (this.config.flowProjectUrl) {
      console.log(`[Project] Reopening this judgment's project: ${this.config.flowProjectUrl}`);
      await this.page.goto(this.config.flowProjectUrl, { waitUntil: 'domcontentloaded' });
      await this.page.waitForSelector('text=Loading...', { state: 'hidden', timeout: 90000 }).catch(() => {});
      const ok = await this.findFirstSelector(CONFIG.SELECTORS.PROMPT_INPUT, 15000);
      if (ok) {
        await this.page.waitForTimeout(1500);
        await this.closeAgentPanel();
        return;
      }
      console.warn(`[Project] Saved project did not open; falling back to creating one.`);
    }

    await this.createNewProject();
    await this.closeAgentPanel();
    const url = this.page.url();
    if (/\/project\//.test(url)) {
      this.config.flowProjectUrl = url;
      try {
        const cfgPath = path.resolve(process.cwd(), this.options.configPath);
        const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
        raw.flowProjectUrl = url;
        fs.writeFileSync(cfgPath, JSON.stringify(raw, null, 2));
        console.log(`[Project] Created and saved this judgment's project URL to ${path.basename(cfgPath)}: ${url}`);
      } catch (err) {
        console.warn(`[Project] Could not persist project URL: ${(err as Error).message}`);
      }
    }
  }

  /**
   * Clicks "+ New Project" / "+ Create Flow"
   */
  private async createNewProject(): Promise<void> {
    console.log(`[Project] Creating new project workspace...`);
    const newProjectBtn = await this.findFirstSelector(CONFIG.SELECTORS.NEW_PROJECT_BTN);

    if (newProjectBtn) {
      await this.page.click(newProjectBtn);
      await this.page.waitForTimeout(2000);
    } else {
      console.log(`[Project] Starting generation directly in main workspace prompt area.`);
    }
  }

  /**
   * Clicks settings pill and selects aspect ratio in Google Flow UI (9:16 vertical format)
   */
  /**
   * Layout B (accounts without the "Video · 720p · 10s" pill): a "tune" button (aria "Settings") opens a panel with
   * aspect-ratio and quantity choices plus an optional Save. Returns true when the panel was found and driven.
   */
  private async applySettingsPanel(ratio: string): Promise<boolean> {
    const tune = await this.page.$('button[aria-label="Settings"], button:has-text("tune")');
    if (!tune || !(await tune.isVisible().catch(() => false))) return false;
    await tune.click().catch(() => {});
    await this.page.waitForTimeout(1200);

    const pick = async (re: RegExp): Promise<string> => this.page.evaluate((src: string) => {
      const rx = new RegExp(src);
      const els = Array.from(document.querySelectorAll('button, [role="radio"], [role="option"], label, div'))
        .filter(e => { const r = (e as HTMLElement).getBoundingClientRect(); return r.width > 0 && r.width < 400 && rx.test((e.textContent || '').trim()); });
      // smallest match = the actual control, not a wrapper
      els.sort((a, b) => { const ra = (a as HTMLElement).getBoundingClientRect(), rb = (b as HTMLElement).getBoundingClientRect(); return ra.width * ra.height - rb.width * rb.height; });
      const el = els[0] as HTMLElement | undefined;
      if (!el) return 'not found';
      el.click();
      return `clicked (${(el.textContent || '').trim().slice(0, 20)})`;
    }, re.source).catch(() => 'error');

    const ratioRe = ratio === '9:16' ? /^(crop_9_16)?\s*9:16$/ : /^(crop_16_9)?\s*16:9$/;
    console.log(`[UI Settings] panel: aspect ${ratio} -> ${await pick(ratioRe)}`);
    await this.page.waitForTimeout(400);
    console.log(`[UI Settings] panel: quantity x1 -> ${await pick(/^x1$/)}`);
    await this.page.waitForTimeout(400);
    const dur = await pick(/^(10s|10 s)$/);
    if (dur !== 'not found') console.log(`[UI Settings] panel: duration 10s -> ${dur}`);

    const state = await this.page.evaluate(() =>
      Array.from(document.querySelectorAll('[aria-checked="true"], [aria-pressed="true"], [aria-selected="true"]'))
        .map(e => (e.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 20)).filter(Boolean).join(' | ')
    ).catch(() => '');
    console.log(`[UI Settings] panel: checked now -> ${state || '(none reported)'}`);

    const save = await this.page.$('button:has-text("Save")');
    if (save && await save.isVisible().catch(() => false)) {
      await save.click().catch(() => {});
      await this.page.waitForTimeout(800);
    }
    await this.page.keyboard.press('Escape').catch(() => {});
    await this.page.waitForTimeout(500);
    return true;
  }

  /**
   * Picks the generation model family (e.g. "Veo 3.1 - Quality") and output resolution.
   *
   * ORDER MATTERS: this must run BEFORE aspect ratio / duration / quantity. Switching family resets them —
   * selecting "Veo 3.1 - Quality" was observed silently putting the duration back to 4s, which would have
   * produced 4-second clips against 10 seconds of dialogue.
   */
  /** True when the settings popup is already showing (its model selector is on screen). */
  private async settingsPopupOpen(): Promise<boolean> {
    return this.page.evaluate(() => Array.from(document.querySelectorAll('button, [role="button"], [role="combobox"]'))
      .some(b => (b.getAttribute('aria-label') || '') === 'Select model family'
        && (b as HTMLElement).getBoundingClientRect().width > 0)).catch(() => false);
  }

  /** Idempotent: the pill is a toggle, so clicking it while the popup is open would close it again. */
  private async openSettingsPill(): Promise<boolean> {
    if (await this.settingsPopupOpen()) return true;
    const clicked = await this.page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('button'))
        .find(x => /Video\s*·/.test(x.textContent || '') || (x.getAttribute('aria-label') || '') === 'Settings trigger');
      if (!b) return false;
      (b as HTMLElement).click();
      return true;
    }).catch(() => false);
    await this.page.waitForTimeout(1000);
    return clicked;
  }

  private async selectModelFamily(model: string): Promise<boolean> {
    if (!model) return true;
    console.log(`[UI Settings] Selecting model family: ${model}...`);
    await this.openSettingsPill();
    await this.page.waitForTimeout(1200);
    const opened = await this.page.evaluate(() => {
      const el = Array.from(document.querySelectorAll('button, [role="button"], [role="combobox"]'))
        .find(b => (b.getAttribute('aria-label') || '') === 'Select model family');
      if (!el) return false;
      (el as HTMLElement).click();
      return true;
    }).catch(() => false);
    if (!opened) { console.warn('[UI Settings] Model family selector not found — keeping the current model.'); return false; }
    await this.page.waitForTimeout(1500);
    const clicked = await this.page.evaluate((want: string) => {
      // "Veo 3.1 - Quality" -> /veo.*3\.1.*quality/i, so en-dashes, icon prefixes and spacing cannot break it.
      const rx = new RegExp(want.trim().split(/[\s\-\u2010-\u2015]+/).filter(Boolean)
        .map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*'), 'i');
      const els = Array.from(document.querySelectorAll('[role="option"], [role="menuitem"], [role="menuitemradio"], li, button'))
        .filter(e => (e as HTMLElement).getBoundingClientRect().width > 0 && rx.test((e.textContent || '').trim()));
      els.sort((a, b) => (a.textContent || '').length - (b.textContent || '').length);
      if (!els.length) return false;
      (els[0] as HTMLElement).click();
      return true;
    }, model).catch(() => false);
    await this.page.waitForTimeout(2500);
    // Selecting a family resets duration/aspect, so hand a clean, closed popup to the next step.
    await this.page.keyboard.press('Escape').catch(() => {});
    await this.page.waitForTimeout(600);
    console.log(`[UI Settings] Model family "${model}": ${clicked ? 'SELECTED' : 'NOT FOUND'}`);
    return clicked;
  }

  private async selectResolution(res: string): Promise<boolean> {
    if (!res) return true;
    await this.openSettingsPill();
    await this.page.waitForTimeout(1000);
    const clicked = await this.page.evaluate((want: string) => {
      const el = Array.from(document.querySelectorAll('button, [role="option"], [role="radio"], li'))
        .find(e => {
          const r = (e as HTMLElement).getBoundingClientRect();
          return r.width > 0 && r.height > 0 && new RegExp(`^${want}(info)?$`, 'i').test((e.textContent || '').trim());
        });
      if (!el) return false;
      (el as HTMLElement).click();
      return true;
    }, res).catch(() => false);
    await this.page.waitForTimeout(1200);
    await this.page.keyboard.press('Escape').catch(() => {});
    await this.page.waitForTimeout(600);
    console.log(`[UI Settings] Resolution "${res}": ${clicked ? 'SELECTED' : 'not offered on this model'}`);
    return clicked;
  }

  private async selectAspectRatioUI(ratio: string): Promise<void> {
    console.log(`[UI Settings] Setting aspect ratio to: ${ratio}...`);

    // 0. Layout B: settings behind the "tune" button
    if (await this.applySettingsPanel(ratio)) return;

    // 1. Ensure the settings popup is OPEN. This used to click the pill unconditionally, but the pill is a
    //    toggle: after selectModelFamily() the popup could still be open, so the click closed it and every
    //    lookup below then silently missed — the aspect and duration were never applied.
    const pillOpen = await this.openSettingsPill();
    if (pillOpen) {
      await this.page.waitForTimeout(1000);

      // 2. Click the requested aspect option in the settings popup (9:16 for avatar scenes, 16:9 for B-roll)
      const ratioSelectors = ratio === '16:9' ? CONFIG.SELECTORS.ASPECT_RATIO_16_9_BTN : CONFIG.SELECTORS.ASPECT_RATIO_BTN;
      const ratioBtn = await this.findFirstSelector(ratioSelectors);
      if (ratioBtn) {
        await this.page.click(ratioBtn);
        await this.page.waitForTimeout(500);
        console.log(`[UI Settings] Selected ${ratio} aspect ratio.`);
      }

      // 3. Click the configured clip duration. This was pinned to 10s, which silently did nothing on models
      //    that do not offer it — Veo 3.1 - Quality caps at 4s, so the pill kept its reset value.
      const wantSec = this.config.clipDurationSeconds || 10;
      const durPicked = await this.page.evaluate((sec: number) => {
        const els = Array.from(document.querySelectorAll('button, [role="option"], [role="radio"], li'))
          .filter(e => {
            const r = (e as HTMLElement).getBoundingClientRect();
            return r.width > 0 && r.height > 0 && new RegExp(`^${sec}\\s*s$`).test((e.textContent || '').trim());
          });
        if (!els.length) return false;
        (els[0] as HTMLElement).click();
        return true;
      }, wantSec).catch(() => false);
      await this.page.waitForTimeout(500);
      if (durPicked) {
        console.log(`[UI Settings] Selected ${wantSec}s clip duration.`);
      } else {
        const offered = await this.page.evaluate(() => Array.from(document.querySelectorAll('button, [role="option"], [role="radio"], li'))
          .filter(e => { const r = (e as HTMLElement).getBoundingClientRect(); return r.width > 0 && /^\d+\s*s$/.test((e.textContent || '').trim()); })
          .map(e => (e.textContent || '').trim())
          .filter((v, i, a) => a.indexOf(v) === i).join(', ')).catch(() => '');
        console.warn(`[UI Settings] ${wantSec}s NOT offered by this model. Durations available: ${offered || '(none found)'}`);
      }

      // 4. Click x1 quantity option in settings popup (forces single output video, preventing x2 duplicates)
      const quantityBtn = await this.findFirstSelector(CONFIG.SELECTORS.QUANTITY_X1_BTN);
      if (quantityBtn) {
        await this.page.click(quantityBtn);
        await this.page.waitForTimeout(500);
        console.log(`[UI Settings] Selected x1 single video output (avoiding x2 duplicates).`);
      }

      // 5. Dismiss settings overlay popup panel so it does not block pointer events
      await this.page.keyboard.press('Escape').catch(() => {});
      const backdrop = await this.page.$('.cdk-overlay-backdrop');
      if (backdrop && await backdrop.isVisible()) {
        await backdrop.click().catch(() => {});
      }
      await this.page.waitForTimeout(500);
    } else {
      // Direct click if 9:16 button is visible on toolbar
      const directRatioBtn = await this.findFirstSelector(CONFIG.SELECTORS.ASPECT_RATIO_BTN);
      if (directRatioBtn) {
        await this.page.click(directRatioBtn);
        await this.page.waitForTimeout(1000);
        console.log(`[UI Settings] Selected 9:16 aspect ratio directly.`);
      }
    }
  }

  /**
   * Attaches logged-in account avatar ("Me") to prompt bar via "+" media drawer at bottom of screen
   */
  /**
   * Locates the "+" button on the bottom prompt container (opens the asset / upload drawer)
   */
  private async findBottomPlusButton(): Promise<ElementHandle | null> {
    // VERIFIED selector list — the button renders the icon ligature "add", so text matching does not work
    for (const sel of CONFIG.SELECTORS.ADD_MEDIA_PLUS_BTN) {
      const btn = await this.page.$(sel);
      if (btn && await btn.isVisible().catch(() => false)) {
        const box = await btn.boundingBox();
        if (box && box.y > 500) return btn;   // the prompt-bar one, not the toolbar "Add media menu"
      }
    }
    return null;
  }

  /**
   * Media tiles in the project gallery (thumbnail-sized <img>/<video> boxes), newest first (top-left)
   */
  private async getTiles(): Promise<{ x: number; y: number; w: number; h: number; src: string }[]> {
    return this.page.evaluate(() => {
      const seen = new Set<string>();
      const out: { x: number; y: number; w: number; h: number; src: string }[] = [];
      document.querySelectorAll('img, video').forEach(el => {
        const r = (el as HTMLElement).getBoundingClientRect();
        if (r.width > 80 && r.height > 120 && r.y > 50 && r.y < window.innerHeight - 150) {
          const key = `${Math.round(r.x / 10)}_${Math.round(r.y / 10)}`;
          if (!seen.has(key)) {
            seen.add(key);
            const src = (el as HTMLImageElement).currentSrc || (el as HTMLImageElement).src || el.getAttribute('src') || el.getAttribute('poster') || '';
            out.push({ x: r.x, y: r.y, w: r.width, h: r.height, src });
          }
        }
      });
      return out.sort((a, b) => a.y - b.y || a.x - b.x);
    }).catch(() => []);
  }

  /**
   * Index (in getTiles() order) of the first tile whose thumbnail was NOT present before submission — the new clip.
   * Falls back to 0 (top-left) only when nothing new can be told apart.
   */
  private async newTileIndex(knownSrcs: Set<string>): Promise<number> {
    const tiles = await this.getTiles();
    const idx = tiles.findIndex(t => t.src && !knownSrcs.has(t.src));
    return idx >= 0 ? idx : 0;
  }

  /**
   * Hovers / clicks the newest tile so Flow starts streaming its MP4 (which the network listener captures)
   */
  private async nudgeTileForStream(sceneId: string, tileIndex: number = 0): Promise<boolean> {
    const hasStream = () => !!(this.downloader as any).interceptedUrls?.has(sceneId);
    const tiles = await this.getTiles();
    if (tiles.length <= tileIndex) return false;
    const t = tiles[tileIndex];
    const cx = t.x + t.w / 2;
    const cy = t.y + t.h / 2;

    await this.page.mouse.move(cx, cy).catch(() => {});
    await this.page.waitForTimeout(3000);
    if (hasStream()) return true;

    await this.page.mouse.click(cx, cy).catch(() => {});
    await this.page.waitForTimeout(3000);
    if (!hasStream()) {
      // Detail view may hold a <video>; play it so the media request fires
      await this.page.evaluate(() => {
        const vids = Array.from(document.querySelectorAll('video')) as HTMLVideoElement[];
        vids.forEach(v => { v.muted = true; v.play().catch(() => {}); });
      }).catch(() => {});
      await this.page.waitForTimeout(3000);
    }
    // A placeholder/preview <video> on a still-rendering tile has no usable media: require a real, decodable clip
    const found = hasStream() || await this.page.evaluate(() =>
      Array.from(document.querySelectorAll('video')).some(v => {
        const el = v as HTMLVideoElement;
        const src = el.currentSrc || el.src;
        return !!src && el.readyState >= 1 && isFinite(el.duration) && el.duration >= 5;
      })
    ).catch(() => false);

    if (!hasStream()) {
      // leave the detail view open only if it exposes a video src the page-video downloader can use
      if (!found) {
        await this.page.keyboard.press('Escape').catch(() => {});
        await this.page.waitForTimeout(500);
      }
    }
    return found;
  }

  /**
   * Fourth download method: Flow's own tile menu (hover tile -> "more_vert" -> Download) via Playwright's download event.
   * Independent of network interception, so it also works for cached/previously played clips.
   */
  private async downloadViaTileMenu(tileIndex: number, outputPath: string): Promise<string> {
    const tiles = await this.getTiles();
    if (tiles.length <= tileIndex) return '';
    const t = tiles[tileIndex];
    await this.page.keyboard.press('Escape').catch(() => {});
    await this.page.mouse.move(t.x + t.w / 2, t.y + t.h / 2).catch(() => {});
    await this.page.waitForTimeout(1200);

    // The tile's own "more_vert" button (inside the tile rect)
    const menuPt = await this.page.evaluate((r: { x: number; y: number; w: number; h: number }) => {
      const btns = Array.from(document.querySelectorAll('button')).filter(b => /more_vert|more options/i.test((b.textContent || '') + ' ' + (b.getAttribute('aria-label') || '')));
      for (const b of btns) {
        const rr = b.getBoundingClientRect();
        if (rr.width > 0 && rr.x >= r.x - 5 && rr.x <= r.x + r.w + 5 && rr.y >= r.y - 5 && rr.y <= r.y + r.h + 5) {
          return { x: rr.x + rr.width / 2, y: rr.y + rr.height / 2 };
        }
      }
      return null;
    }, t).catch(() => null);
    if (!menuPt) {
      console.log(`[Downloader Menu] Tile menu button not found.`);
      return '';
    }
    await this.page.mouse.click(menuPt.x, menuPt.y).catch(() => {});
    await this.page.waitForTimeout(1000);
    await this.saveErrorSnapshot('tile_menu');

    // Click "Download" (menu items render as "<icon><label>", e.g. "downloadDownload"); handle a possible quality submenu
    const clickMenuItem = async (re: RegExp): Promise<boolean> => {
      const pt = await this.page.evaluate((src: string) => {
        const rx = new RegExp(src, 'i');
        const els = Array.from(document.querySelectorAll('button, [role="menuitem"], [role="option"], li'));
        const el = els.find(e => rx.test((e.textContent || '').trim()) && (e as HTMLElement).getBoundingClientRect().width > 0);
        if (!el) return null;
        const r = (el as HTMLElement).getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }, re.source).catch(() => null);
      if (!pt) return false;
      await this.page.mouse.click(pt.x, pt.y).catch(() => {});
      return true;
    };

    try {
      // "Download ▸" opens a submenu: hover it, then read the submenu entries that appear to its right
      const dlItem = await this.page.evaluate(() => {
        const els = Array.from(document.querySelectorAll('button, [role="menuitem"], [role="option"], li'));
        const el = els.find(e => /^download/i.test((e.textContent || '').trim().replace(/^download(?=Download)/, '')) && (e as HTMLElement).getBoundingClientRect().width > 0);
        if (!el) return null;
        const r = (el as HTMLElement).getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, right: r.right };
      }).catch(() => null);
      if (!dlItem) {
        console.log(`[Downloader Menu] "Download" item not found in tile menu.`);
        await this.page.keyboard.press('Escape').catch(() => {});
        return '';
      }
      await this.page.mouse.move(dlItem.x, dlItem.y).catch(() => {});
      await this.page.waitForTimeout(900);
      await this.page.mouse.click(dlItem.x, dlItem.y).catch(() => {});
      await this.page.waitForTimeout(1200);

      const subItems: { text: string; x: number; y: number }[] = await this.page.evaluate((anchor: { right: number; y: number }) =>
        Array.from(document.querySelectorAll('button, [role="menuitem"], [role="option"], li'))
          .map(e => { const r = (e as HTMLElement).getBoundingClientRect(); return { text: (e.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40), x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width }; })
          .filter(i => i.w > 0 && i.x > anchor.right && Math.abs(i.y - anchor.y) < 260 && i.text)
      , { right: dlItem.right, y: dlItem.y }).catch(() => []);
      console.log(`[Downloader Menu] Submenu: ${subItems.map(s => s.text).join(' | ') || '(none)'}`);
      await this.saveErrorSnapshot('tile_menu_submenu');

      const pick = subItems.find(s => /original|1080|720|mp4|video/i.test(s.text)) || subItems[0];
      if (!pick) {
        console.log(`[Downloader Menu] No submenu entry to click.`);
        await this.page.keyboard.press('Escape').catch(() => {});
        return '';
      }
      const dl = this.page.waitForEvent('download', { timeout: 30000 }).catch(() => null);
      await this.page.mouse.click(pick.x, pick.y).catch(() => {});
      console.log(`[Downloader Menu] Clicked "${pick.text}"; waiting for the download...`);
      const download = await dl;
      if (!download) {
        console.log(`[Downloader Menu] No download event fired.`);
        await this.page.keyboard.press('Escape').catch(() => {});
        return '';
      }
      await download.saveAs(outputPath);
      console.log(`[Downloader Menu] Saved via Flow's Download menu to: ${outputPath}`);
      return outputPath;
    } catch (err) {
      console.warn(`[Downloader Menu] failed: ${(err as Error).message}`);
      await this.page.keyboard.press('Escape').catch(() => {});
      return '';
    }
  }

  /**
   * Path of the extracted last frame for a scene (used as the next scene's continuity reference)
   */
  private lastFramePath(sceneId: string): string {
    return path.join(this.projectDownloadDir, 'frames', `${sceneId}_last.jpg`);
  }

  /**
   * Extracts the final frame of a downloaded scene clip with ffmpeg (no-op if it already exists)
   */
  private extractLastFrame(videoPath: string, sceneId: string): string | null {
    const framePath = this.lastFramePath(sceneId);
    if (fs.existsSync(framePath)) return framePath;
    try {
      fs.mkdirSync(path.dirname(framePath), { recursive: true });
      execSync(`ffmpeg -y -sseof -0.15 -i "${videoPath}" -frames:v 1 -q:v 2 "${framePath}"`, { stdio: 'pipe' });
      if (fs.existsSync(framePath)) {
        console.log(`[Continuity] Saved last frame of ${sceneId}: ${framePath}`);
        return framePath;
      }
    } catch (err) {
      console.warn(`[Continuity] Could not extract last frame of ${sceneId}: ${(err as Error).message.split('\n')[0]}`);
    }
    return null;
  }

  /**
   * Uploads an image through the "+" drawer and adds it to the prompt as a reference (best-effort)
   */
  private async attachReferenceImage(sourceImagePath: string): Promise<boolean> {
    // Upload under a unique name so the Uploads list can never resolve to an older file with the same name
    const uniqueName = `seed_${path.basename(sourceImagePath, path.extname(sourceImagePath))}_${Date.now()}${path.extname(sourceImagePath)}`;
    const imagePath = path.join(path.dirname(sourceImagePath), uniqueName);
    fs.copyFileSync(sourceImagePath, imagePath);
    console.log(`[Continuity] Attaching previous scene's last frame as ingredient: ${uniqueName}`);
    const chipsBefore = await this.chipCount();

    // 1. Upload the frame into the project media via the top-right "Add media menu" -> "Upload" (native file dialog)
    const menuSel = await this.findFirstSelector(CONFIG.SELECTORS.ADD_MEDIA_MENU_BTN, 3000);
    if (!menuSel) {
      console.warn(`[Continuity] "Add media menu" button not found.`);
      return false;
    }
    await this.page.click(menuSel).catch(() => {});
    await this.page.waitForTimeout(1200);

    // Menu item renders as "uploadUpload" (icon ligature + label) and sits near the top of the page
    const uploadItem = await this.page.evaluateHandle(() => {
      const els = Array.from(document.querySelectorAll('button, [role="menuitem"]'));
      return els.find(el => /upload/i.test(el.textContent || '') && (el as HTMLElement).getBoundingClientRect().y < 400
        && (el as HTMLElement).getBoundingClientRect().width > 0) || null;
    }).catch(() => null);
    const uploadEl = uploadItem ? uploadItem.asElement() : null;
    if (!uploadEl) {
      console.warn(`[Continuity] "Upload" item not found in the Add media menu.`);
      await this.page.keyboard.press('Escape').catch(() => {});
      return false;
    }

    const tilesBefore = (await this.getTiles()).length;
    try {
      const [chooser] = await Promise.all([
        this.page.waitForEvent('filechooser', { timeout: 15000 }),
        uploadEl.click()
      ]);
      await chooser.setFiles(imagePath);
      console.log(`[Continuity] File dialog accepted the frame; waiting for the upload to land in project media...`);
    } catch (err) {
      console.warn(`[Continuity] Native file dialog did not open: ${(err as Error).message}`);
      await this.page.keyboard.press('Escape').catch(() => {});
      return false;
    }

    // 2. Wait until a new media tile shows up (the uploaded image)
    let landed = false;
    for (let i = 0; i < 20 && !landed; i++) {
      await this.page.waitForTimeout(1500);
      landed = (await this.getTiles()).length > tilesBefore;
    }
    console.log(`[Continuity] Upload ${landed ? 'landed in project media' : 'not visible as a tile yet (continuing)'}.`);
    await this.page.keyboard.press('Escape').catch(() => {});
    await this.page.waitForTimeout(500);

    // 3. Ingredients "+" -> "Uploads" (or "Images") category -> newest card -> chip in prompt bar
    const plusBtn = await this.findBottomPlusButton();
    if (!plusBtn) {
      console.warn(`[Continuity] Ingredients button not found.`);
      return false;
    }
    await plusBtn.click();
    await this.page.waitForTimeout(1500);
    if (await this.clickExactText('Uploads', true)) {
      await this.page.waitForTimeout(1200);
    } else if (await this.clickExactText('Images', true)) {
      await this.page.waitForTimeout(1200);
    }
    // The Uploads list shows rows "<thumb> <filename>"; select ours by exact filename (fallback: first card)
    const rowClicked = await this.clickExactText(path.basename(imagePath), true) || await this.clickFirstDrawerCard();
    if (!rowClicked) {
      console.warn(`[Continuity] Uploaded frame row not found in the Uploads list.`);
      await this.saveErrorSnapshot('continuity_drawer');
      await this.page.keyboard.press('Escape').catch(() => {});
      return false;
    }
    await this.page.waitForTimeout(1200);
    if (!(await this.clickExactText('Add to prompt', true))) {
      console.warn(`[Continuity] "Add to prompt" not found after selecting the frame.`);
      await this.saveErrorSnapshot('continuity_drawer');
    }
    await this.page.waitForTimeout(1200);
    await this.page.keyboard.press('Escape').catch(() => {});
    await this.page.waitForTimeout(800);

    const chipsAfter = await this.chipCount();
    console.log(`[Continuity] Prompt bar chips: ${chipsBefore} -> ${chipsAfter}`);
    return chipsAfter > chipsBefore;
  }

  /**
   * Number of ingredient chips (thumbnail images) currently sitting in the prompt bar
   */
  private async chipCount(): Promise<number> {
    return this.page.evaluate(() => {
      const h = window.innerHeight;
      return Array.from(document.querySelectorAll('img')).filter(img => {
        const r = img.getBoundingClientRect();
        return r.width >= 24 && r.width <= 140 && r.height >= 24 && r.y > h * 0.72 && r.y < h - 60;
      }).length;
    }).catch(() => 0);
  }

  /**
   * Clicks the first (newest) card in the open ingredients drawer's grid area
   */
  private async clickFirstDrawerCard(): Promise<boolean> {
    const pt = await this.page.evaluate(() => {
      const w = window.innerWidth, h = window.innerHeight;
      const cards = Array.from(document.querySelectorAll('img')).map(img => img.getBoundingClientRect())
        .filter(r => r.width >= 60 && r.height >= 60 && r.x > w * 0.35 && r.x < w * 0.72 && r.y > h * 0.36 && r.y < h * 0.82)
        .sort((a, b) => a.y - b.y || a.x - b.x);
      return cards.length ? { x: cards[0].x + cards[0].width / 2, y: cards[0].y + cards[0].height / 2 } : null;
    }).catch(() => null);
    if (!pt) return false;
    await this.page.mouse.click(pt.x, pt.y).catch(() => {});
    return true;
  }

  /**
   * Clicks the smallest visible element whose trimmed text is exactly `label`.
   * The drawer's rows are plain divs, so tag/role-restricted selectors miss them,
   * while substring matching hits wrapper elements and clicks the wrong thing.
   */
  private async clickExactText(label: string, withinDrawer: boolean = false): Promise<boolean> {
    const pt = await this.page.evaluate(({ text, scoped }: { text: string; scoped: boolean }) => {
      // Drawer scope = the panel that holds the "Search assets" box (fallback: the centred overlay area)
      let scope: { l: number; t: number; r: number; b: number } | null = null;
      if (scoped) {
        let node: HTMLElement | null = document.querySelector('input[placeholder*="Search assets" i]') as HTMLElement | null;
        // climb past the search row (wide but short) up to the drawer panel (wide AND tall)
        while (node && (node.getBoundingClientRect().width < 600 || node.getBoundingClientRect().height < 400)) node = node.parentElement;
        const rr = node ? node.getBoundingClientRect() : null;
        // the found pane is the content area; the category column (All / Images / ... / Avatars / Uploads) sits ~150px to its left
        scope = rr
          ? { l: rr.left - 160, t: rr.top - 20, r: rr.right + 20, b: rr.bottom + 20 }
          : { l: innerWidth * 0.28, t: innerHeight * 0.25, r: innerWidth * 0.72, b: innerHeight * 0.84 };
      }
      let best: { x: number; y: number; area: number } | null = null;
      let total = 0, inScope = 0;
      document.querySelectorAll('*').forEach(el => {
        if ((el.textContent || '').trim() !== text) return;
        const r = (el as HTMLElement).getBoundingClientRect();
        if (r.width < 20 || r.height < 12) return;
        total++;
        const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
        if (scope && (cx < scope.l || cx > scope.r || cy < scope.t || cy > scope.b)) return;
        inScope++;
        const area = r.width * r.height;
        if (!best || area < best.area) best = { x: cx, y: cy, area };
      });
      return { best, total, inScope, scope };
    }, { text: label, scoped: withinDrawer }).catch(() => null);

    if (!pt || !(pt as any).best) {
      const d = pt as any;
      console.log(`[UI] "${label}" not clickable — matches: ${d ? d.total : '?'} total, ${d ? d.inScope : '?'} in scope ${d && d.scope ? JSON.stringify(d.scope, (k, v) => typeof v === 'number' ? Math.round(v) : v) : '(none)'}`);
      return false;
    }
    await this.page.mouse.click((pt as any).best.x, (pt as any).best.y).catch(() => {});
    return true;
  }

  /**
   * Attaches the account avatar ("Me") as a real Flow asset:
   *   ingredients "+"  ->  "Avatars" tab  ->  "Me" card  ->  "Add to prompt"
   * Returns true only when "Add to prompt" was actually clicked.
   */
  private async selectAccountAvatarUI(): Promise<boolean> {
    const plusBtn = await this.findBottomPlusButton();
    if (!plusBtn) {
      console.warn(`[Avatar UI] Ingredients button not found.`);
      return false;
    }
    await plusBtn.click();
    await this.page.waitForTimeout(1500);

    // "Avatars" category in the drawer's left sidebar
    if (await this.clickExactText('Avatars', true)) {
      console.log(`[Avatar UI] Selected "Avatars" category.`);
      await this.page.waitForTimeout(1200);
    }

    // The "Me" card (thumbnail + label, a plain div — not a button)
    if (!(await this.clickExactText('Me', true))) {
      console.warn(`[Avatar UI] "Me" avatar card not found in the Avatars list.`);
      await this.saveErrorSnapshot('avatar_drawer');
      await this.page.keyboard.press('Escape').catch(() => {});
      return false;
    }
    console.log(`[Avatar UI] Selected the "Me" avatar card.`);
    await this.page.waitForTimeout(1200);

    // Some states show an "Add to prompt" confirm (not a <button>); a plain card click already adds the chip in others
    if (await this.clickExactText('Add to prompt', true)) {
      await this.page.waitForTimeout(1200);
    }
    await this.page.keyboard.press('Escape').catch(() => {});
    await this.page.waitForTimeout(800);

    // The only proof that counts: a thumbnail chip in the prompt bar
    const chips = await this.chipCount();
    if (chips < 1) {
      console.warn(`[Avatar UI] No avatar chip visible in the prompt bar after the attach attempt.`);
      return false;
    }
    console.log(`[Avatar UI] Verified avatar chip in prompt bar (chips: ${chips}).`);
    return true;
  }

  /**
   * Guarantees account avatar badge ("Me") chip is attached to prompt container for EVERY scene (1 to N)
   */
  private async ensureAvatarBadgeAttached(): Promise<boolean> {
    console.log(`[Avatar UI] Attaching account avatar ("Me") via the ingredients drawer...`);
    const ok = await this.selectAccountAvatarUI();
    await this.page.waitForTimeout(800);
    return ok;
  }

  /**
   * Sets up avatar reference anchor image if provided in storyboard
   */
  private async setupAvatarAnchor(avatarPath: string): Promise<void> {
    if (this.config.globalStyle.useAccountAvatar) {
      console.log(`[Avatar] Method A enabled (Account Avatar). Skipping local image upload.`);
      return;
    }

    const fullAvatarPath = path.resolve(process.cwd(), avatarPath);
    if (!fs.existsSync(fullAvatarPath)) {
      console.warn(`[Avatar] Avatar image file not found at ${fullAvatarPath}. Skipping anchor upload.`);
      return;
    }

    console.log(`[Avatar] Uploading avatar anchor image: ${fullAvatarPath}`);
    const fileInput = await this.page.$('input[type="file"]');
    if (fileInput) {
      await fileInput.setInputFiles(fullAvatarPath);
      await this.page.waitForTimeout(2000);
      console.log(`[Avatar] Avatar image uploaded as character reference anchor.`);
    } else {
      console.log(`[Avatar] File input element not found; avatar prompt tags (@me) will guide continuity.`);
    }
  }

  /**
   * Processes a single scene (Sanitize -> Submit -> Monitor -> Downloader)
   */
  private async processScene(sceneIndex: number, scene: any): Promise<boolean> {
    // 0. Clear stale network stream URLs
    this.downloader.clearUrls(scene.sceneId);

    // 0b. Continuity: make sure the previous scene's last frame exists (extract it if the clip is on disk)
    let referenceFramePath: string | null = null;
    if (this.config.useLastFrameReference && sceneIndex > 0) {
      const prevId = this.config.scenes[sceneIndex - 1].sceneId;
      const prevVideo = path.join(this.projectDownloadDir, `${prevId}.mp4`);
      referenceFramePath = fs.existsSync(this.lastFramePath(prevId))
        ? this.lastFramePath(prevId)
        : (fs.existsSync(prevVideo) ? this.extractLastFrame(prevVideo, prevId) : null);
      if (!referenceFramePath) {
        // Strict: never generate a chained scene without its seed frame — that is exactly how avatar drift happens
        console.error(`[Continuity] No last frame available for ${prevId}; refusing to generate ${scene.sceneId} unseeded (no credit spent).`);
        return false;
      }
    }

    // 1. Pre-flight Sanitization
    let sanitizeResult = this.sanitizer.buildFullPrompt(
      sceneIndex,
      this.config.scenes.length,
      scene,
      this.config.globalStyle,
      this.config.aspectRatio,
      !!referenceFramePath
    );

    if (sanitizeResult.sanitizerApplied) {
      console.log(`[Sanitizer Alert] Replaced ${sanitizeResult.replacedKeywords.length} trigger words:`);
      sanitizeResult.replacedKeywords.forEach(k => {
        console.log(` - "${k.original}" -> "${k.replacement}" (${k.category})`);
      });
    }

    // Check dialogue pacing for 10s clip limit
    const pacing = this.sanitizer.validatePacing(scene.dialogue, this.config.maxWordsPerClip || 20);
    if (!pacing.isOptimal) {
      console.warn(`[Pacing Warning] ${pacing.warning}`);
    } else {
      console.log(`[Pacing OK] Dialogue length: ${pacing.wordCount} words (fits the ${this.config.clipDurationSeconds || 10}s clip nicely).`);
    }

    console.log(`[Prompt] Prompt for ${scene.sceneId}:`);
    console.log(`  "${sanitizeResult.visualFramePrompt}"`);

    // 2. Make sure we are on the project gallery (not inside a clip editor), dismiss overlays, locate prompt input
    await this.ensureGalleryView();
    await this.page.keyboard.press('Escape').catch(() => {});
    const openBackdrop = await this.page.$('.cdk-overlay-backdrop');
    if (openBackdrop && await openBackdrop.isVisible()) {
      await openBackdrop.click().catch(() => {});
      await this.page.waitForTimeout(300);
    }

    let promptInputSelector = await this.findFirstSelector(CONFIG.SELECTORS.PROMPT_INPUT, 5000);
    if (!promptInputSelector) {
      console.log(`[Prompt UI] Prompt box not visible yet. Attempting to enter project workspace...`);
      const newProjectBtn = await this.findFirstSelector(CONFIG.SELECTORS.NEW_PROJECT_BTN, 3000);
      if (newProjectBtn) {
        await this.page.click(newProjectBtn);
        await this.page.waitForTimeout(2500);
        promptInputSelector = await this.findFirstSelector(CONFIG.SELECTORS.PROMPT_INPUT, 5000);
      }
    }

    if (!promptInputSelector) {
      throw new Error(`Could not locate Google Flow prompt input field.`);
    }

    console.log(`[Prompt UI] Clearing prompt container for ${scene.sceneId}...`);
    await this.page.click(promptInputSelector, { force: true }).catch(() => {});
    await this.page.waitForTimeout(300);

    // Select all existing text and delete it to prevent residual dialogue audio leakage (TrustedHTML-safe)
    await this.page.keyboard.press('Control+A').catch(() => {});
    await this.page.keyboard.press('Backspace').catch(() => {});
    await this.page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (el) {
        (el as HTMLElement).innerText = '';
        el.textContent = '';
        while (el.firstChild) {
          el.removeChild(el.firstChild);
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }, promptInputSelector);
    await this.page.waitForTimeout(300);

    // 3. Attach the verified account avatar ("Me") for EVERY scene. Strict: without it Flow invents a different person.
    const avatarAttached = await this.ensureAvatarBadgeAttached();
    if (!avatarAttached) {
      console.error(`[Avatar UI] FAILED to attach the verified avatar for ${scene.sceneId}. Skipping generation (no credit spent).`);
      await this.saveErrorSnapshot(`avatar_failed_${scene.sceneId}`);
      return false;
    }

    // 3b. Attach previous scene's last frame as a continuity ingredient (scenes 2..N).
    // Strict: if this fails we do NOT generate, because a scene without the seed frame
    // comes back with a different face — the exact defect this chain exists to prevent.
    if (referenceFramePath) {
      const attached = await this.attachReferenceImage(referenceFramePath);
      if (!attached) {
        console.error(`[Continuity] FAILED to attach the seed frame for ${scene.sceneId}. Skipping generation to avoid an avatar mismatch (no credit spent).`);
        await this.saveErrorSnapshot(`continuity_failed_${scene.sceneId}`);
        return false;
      }
    }

    // 4. Ensure drawer modals are closed and insert prompt text directly into prompt container element
    await this.page.keyboard.press('Escape').catch(() => {});
    await this.page.waitForTimeout(300);

    const cleanPromptText = sanitizeResult.visualFramePrompt.trim();

    await this.page.evaluate(({ selector, text }) => {
      const el = document.querySelector(selector);
      if (el) {
        (el as HTMLElement).focus();
        const textNode = document.createTextNode(' ' + text);
        el.appendChild(textNode);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, { selector: promptInputSelector, text: cleanPromptText });
    await this.page.waitForTimeout(500);

    // 5. Agent OFF first (its mode hides the real settings pill and shows generator defaults 8s/16:9/x2 once off),
    //    THEN apply 9:16 / 10s / x1 through the pill
    await this.ensureAgentOff();
    await this.selectModelFamily((this.config as any).model || '');
    await this.selectResolution((this.config as any).resolution || '');
    await this.selectAspectRatioUI(this.config.aspectRatio || '9:16');
    const pillText = await this.page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('button')).find(x => /Video\s*·/.test((x.textContent || '')));
      return b ? (b.textContent || '').trim().replace(/\s+/g, ' ') : '(pill not found)';
    }).catch(() => '(error)');
    console.log(`[UI Settings] Pill now reads: ${pillText}`);
    // This guard used to reject 16:9 outright, which made a configured 16:9 avatar run impossible even
    // though the UI had selected it correctly. Check against the configured ratio, like the B-roll path does.
    const wantAvatarWide = (this.config.aspectRatio || '9:16') === '16:9';
    const avatarAspectOk = wantAvatarWide
      ? /16:9|crop_16_9/.test(pillText)
      : !/16:9|crop_16_9/.test(pillText);
    const wantSecA = this.config.clipDurationSeconds || 10;
    if (!new RegExp(`(^|[^\\d])${wantSecA}\\s?s`).test(pillText) || !/x1/.test(pillText) || !avatarAspectOk) {
      console.error(`[UI Settings] Settings are NOT ${wantSecA}s / ${this.config.aspectRatio || '9:16'} / x1 — refusing to submit ${scene.sceneId} (no credit spent).`);
      await this.saveErrorSnapshot(`settings_wrong_${scene.sceneId}`);
      return false;
    }

    // Record video element count and existing srcs before submitting prompt
    const initialVideoCount = (await this.page.$$('video')).length;
    const initialSrcs: string[] = await this.page.evaluate(() =>
      Array.from(document.querySelectorAll('video'))
        .map(v => (v as HTMLVideoElement).currentSrc || (v as HTMLVideoElement).src || '')
        .filter(Boolean)
    ).catch(() => [] as string[]);
    const initialTiles = await this.getTiles();
    const initialTileCount = initialTiles.length;
    const initialTileSrcs = new Set(initialTiles.map(t => t.src).filter(Boolean));

    // Close settings popup if open by pressing Escape
    await this.page.keyboard.press('Escape').catch(() => {});
    await this.page.waitForTimeout(300);

    // Final guard: the Agent chip must still be off at submit time
    if ((await this.agentChipState()) === 'on') {
      await this.ensureAgentOff();
    }

    // Proof of what is in the prompt bar (avatar chip + seed chip + text) at the moment of submission
    await this.saveErrorSnapshot(`presubmit_${scene.sceneId}`);

    // Click Generate Submit Button or Press Enter (only once)
    const generateBtnSelector = await this.findFirstSelector(CONFIG.SELECTORS.GENERATE_BTN);
    if (generateBtnSelector) {
      console.log(`[Prompt UI] Clicking submit arrow button: ${generateBtnSelector}`);
      await this.page.click(generateBtnSelector);
    } else {
      await this.page.keyboard.press('Enter');
    }
    await this.page.waitForTimeout(1000);

    // 4. Monitor Render & Catch Errors
    const renderSuccess = await this.monitorGenerationProgress(sceneIndex, scene, sanitizeResult.visualFramePrompt, initialVideoCount, initialTileCount, initialTileSrcs);
    if (!renderSuccess) {
      return false;
    }

    // 5. Download Scene MP4
    const downloadBtnSelector = await this.findFirstSelector(CONFIG.SELECTORS.DOWNLOAD_BTN);
    const outputFilename = `${scene.sceneId}.mp4`;
    let savedPath = await this.downloader.downloadVideo(
      this.page,
      scene.sceneId,
      downloadBtnSelector || 'button:has-text("Download")',
      outputFilename,
      initialSrcs
    );
    if (!savedPath) {
      // Fallback: Flow's own tile menu download on the tile identified as this scene's
      savedPath = await this.downloadViaTileMenu(this.lastNewTileIndex, path.join(this.projectDownloadDir, outputFilename));
    }

    // 6. Save this scene's last frame for the next scene's continuity reference
    if (savedPath) {
      this.extractLastFrame(savedPath, scene.sceneId);
    }

    return !!savedPath;
  }

  /**
   * Applies End-Frame Continuation ("Extend Clip" / last frame reference)
   */
  private async applyEndFrameContinuation(): Promise<void> {
    console.log(`[Continuation] Linking previous clip end-frame anchor...`);
    try {
      const extendBtn = await this.findFirstSelector(CONFIG.SELECTORS.EXTEND_CLIP_BTN);
      if (extendBtn) {
        await this.page.click(extendBtn, { timeout: 3000 });
        await this.page.waitForTimeout(1000);
        console.log(`[Continuation] Selected 'Extend Clip' from previous scene.`);
        return;
      }
    } catch {
      // Disabled or not present; fallback to prompt continuity
    }
    console.log(`[Continuation] Sequential script prompting (@me continuity) maintains scene flow.`);
  }

  /**
   * Watchdog timer monitoring render progress, safety cards, and credit limits
   */
  private async monitorGenerationProgress(
    sceneIndex: number,
    scene: any,
    submittedPrompt: string,
    initialVideoCount: number = 0,
    initialTileCount: number = 0,
    initialTileSrcs: Set<string> = new Set()
  ): Promise<boolean> {
    console.log(`[Render Watchdog] Monitoring generation for ${scene.sceneId} (Timeout: 4 mins)...`);
    const startTime = Date.now();
    const maxTimeout = this.options.maxRenderTimeoutMs || CONFIG.RENDER_TIMEOUT_MS;
    let nudgeLogged = false;

    // Stale "Failed" cards from earlier attempts stay in the gallery; only a NEW one means this scene was blocked
    const countErrorCards = async (): Promise<number> => this.page.evaluate(() =>
      Array.from(document.querySelectorAll('*')).filter(el => {
        const t = (el.textContent || '').trim();
        const r = (el as HTMLElement).getBoundingClientRect();
        // card text begins with the icon ligature ("warningFailed..."), so no start anchor.
        // Matches both policy blocks ("Unable to generate videos that might cause reputational risk...")
        // and Flow's transient failures ("Sorry, this video failed to generate").
        return r.width > 0 && r.width < 400 && /Failed/.test(t) && /reputational|current events|Unable to generate|failed to generate/i.test(t);
      }).length
    ).catch(() => 0);
    const baselineErrorCards = await countErrorCards();

    while (Date.now() - startTime < maxTimeout) {
      // A. Check for a NEW failure card: transient ("failed to generate") -> caller retries; policy -> reword needed
      if ((await countErrorCards()) > baselineErrorCards) {
        const transient = await this.page.evaluate(() =>
          Array.from(document.querySelectorAll('*')).some(el => {
            const t = (el.textContent || '').trim();
            const r = (el as HTMLElement).getBoundingClientRect();
            return r.width > 0 && r.width < 400 && /Failed/.test(t) && /failed to generate/i.test(t) && !/reputational|current events/i.test(t);
          })
        ).catch(() => false);
        if (transient) {
          this.lastFailureKind = 'transient';
          console.warn(`[Render Watchdog] Flow reported a transient failure for ${scene.sceneId} ("failed to generate", not charged).`);
          await this.saveErrorSnapshot(`transient_fail_${scene.sceneId}`);
          return false;
        }
      }
      const errorCardSelector = (await countErrorCards()) > baselineErrorCards
        ? await this.findFirstSelector(CONFIG.SELECTORS.ERROR_CARD)
        : null;
      if (errorCardSelector) {
        this.lastFailureKind = 'policy';
        console.warn(`\n[Policy Filter Triggered] Google Flow flagged prompt for reputational/policy risk!`);
        await this.handlePolicyViolation(sceneIndex, scene, submittedPrompt);
        return false;
      }

      // B. Check for Credit Limit Exhausted Banner
      const creditExhausted = await this.findFirstSelector(CONFIG.SELECTORS.CREDIT_EXHAUSTED_BANNER);
      if (creditExhausted) {
        console.warn(`\n[WARNING] Daily Google Flow generation credits exhausted after ${scene.sceneId}!`);
        console.warn(`[INFO] Completed scenes saved. Re-run script when credits reset to resume automatically.`);
        return false;
      }

      // C. Check if new video tile rendered, network stream intercepted, or download button visible
      const hasNetworkStream = (this.downloader as any).interceptedUrls?.has(scene.sceneId);
      const currentVideoCount = (await this.page.$$('video')).length;
      const newVideoRendered = currentVideoCount > initialVideoCount;

      if (hasNetworkStream) {
        console.log(`[Render Complete] Generation finished for ${scene.sceneId} in ${Math.round((Date.now() - startTime) / 1000)}s.`);
        return true;
      }

      // The gallery only keeps on-screen tiles in the DOM, so once it fills the viewport a new clip at the top pushes
      // an old one out and the count never grows. Flow inserts the newest clip top-left: a thumbnail there that did
      // not exist before submission is the new clip.
      const tilesNow = await this.getTiles();
      const currentTileCount = tilesNow.length;
      const firstIsNew = tilesNow.length > 0 && !!tilesNow[0].src && !initialTileSrcs.has(tilesNow[0].src);
      const newTile = currentTileCount > initialTileCount || firstIsNew;

      // Renders never finish under ~40s; a tile that early is the in-progress placeholder — don't probe it yet
      const elapsedMs = Date.now() - startTime;
      if ((newTile || newVideoRendered) && elapsedMs >= 40 * 1000) {
        // A new gallery tile exists. "Done" means we can actually reach its media: hover/click it so Flow streams the MP4.
        if (!nudgeLogged) {
          console.log(`[Render Watchdog] New tile detected for ${scene.sceneId} (${initialTileCount} -> ${currentTileCount}); probing for MP4 stream...`);
          nudgeLogged = true;
        }
        // Probe the tile that appeared after submission (by thumbnail src), never just the top-left one
        const idx = await this.newTileIndex(initialTileSrcs);
        const ready = await this.nudgeTileForStream(scene.sceneId, idx);
        if (ready) {
          this.lastNewTileIndex = idx;
          console.log(`[Render Complete] Generation finished for ${scene.sceneId} in ${Math.round((Date.now() - startTime) / 1000)}s (tile #${idx + 1}).`);
          return true;
        }
        // Still encoding (placeholder tile) — keep polling
      }

      await this.page.waitForTimeout(3000);
    }

    console.error(`[Timeout] Scene ${scene.sceneId} exceeded max render time of 4 minutes.`);
    await this.saveErrorSnapshot(`timeout_${scene.sceneId}`);
    return false;
  }

  /**
   * Handles policy error cards by clicking Undo/Retry and auto-submitting safe fallback prompt
   */
  private async handlePolicyViolation(sceneIndex: number, scene: any, flaggedPrompt: string): Promise<void> {
    // 1. Log flagged prompt
    const logPath = path.join(CONFIG.LOGS_DIR, 'failed_prompts.json');
    const existingLogs = fs.existsSync(logPath) ? JSON.parse(fs.readFileSync(logPath, 'utf-8')) : [];
    existingLogs.push({
      timestamp: new Date().toISOString(),
      sceneId: scene.sceneId,
      flaggedPrompt
    });
    fs.writeFileSync(logPath, JSON.stringify(existingLogs, null, 2));

    await this.saveErrorSnapshot(`policy_error_${scene.sceneId}`);

    // 2. Clear the failed card (its trash icon) so it does not linger in the gallery. No fallback prompt is ever
    //    resubmitted: a generic prompt breaks avatar/visual continuity and, with the Agent enabled, gets executed
    //    as an agent instruction. The scene is reported as failed and the wording is fixed by hand.
    const trashed = await this.page.evaluate(() => {
      const card = Array.from(document.querySelectorAll('*')).find(el => /^Failed/.test((el.textContent || '').trim()) && (el as HTMLElement).getBoundingClientRect().width > 0 && (el as HTMLElement).getBoundingClientRect().width < 400);
      if (!card) return false;
      const box = (card as HTMLElement).closest('div')?.parentElement?.getBoundingClientRect();
      const btn = Array.from(document.querySelectorAll('button')).find(b => {
        const r = b.getBoundingClientRect();
        const t = (b.textContent || '').trim();
        return box && r.width > 0 && r.x >= box.x - 5 && r.x <= box.x + box.width + 5 && r.y >= box.y - 5 && r.y <= box.y + box.height + 5 && /delete|trash/i.test(t + ' ' + (b.getAttribute('aria-label') || ''));
      });
      if (!btn) return false;
      btn.click();
      return true;
    }).catch(() => false);
    console.log(`[Policy] Scene ${scene.sceneId} blocked by Flow's policy filter (no credit charged). Failed card ${trashed ? 'removed' : 'left in place'}. Reword the dialogue and re-run; no fallback prompt was submitted.`);
    void sceneIndex;
  }

  /**
   * Method 4: Switches to Timeline view, orders completed clips, and exports full merged video
   */
  private async assembleTimelineAndExport(projectTitle: string, downloadDir: string): Promise<void> {
    console.log(`\n[Method 4 Timeline Assembly] Merging scenes into 90-second timeline sequence...`);

    const timelineTab = await this.findFirstSelector(CONFIG.SELECTORS.TIMELINE_TAB);
    if (timelineTab) {
      await this.page.click(timelineTab);
      await this.page.waitForTimeout(2000);

      const exportBtn = await this.findFirstSelector(CONFIG.SELECTORS.EXPORT_TIMELINE_BTN);
      if (exportBtn) {
        const fullFilename = `${projectTitle}_Full_90s.mp4`;
        console.log(`[Timeline Export] Triggering full sequence download: ${fullFilename}`);
        await this.downloader.downloadVideo(this.page, 'full_timeline', exportBtn, fullFilename);
      }
    } else {
      console.log(`[Timeline Export] Individual scene MP4s saved to output folder: ${downloadDir}`);
    }
  }

  /**
   * Helper to load and validate storyboard config JSON
   */
  private loadConfig(): void {
    const configPath = path.resolve(process.cwd(), this.options.configPath);
    if (!fs.existsSync(configPath)) {
      throw new Error(`Storyboard config file not found at: ${configPath}`);
    }

    this.config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    if (!this.config.scenes || this.config.scenes.length === 0) {
      throw new Error(`Storyboard config does not contain any scenes.`);
    }
  }

  /**
   * Helper to set up workspace folders
   */
  private setupDirectories(): void {
    [CONFIG.USER_DATA_DIR, CONFIG.DOWNLOAD_DIR, CONFIG.LOGS_DIR, CONFIG.ASSETS_DIR].forEach(dir => {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    });
  }

  /**
   * Helper to test first matching selector from array with optional timeout
   */
  private async findFirstSelector(selectors: string[], timeoutMs: number = 1000): Promise<string | null> {
    for (const sel of selectors) {
      try {
        const el = await this.page.waitForSelector(sel, { state: 'visible', timeout: timeoutMs }).catch(() => null);
        if (el) return sel;
      } catch {
        // continue
      }
    }
    return null;
  }

  /**
   * Helper to save error screenshot
   */
  private async saveErrorSnapshot(tag: string): Promise<void> {
    try {
      const screenshotPath = path.join(CONFIG.LOGS_DIR, `${tag}_${Date.now()}.png`);
      await this.page.screenshot({ path: screenshotPath, fullPage: true });
      console.log(`[Snapshot] Error screenshot saved: ${screenshotPath}`);
    } catch {
      // ignore
    }
  }

  /**
   * Dry Run mode to preview prompts without launching browser
   */
  private runDryRun(): void {
    console.log(`\n--- DRY RUN PROMPT PREVIEW ---`);
    this.config.scenes.forEach((scene, index) => {
      if (this.options.sceneId && scene.sceneId !== this.options.sceneId) {
        return;
      }
      const sanitized = this.sanitizer.buildFullPrompt(
        index,
        this.config.scenes.length,
        scene,
        this.config.globalStyle,
        this.config.aspectRatio,
        !!this.config.useLastFrameReference && index > 0
      );
      console.log(`\n[Scene ${index + 1}: ${scene.sceneId}]`);
      console.log(`Dialogue: "${scene.dialogue}"`);
      console.log(`Generated Prompt:\n${sanitized.visualFramePrompt}`);
    });
    console.log(`\nDry run completed cleanly.`);
  }
}
