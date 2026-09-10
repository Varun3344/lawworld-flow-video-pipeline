import { Page, Response } from 'playwright';
import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';
import crypto from 'crypto';

export class VideoDownloader {
  private targetDir: string;
  private interceptedUrls: Map<string, string> = new Map(); // sceneId -> url
  private savedFileHashes: Set<string> = new Set();         // MD5 hashes of saved files

  constructor(targetDir: string) {
    this.targetDir = targetDir;
    if (!fs.existsSync(this.targetDir)) {
      fs.mkdirSync(this.targetDir, { recursive: true });
    }
  }

  /**
   * Checks file MD5 hash; deletes duplicate files and alerts in console if duplicate detected
   */
  private checkAndRegisterHash(filePath: string, sceneId: string): boolean {
    if (!fs.existsSync(filePath) || fs.statSync(filePath).size === 0) {
      return false;
    }

    try {
      const fileBuffer = fs.readFileSync(filePath);
      const hash = crypto.createHash('md5').update(fileBuffer).digest('hex');

      if (this.savedFileHashes.has(hash)) {
        console.warn(`\n[ALERT] Duplicate video detected for ${sceneId}! (MD5: ${hash.substring(0, 8)})`);
        console.warn(`[INFO] Skipped duplicate video file to preserve unique scene clips.`);
        fs.unlinkSync(filePath); // Delete duplicate file
        return false;
      }

      this.savedFileHashes.add(hash);
      return true;
    } catch {
      return true; // proceed if hashing fails
    }
  }

  /**
   * Clears intercepted URLs map before starting a new scene
   */
  public clearUrls(sceneId?: string): void {
    if (sceneId) {
      this.interceptedUrls.delete(sceneId);
    } else {
      this.interceptedUrls.clear();
    }
  }

  /**
   * Attaches background network listener to capture .mp4 media stream URLs
   */
  public attachNetworkListener(page: Page, currentSceneIdRef: { value: string }): void {
    page.on('response', (response: Response) => {
      const url = response.url();
      const contentType = response.headers()['content-type'] || '';

      if ((url.endsWith('.mp4') || contentType.includes('video/mp4')) && response.status() === 200) {
        const sceneId = currentSceneIdRef.value;
        if (sceneId) {
          console.log(`[Network Interceptor] Captured MP4 stream URL for ${sceneId}: ${url.substring(0, 80)}...`);
          this.interceptedUrls.set(sceneId, url);
        }
      }
    });
  }

  /**
   * Primary Method: Trigger UI Download button and wait for Playwright download event
   */
  public async downloadViaUI(
    page: Page,
    downloadButtonSelector: string,
    outputFilename: string
  ): Promise<string> {
    const outputPath = path.join(this.targetDir, outputFilename);
    console.log(`[Downloader] Attempting Primary UI download for: ${outputFilename}`);

    try {
      const downloadPromise = page.waitForEvent('download', { timeout: 15000 }).catch(() => null);
      const clickSuccess = await page.click(downloadButtonSelector).then(() => true).catch(() => false);
      if (!clickSuccess) return '';

      const download = await downloadPromise;
      if (!download) return '';

      await download.saveAs(outputPath);
      console.log(`[Downloader] Successfully downloaded MP4 via UI to: ${outputPath}`);
      return outputPath;
    } catch (err) {
      console.warn(`[Downloader] UI download event timed out or failed: ${(err as Error).message}`);
      return '';
    }
  }

  /**
   * Backup Method: Download MP4 directly from intercepted network URL
   */
  public async downloadViaNetwork(sceneId: string, outputFilename: string): Promise<string> {
    const videoUrl = this.interceptedUrls.get(sceneId);
    if (!videoUrl) {
      console.warn(`[Downloader Backup] No intercepted network URL found for ${sceneId}.`);
      return '';
    }

    const outputPath = path.join(this.targetDir, outputFilename);
    console.log(`[Downloader Backup] Stream downloading MP4 from URL for ${sceneId}...`);

    return new Promise((resolve) => {
      const client = videoUrl.startsWith('https') ? https : http;
      const file = fs.createWriteStream(outputPath);

      client.get(videoUrl, (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          file.close();
          fs.unlink(outputPath, () => {});
          console.error(`[Downloader Backup] Stream URL returned HTTP ${response.statusCode}; not saving.`);
          resolve('');
          return;
        }
        response.pipe(file);
        file.on('finish', () => {
          file.close();
          console.log(`[Downloader Backup] Successfully saved MP4 via stream to: ${outputPath}`);
          resolve(outputPath);
        });
      }).on('error', (err) => {
        fs.unlink(outputPath, () => {});
        console.error(`[Downloader Backup] Failed stream download: ${err.message}`);
        resolve('');
      });
    });
  }

  /**
   * Registers a video URL for a scene (used when the src is read straight off the <video> element)
   */
  public registerUrl(sceneId: string, url: string): void {
    this.interceptedUrls.set(sceneId, url);
  }

  /**
   * Third Method: read the newest <video> element src. https -> stream download; blob: -> fetch inside page and save.
   */
  public async downloadViaPageVideo(
    page: Page,
    sceneId: string,
    outputFilename: string,
    knownSrcs: string[]
  ): Promise<string> {
    const outputPath = path.join(this.targetDir, outputFilename);
    console.log(`[Downloader Page] Reading newest <video> src for ${sceneId}...`);

    const src: string = await page.evaluate((known: string[]) => {
      const vids = Array.from(document.querySelectorAll('video')) as HTMLVideoElement[];
      const fresh = vids
        .map(v => v.currentSrc || v.src || ((v.querySelector('source') as HTMLSourceElement | null)?.src) || '')
        .filter(s => s && !known.includes(s));
      return fresh.length > 0 ? fresh[fresh.length - 1] : '';
    }, knownSrcs).catch(() => '');

    if (!src) {
      console.warn(`[Downloader Page] No new <video> src found for ${sceneId}.`);
      return '';
    }

    if (src.startsWith('http')) {
      this.registerUrl(sceneId, src);
      return this.downloadViaNetwork(sceneId, outputFilename);
    }

    if (src.startsWith('blob:')) {
      console.log(`[Downloader Page] Fetching blob: video inside page for ${sceneId}...`);
      const b64: string = await page.evaluate(async (blobUrl: string) => {
        const res = await fetch(blobUrl);
        const buf = await res.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let bin = '';
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
          bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
        }
        return btoa(bin);
      }, src).catch(() => '');
      if (!b64) return '';
      fs.writeFileSync(outputPath, Buffer.from(b64, 'base64'));
      console.log(`[Downloader Page] Saved blob video to: ${outputPath}`);
      return outputPath;
    }

    return '';
  }

  /**
   * Orchestrates dual-method download (Tries Primary UI first, falls back to Network Interceptor)
   */
  public async downloadVideo(
    page: Page,
    sceneId: string,
    downloadButtonSelector: string,
    outputFilename: string,
    knownSrcs: string[] = []
  ): Promise<string> {
    // 1. Try Primary UI method
    let savedPath = '';
    try {
      savedPath = await this.downloadViaUI(page, downloadButtonSelector, outputFilename);
      if (savedPath && fs.existsSync(savedPath) && fs.statSync(savedPath).size > 0) {
        const isUnique = this.checkAndRegisterHash(savedPath, sceneId);
        if (isUnique) return savedPath;
      }
    } catch (err) {
      console.warn(`[Downloader] Primary UI download failed: ${(err as Error).message}`);
    }

    // 2. Try Backup Network Interception method
    console.log(`[Downloader] Switching to Backup Network Interceptor method for ${sceneId}...`);
    try {
      savedPath = await this.downloadViaNetwork(sceneId, outputFilename);
      if (savedPath && fs.existsSync(savedPath) && fs.statSync(savedPath).size > 0) {
        const isUnique = this.checkAndRegisterHash(savedPath, sceneId);
        if (isUnique) return savedPath;
      }
    } catch (err) {
      console.warn(`[Downloader Backup] Network stream download failed: ${(err as Error).message}`);
    }

    // 3. Try reading the newest <video> element src directly (https or blob:)
    try {
      savedPath = await this.downloadViaPageVideo(page, sceneId, outputFilename, knownSrcs);
      if (savedPath && fs.existsSync(savedPath) && fs.statSync(savedPath).size > 0) {
        const isUnique = this.checkAndRegisterHash(savedPath, sceneId);
        if (isUnique) return savedPath;
      }
    } catch (err) {
      console.warn(`[Downloader Page] Page video download failed: ${(err as Error).message}`);
    }

    console.error(`[Downloader] All three download methods failed for ${sceneId}.`);
    return '';
  }
}
