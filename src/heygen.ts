/**
 * HeyGen: lip-sync an audio file onto the host's avatar, on a transparent background.
 *
 * Why this exists at all: Google Flow refuses to render prompts naming real judges
 * ("This prompt might violate our policies about generating prominent people"), so the
 * one scene that must name the bench is rendered here instead. Flow still does the
 * whole story.
 *
 * Facts established by testing against the live API on 2026-09-10:
 *  - Build on **v3**. The v2 endpoints announce their own sunset on 2026-10-31.
 *  - `output_format: "webm"` returns genuine alpha, so no green screen and no keying.
 *    `ffprobe` reports `pix_fmt=yuv420p` for these files because VP9 keeps alpha in a
 *    side channel — that reading is a lie, decode a frame if you want to check. Also
 *    pass `-c:v libvpx-vp9` when decoding or ffmpeg picks a decoder that drops alpha.
 *  - With webm, `background` is rejected and background removal happens anyway.
 *  - Captions cost nothing to avoid: the subtitle file always comes back separately as
 *    `subtitle_url` and only burns in if `caption.style` is set. So omit `caption`.
 *  - A 17.6 s clip took ~95 s to render.
 */
import fs from 'fs';
import path from 'path';

const API = 'https://api.heygen.com';

function key(): string {
  const k = process.env.HEYGEN_API_KEY;
  if (!k) throw new Error('HEYGEN_API_KEY missing from .env');
  return k;
}

async function hg(pathname: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(API + pathname, {
    ...init,
    headers: { 'X-Api-Key': key(), ...(init.headers || {}) },
  });
  const text = await res.text();
  let json: any;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) {
    const msg = json?.error?.message || json?.message || text.slice(0, 300);
    throw new Error(`HeyGen ${res.status} ${pathname}: ${msg}`);
  }
  return json;
}

/** Upload an image file, returning its asset id. */
export async function uploadImage(file: string): Promise<string> {
  const buf = fs.readFileSync(file);
  const ext = path.extname(file).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : 'image/jpeg';
  const form = new FormData();
  form.append('file', new Blob([buf], { type: mime }), path.basename(file));
  const out = await hg('/v3/assets', { method: 'POST', body: form });
  const id = out?.data?.asset_id;
  if (!id) throw new Error('no asset_id in image upload response');
  console.log(`[heygen] uploaded ${path.basename(file)} -> ${id}`);
  return id;
}

/** Upload an audio file, returning its asset id. */
export async function uploadAudio(file: string): Promise<string> {
  const buf = fs.readFileSync(file);
  const MAX = 32 * 1024 * 1024;
  if (buf.length > MAX) {
    throw new Error(`${path.basename(file)} is ${(buf.length / 1e6).toFixed(1)} MB; HeyGen caps assets at 32 MB`);
  }
  const form = new FormData();
  form.append('file', new Blob([buf], { type: 'audio/mpeg' }), path.basename(file));
  const out = await hg('/v3/assets', { method: 'POST', body: form });
  const id = out?.data?.asset_id;
  if (!id) throw new Error('no asset_id in upload response');
  console.log(`[heygen] uploaded ${path.basename(file)} -> ${id}`);
  return id;
}

export interface RenderOptions {
  audioFile: string;
  outFile: string;
  aspectRatio?: '9:16' | '16:9' | '4:5' | '1:1';
  resolution?: '720p' | '1080p';
  /** Transparent webm (default). Set false for a flat mp4. */
  transparent?: boolean;
  /**
   * 'contain' fits the subject inside the canvas, 'cover' fills and crops.
   *
   * Tested 2026-09-10: switching this produced an identical render — the subject still
   * spanned 1070 of 1080 px — so HeyGen appears to ignore it for this avatar. The
   * margin in the finished frame comes from the 0.89 composite scale in shortsIntro,
   * not from here. Left in place, but do not reach for it to fix framing.
   */
  fit?: 'contain' | 'cover';
  /**
   * Rendering engine. Defaults to avatar_v: compared side by side against avatar_iv
   * (HeyGen's own default) on the same audio and avatar, v resolves noticeably more
   * skin texture and hair detail. Worth having, because the avatar's source still came
   * from a Google Flow clip and Flow caps at 720p — the engine is the only place left
   * to win detail back.
   */
  engine?: 'avatar_iii' | 'avatar_iv' | 'avatar_v';
  /**
   * Animate this still instead of a stored avatar (`type: "image"`).
   *
   * Preferred over HEYGEN_AVATAR_ID: the stored avatar was built from a tight crop of
   * an old clip, so HeyGen framed the subject shoulder-to-shoulder with no margin.
   * Pointing at a Flow-generated waist-up still puts the framing under our control and
   * keeps the intro presenter identical to the one Flow uses for the story.
   */
  sourceImage?: string;
  /** Image-source videos only: a hint for how the subject should move. */
  motionPrompt?: string;
  pollSeconds?: number;
  timeoutSeconds?: number;
}

/** Render the avatar speaking `audioFile`, and download the result to `outFile`. */
export async function renderAvatar(o: RenderOptions): Promise<string> {
  const avatar = process.env.HEYGEN_AVATAR_ID;
  const source = o.sourceImage || process.env.HEYGEN_SOURCE_IMAGE;
  if (!source && !avatar) throw new Error('set HEYGEN_SOURCE_IMAGE or HEYGEN_AVATAR_ID in .env');

  if (fs.existsSync(o.outFile) && fs.statSync(o.outFile).size > 10000) {
    console.log(`[heygen] reusing ${path.basename(o.outFile)} (delete it to re-render)`);
    return o.outFile;
  }

  const imageAssetId = source ? await uploadImage(source) : null;
  const assetId = await uploadAudio(o.audioFile);
  const transparent = o.transparent !== false;

  const created = await hg('/v3/videos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      // `engine` belongs to the avatar schema only — sending it with type:"image"
      // is rejected with "Extra inputs are not permitted". Image videos instead take
      // `motion_prompt` and `expressiveness`.
      ...(imageAssetId
        ? {
            type: 'image',
            image: { type: 'asset_id', asset_id: imageAssetId },
            ...(o.motionPrompt ? { motion_prompt: o.motionPrompt } : {}),
          }
        : {
            type: 'avatar',
            avatar_id: avatar,
            engine: { type: o.engine || 'avatar_v' },
          }),
      audio_asset_id: assetId,
      aspect_ratio: o.aspectRatio || '9:16',
      resolution: o.resolution || '1080p',
      fit: o.fit || 'contain',
      output_format: transparent ? 'webm' : 'mp4',
      title: `LawWorld ${path.basename(o.outFile, path.extname(o.outFile))}`,
      // No `caption` key: the sidecar subtitle is still produced, nothing is burned in.
    }),
  });

  const videoId = created?.data?.video_id;
  if (!videoId) throw new Error('no video_id in create response');
  console.log(`[heygen] rendering ${videoId} (${transparent ? 'transparent webm' : 'mp4'}, ${o.aspectRatio || '9:16'}, ${o.engine || 'avatar_v'})`);

  const every = (o.pollSeconds ?? 10) * 1000;
  const deadline = Date.now() + (o.timeoutSeconds ?? 900) * 1000;
  let url: string | undefined;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, every));
    const s = await hg(`/v3/videos/${videoId}`);
    const status = s?.data?.status;
    if (status === 'completed') {
      url = s.data.video_url || s.data.url;
      break;
    }
    if (status === 'failed' || status === 'error') {
      throw new Error(`HeyGen render failed: ${JSON.stringify(s?.data?.error || s?.data).slice(0, 300)}`);
    }
    process.stdout.write('.');
  }
  process.stdout.write('\n');
  if (!url) throw new Error(`HeyGen render did not finish within ${o.timeoutSeconds ?? 900}s (video_id ${videoId})`);

  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  fs.mkdirSync(path.dirname(o.outFile), { recursive: true });
  fs.writeFileSync(o.outFile, Buffer.from(await res.arrayBuffer()));
  const mb = (fs.statSync(o.outFile).size / 1e6).toFixed(1);
  console.log(`[heygen] wrote ${path.basename(o.outFile)} (${mb} MB)`);
  return o.outFile;
}

/** Wallet balance and remaining API credits, for a pre-flight check. */
export async function account(): Promise<{ balance: number; email: string }> {
  const me = await hg('/v3/users/me');
  return { balance: me?.data?.wallet?.remaining_balance ?? 0, email: me?.data?.email ?? '' };
}
