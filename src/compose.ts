/**
 * Split-screen compositor with captions.
 *   TOP box    = B-roll animation for the scene (downloads/<project>/broll/<sceneId>_broll.mp4)
 *   BOTTOM box = the avatar clip cropped to head + shoulders, with big word-timed captions of the dialogue
 * Writes composed/<sceneId>.mp4 per scene, then merges them into one video.
 *
 *   npx tsx src/compose.ts [--config storyboard.json] [--no-captions]
 *
 * Caption timing: the avatar clip's speech segments are detected (silencedetect) and the dialogue words are
 * distributed across them proportionally, in 2–3 word chunks — the same technique auto-caption tools use when
 * no transcript timestamps exist. If a scene has no B-roll yet, the top box is a blurred zoom of the avatar clip.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { CONFIG } from './config';
import { FFmpegMerger } from './merger';
import { StoryboardConfig } from './types';

const args = process.argv.slice(2);
const cfgArg = args.indexOf('--config');
const configPath = path.resolve(process.cwd(), cfgArg >= 0 && args[cfgArg + 1] ? args[cfgArg + 1] : 'storyboard.json');
const withCaptions = !args.includes('--no-captions');
const limArg = args.indexOf('--limit');
const limit = limArg >= 0 && args[limArg + 1] ? parseInt(args[limArg + 1], 10) : 0;   // preview: first N scenes only
const config: StoryboardConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

const split = (config as any).split || {};

// "vertical" = the original 720x1280 two-box short. "landscape" = 1920x1080 for YouTube:
// full-frame B-roll with the presenter in a picture-in-picture box, so the avatar is on screen
// at all times while the animation carries the visual explanation.
const layout: 'vertical' | 'landscape' =
  args.includes('--landscape') ? 'landscape'
  : args.includes('--vertical') ? 'vertical'
  : ((config as any).layout === 'landscape' ? 'landscape' : 'vertical');
const isLandscape = layout === 'landscape';

const projectDir = config.downloadFolder
  ? path.resolve(process.cwd(), config.downloadFolder)
  : path.join(CONFIG.DOWNLOAD_DIR, config.projectTitle);
// B-roll style "2d" (default) or "realistic": separate clip + output folders so both versions can coexist
const styleRaw = String((config as any).brollStyle || '2d');
const brollStyle = ['realistic', '3d'].includes(styleRaw) ? styleRaw : '2d';
const STYLE_DIRS: Record<string, { broll: string; out: string; suffix: string }> = {
  '2d': { broll: 'broll', out: 'composed', suffix: '' },
  realistic: { broll: 'broll_realistic', out: 'composed_realistic', suffix: '_Realistic' },
  '3d': { broll: 'broll_3d', out: 'composed_3d', suffix: '_3D' }
};
const brollDir = path.join(projectDir, STYLE_DIRS[brollStyle].broll);
const outDir = path.join(projectDir, STYLE_DIRS[brollStyle].out + (isLandscape ? '_16x9' : ''));
const finalTitle = `${config.projectTitle}_${isLandscape ? 'YouTube16x9' : 'Split'}${STYLE_DIRS[brollStyle].suffix}`;
console.log(`[Compose] Style: ${brollStyle}; B-roll from ${path.relative(process.cwd(), brollDir)}; output ${path.relative(process.cwd(), outDir)}${limit ? `; first ${limit} scene(s) only` : ''}`);
const capDir = path.join(outDir, 'captions');
fs.mkdirSync(capDir, { recursive: true });

const W = isLandscape ? 1920 : 720;
const H = isLandscape ? 1080 : 1280;
const HALF = 640;                       // vertical layout only: height of each stacked box
const avatarCropY: number = split.avatarCropY ?? 180;

/**
 * Flow burns a sparkle watermark ~119px in from the bottom-right corner of every clip it generates.
 * The vertical layout removed it by accident (its avatar crop stops at y=820); landscape has to be
 * explicit. These are crop windows that end before the watermark starts.
 *   avatar 720x1280  -> keep the top 1100px      (watermark band is y 1135..1187)
 *   b-roll 1280x720  -> keep 1137x640 from 0,0   (an exact 16:9 window left of the watermark)
 */
const AVATAR_SAFE_H: number = split.avatarSafeHeight ?? 1100;
const BROLL_SAFE = split.brollSafeCrop ?? 'crop=trunc(iw*0.888/2)*2:trunc(ih*0.888/2)*2:0:0';

// Presenter picture-in-picture box (landscape only)
const pipW: number = split.pipWidth ?? 380;
const pipCropY: number = split.pipCropY ?? 110;      // top of the head+shoulders window
const pipCropH: number = split.pipCropH ?? 990;      // must keep pipCropY + pipCropH <= AVATAR_SAFE_H + pipCropY
const pipMarginX: number = split.pipMarginX ?? 50;
const pipMarginY: number = split.pipMarginY ?? 200;   // keeps the PiP above the bottom caption band
const pipBorder: number = split.pipBorder ?? 8;

/**
 * Cutout ("sticker") mode: the presenter is keyed off a green screen and floats over the animation with no
 * box and no border. Only works on clips generated against green — keying the grey studio background removes
 * the presenter's face too, because skin sits inside the grey's colour range (measured distance 0.257, i.e.
 * closer to the key colour than the 0.30 similarity that was tried first).
 * Defaults below are the values verified against a real green-screen clip: face, hair and white shirt all
 * survive untouched while the background keys out completely. Do not raise `similarity` past ~0.20.
 */
const cutout: boolean = split.cutout === true;
const cutoutKey: string = split.cutoutKey || '0x67AB72';
const cutoutSimilarity: number = split.cutoutSimilarity ?? 0.12;
const cutoutBlend: number = split.cutoutBlend ?? 0.04;

/**
 * Bubble ("cam") mode: the presenter sits in a round webcam bubble with a thin ring, the way a
 * screen-recording talking head does. Unlike cutout mode this needs no green screen and no key -
 * the circular mask simply hides the studio background, so the original grey clips work as they are.
 */
const bubble: boolean = split.bubble === true && isLandscape;
const bubbleD: number = Math.round((split.bubbleDiameter ?? 320) / 2) * 2;
const bubbleBorder: number = split.bubbleBorder ?? 6;
const bubbleOuter: number = bubbleD + 2 * bubbleBorder;
const bubbleBorderColor: string = split.bubbleBorderColor || 'white';
// Square window cut from the 720x1280 presenter clip; the circle is inscribed in it.
const bubbleCrop: number = split.bubbleCropSize ?? 640;
const bubbleCropX: number = split.bubbleCropX ?? 40;
const bubbleCropY: number = split.bubbleCropY ?? 160;
const bubbleMarginX: number = split.bubbleMarginX ?? 60;
const bubbleMarginY: number = split.bubbleMarginY ?? 150;
const FALLBACK_FONTS = [
  'C:/Windows/Fonts/impact.ttf',                          // Windows
  '/System/Library/Fonts/Supplemental/Impact.ttf',        // macOS
  '/Library/Fonts/Impact.ttf',
  '/usr/share/fonts/truetype/msttcorefonts/Impact.ttf',   // Linux
  '/System/Library/Fonts/Supplemental/Arial Bold.ttf'     // macOS last resort
];
const fontFile: string = split.captionFont || FALLBACK_FONTS.find(f => fs.existsSync(f)) || '';
if (withCaptions && !fontFile) {
  console.error('[Compose] No caption font found. Set "split.captionFont" in the storyboard to a .ttf path.');
  process.exit(1);
}
const fontSize: number = isLandscape ? (split.captionSizeLandscape ?? 72) : (split.captionSize || 60);
const captionY: number = isLandscape ? (split.captionYLandscape ?? (H - 150)) : (split.captionY ?? (HALF - 200));
const fontSizeDefault = isLandscape ? 72 : 60;
const caseMarkerSize: number = split.caseMarkerSize || 44;
const caseMarkerSeconds: number = split.caseMarkerSeconds ?? 3.5;
const KEYWORDS: string[] = split.captionKeywords || ['law', 'court', 'company', 'intent', 'liability', 'accused', 'prosecution', 'guilt', 'directing', 'mind', 'attribution', 'doctor', 'doctors', 'hospital', 'shield', 'promise', 'brochure', 'lawworld'];

const bubbleMaskPath = path.join(capDir, `_bubble_mask_${bubbleD}.png`);
const bubbleRingPath = path.join(capDir, `_bubble_ring_${bubbleOuter}.png`);
if (bubble) {
  const r = bubbleD / 2 - 1, c = bubbleD / 2;
  const ro = bubbleOuter / 2 - 1, co = bubbleOuter / 2;
  // 1px feather on both masks keeps the circle edge smooth instead of stair-stepped.
  if (!fs.existsSync(bubbleMaskPath))
    execSync(`ffmpeg -v error -y -f lavfi -i color=black:s=${bubbleD}x${bubbleD} -vf "geq=lum='clip((${r}-hypot(X-${c},Y-${c}))*255,0,255)',format=gray" -frames:v 1 "${bubbleMaskPath}"`);
  if (!fs.existsSync(bubbleRingPath))
    execSync(`ffmpeg -v error -y -f lavfi -i color=${bubbleBorderColor}:s=${bubbleOuter}x${bubbleOuter} -vf "format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='clip((${ro}-hypot(X-${co},Y-${co}))*255,0,255)'" -frames:v 1 "${bubbleRingPath}"`);
  console.log(`[Compose] Bubble cam: ${bubbleD}px circle + ${bubbleBorder}px ${bubbleBorderColor} ring, bottom-right`);
}

const ffEsc = (p: string) => p.replace(/\\/g, '/').replace(/:/g, '\\:');

/**
 * ffmpeg 8/9 removed -filter_complex_script in favour of the generic "read this option's value from a
 * file" syntax (-/filter_complex FILE). Older builds — including the Windows ffmpeg this project ran on
 * before — only understand the old flag. The graphs here are far too long for a command line (the
 * caption drawtext chain alone runs to thousands of characters), so a file is required either way.
 */
const FILTER_SCRIPT_FLAG: string = (() => {
  try {
    const help = execSync('ffmpeg -hide_banner -h full', { stdio: 'pipe', maxBuffer: 64 * 1024 * 1024 }).toString();
    if (help.includes('filter_complex_script')) return '-filter_complex_script';
  } catch { /* fall through to the modern syntax */ }
  return '-/filter_complex';
})();

function duration(file: string): number {
  return parseFloat(execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${file}"`).toString().trim()) || 10;
}

/**
 * Flow sometimes returns a clip with baked-in letterbox bars (a 2.35:1 image inside a 16:9 file). Those bars would
 * survive the scale+crop into the top box, so detect them and crop them away first. Returns a "crop=w:h:x:y" filter,
 * or null when the frame is already full-bleed.
 */
function letterboxCrop(file: string): string | null {
  try {
    const out = execSync(`ffmpeg -hide_banner -ss 3 -i "${file}" -vf cropdetect=24:2:0 -frames:v 30 -f null - 2>&1`, { stdio: 'pipe' }).toString();
    const m = [...out.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)].pop();
    if (!m) return null;
    const [w, h] = [parseInt(m[1], 10), parseInt(m[2], 10)];
    const probe = execSync(`ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "${file}"`).toString().trim().split(',');
    const [fw, fh] = [parseInt(probe[0], 10), parseInt(probe[1], 10)];
    // ignore no-op and implausible detections (a very dark shot can fool cropdetect)
    if (w === fw && h === fh) return null;
    if (w < fw * 0.6 || h < fh * 0.5) return null;
    return `crop=${m[1]}:${m[2]}:${m[3]}:${m[4]}`;
  } catch { return null; }
}

function speechSegments(file: string, dur: number): [number, number][] {
  const out = execSync(`ffmpeg -hide_banner -i "${file}" -af silencedetect=noise=-35dB:d=0.25 -f null - 2>&1`, { stdio: 'pipe' }).toString();
  const starts = [...out.matchAll(/silence_start: ([\d.]+)/g)].map(m => parseFloat(m[1]));
  const ends = [...out.matchAll(/silence_end: ([\d.]+)/g)].map(m => parseFloat(m[1]));
  const silences: [number, number][] = starts.map((s, i) => [s, ends[i] ?? dur]);
  const segs: [number, number][] = [];
  let cursor = 0;
  for (const [s, e] of silences) {
    if (s - cursor > 0.15) segs.push([cursor, s]);
    cursor = e;
  }
  if (dur - cursor > 0.15) segs.push([cursor, dur]);
  return segs.length ? segs : [[0.2, dur - 0.2]];
}

function captionChunks(dialogue: string, segs: [number, number][]): { text: string; start: number; end: number }[] {
  const words = dialogue.replace(/\s+/g, ' ').trim().split(' ');
  const total = segs.reduce((a, [s, e]) => a + (e - s), 0);
  const chunks: { text: string; start: number; end: number }[] = [];
  let wi = 0;
  segs.forEach(([s, e], idx) => {
    const share = (e - s) / total;
    let count = idx === segs.length - 1 ? words.length - wi : Math.round(words.length * share);
    count = Math.max(0, Math.min(count, words.length - wi));
    const segWords = words.slice(wi, wi + count);
    wi += count;
    if (!segWords.length) return;
    // 2–3 word groups that never run across a sentence boundary (. ? ! :)
    const groups: string[][] = [];
    let cur: string[] = [];
    for (const w of segWords) {
      cur.push(w);
      const endsSentence = /[.?!:]$/.test(w);
      if (cur.length >= 3 || endsSentence) { groups.push(cur); cur = []; }
    }
    if (cur.length) {
      // avoid a lonely 1-word tail: merge it into the previous group when possible
      if (cur.length === 1 && groups.length && groups[groups.length - 1].length < 3 && !/[.?!:]$/.test(groups[groups.length - 1].slice(-1)[0])) groups[groups.length - 1].push(cur[0]);
      else groups.push(cur);
    }
    const chars = groups.reduce((a, g) => a + g.join(' ').length, 0) || 1;
    let t = s;
    groups.forEach(g => {
      const d = (e - s) * (g.join(' ').length / chars);
      chunks.push({ text: g.join(' ').replace(/[.,:;]$/, ''), start: t, end: Math.min(e, t + d) });
      t += d;
    });
  });
  // hold each caption until the next one appears (no blank gaps during short pauses)
  for (let i = 0; i < chunks.length - 1; i++) chunks[i].end = chunks[i + 1].start;
  return chunks;
}

function drawtextChain(chunks: { text: string; start: number; end: number }[], sceneId: string): string {
  return chunks.map((c, i) => {
    const file = path.join(capDir, `${sceneId}_${String(i).padStart(2, '0')}.txt`);
    fs.writeFileSync(file, c.text.toUpperCase());
    const hot = KEYWORDS.some(k => c.text.toLowerCase().includes(k));
    return `drawtext=fontfile='${ffEsc(fontFile)}':textfile='${ffEsc(file)}':fontsize=${fontSize}:fontcolor=${hot ? '#FFD400' : 'white'}` +
      `:borderw=6:bordercolor=black:x=(w-text_w)/2:y=${captionY}:enable='between(t,${c.start.toFixed(2)},${c.end.toFixed(2)})'`;
  }).join(',');
}

/**
 * "CASE 2 - Cheque Dishonour" chapter marker, shown for the first few seconds of a judgment's opening scene.
 * Drawn on the bottom (avatar) stream just under the split line, so it never collides with the captions lower down.
 * Text goes through a file like the captions do, so apostrophes and commas need no ffmpeg escaping.
 */
function caseMarkerFilter(scene: any, sceneId: string): string {
  if (!scene.caseTitle) return '';
  const label = (scene.caseNumber ? `CASE ${scene.caseNumber}  -  ` : '') + String(scene.caseTitle);
  const file = path.join(capDir, `${sceneId}_case.txt`);
  fs.writeFileSync(file, label.toUpperCase());
  return `drawtext=fontfile='${ffEsc(fontFile)}':textfile='${ffEsc(file)}':fontsize=${caseMarkerSize}` +
    `:fontcolor=white:borderw=4:bordercolor=black:box=1:boxcolor=black@0.55:boxborderw=18` +
    `:x=${isLandscape ? '60' : '(w-text_w)/2'}:y=${isLandscape ? 55 : 34}:enable='between(t,0,${caseMarkerSeconds})'`;
}

let composed = 0;
for (const [sceneIdx, scene] of config.scenes.entries()) {
  if (limit && sceneIdx >= limit) break;
  const avatar = path.join(projectDir, `${scene.sceneId}.mp4`);
  if (!fs.existsSync(avatar)) { console.log(`[Compose] ${scene.sceneId}: avatar clip missing, skipped`); continue; }
  const broll = path.join(brollDir, `${scene.sceneId}_broll.mp4`);
  const hasBroll = fs.existsSync(broll);
  const out = path.join(outDir, `${scene.sceneId}.mp4`);

  const dur = duration(avatar);
  const capChain = withCaptions ? drawtextChain(captionChunks(scene.dialogue, speechSegments(avatar, dur)), scene.sceneId) : '';
  const marker = caseMarkerFilter(scene, scene.sceneId);
  if (marker) console.log(`[Compose] ${scene.sceneId}: case marker "${scene.caseNumber ? 'CASE ' + scene.caseNumber + ' - ' : ''}${scene.caseTitle}"`);
  const caps = [capChain, marker].filter(Boolean).join(',');
  const deBar = hasBroll ? letterboxCrop(broll) : null;
  if (deBar) console.log(`[Compose] ${scene.sceneId}: letterbox bars removed from B-roll (${deBar})`);

  let graph: string;
  if (isLandscape) {
    // Full-frame B-roll behind a presenter PiP, so the avatar is visible for the whole clip.
    // Both the letterbox crop and the watermark crop are applied, in that order.
    const brollChain = [deBar, BROLL_SAFE].filter(Boolean).join(',');
    const pipH = Math.round(pipW * pipCropH / 720 / 2) * 2;
    // The two circle masks are the last inputs, so their index depends on whether B-roll is present.
    const mIdx = hasBroll ? 2 : 1;
    const boxW = bubble ? bubbleOuter : cutout ? pipW : pipW + 2 * pipBorder;
    const boxH = bubble ? bubbleOuter : cutout ? pipH : pipH + 2 * pipBorder;
    const marX = bubble ? bubbleMarginX : pipMarginX;
    const marY = bubble ? bubbleMarginY : pipMarginY;
    const pipChain = bubble
      // Round cam: mask the presenter to a circle, then seat that circle on the ring disc.
      ? `crop=${bubbleCrop}:${bubbleCrop}:${bubbleCropX}:${bubbleCropY},scale=${bubbleD}:${bubbleD},setsar=1,format=rgba[bubsrc];`
        + `[bubsrc][${mIdx}:v]alphamerge[bubcam];[${mIdx + 1}:v]format=rgba[bubring];`
        + `[bubring][bubcam]overlay=${bubbleBorder}:${bubbleBorder}:format=auto`
      : cutout
      // key first, at full resolution, so scaling cannot soften the edge before the key sees it
      ? `crop=720:${pipCropH}:0:${pipCropY},colorkey=${cutoutKey}:${cutoutSimilarity}:${cutoutBlend},`
        + `scale=${pipW}:${pipH},setsar=1`
      : `crop=720:${pipCropH}:0:${pipCropY},scale=${pipW}:${pipH},`
        + `pad=${boxW}:${boxH}:${pipBorder}:${pipBorder}:white@0.9,setsar=1`;
    // format=auto keeps the keyed/masked alpha channel through the overlay
    const ov = `overlay=${W - boxW - marX}:${H - boxH - marY}${cutout || bubble ? ':format=auto' : ''}`;
    const post = `${caps ? ',' + caps : ''},format=yuv420p[v]`;

    graph = hasBroll
      ? `[1:v]${brollChain},scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=24,setsar=1[bg];`
        + `[0:v]${pipChain}[pip];[bg][pip]${ov}${post}`
      // No B-roll yet: blurred zoom of the avatar itself fills the frame behind the PiP.
      : `[0:v]split=2[s0][s1];`
        + `[s0]crop=720:${AVATAR_SAFE_H}:0:0,scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=20:2,fps=24,setsar=1[bg];`
        + `[s1]${pipChain}[pip];[bg][pip]${ov}${post}`;
  } else {
    const bottom = `[0:v]crop=${W}:${HALF}:0:${avatarCropY}${caps ? ',' + caps : ''}[bottom]`;
    const top = hasBroll
      ? `[1:v]${deBar ? deBar + ',' : ''}scale=${W}:${HALF}:force_original_aspect_ratio=increase,crop=${W}:${HALF},fps=24,setsar=1[top]`
      : `[0:v]crop=${W}:${HALF}:0:0,boxblur=12:2,scale=${Math.round(W * 1.15)}:${Math.round(HALF * 1.15)},crop=${W}:${HALF},setsar=1[top]`;
    graph = hasBroll
      ? `${bottom};${top};[top][bottom]vstack=2,format=yuv420p[v]`
      : `[0:v]split=2[s0][s1];[s0]crop=${W}:${HALF}:0:${avatarCropY}${caps ? ',' + caps : ''}[bottom];[s1]crop=${W}:${HALF}:0:0,boxblur=12:2,scale=${Math.round(W * 1.15)}:${Math.round(HALF * 1.15)},crop=${W}:${HALF},setsar=1[top];[top][bottom]vstack=2,format=yuv420p[v]`;
  }

  const script = path.join(capDir, `${scene.sceneId}.filter`);
  fs.writeFileSync(script, graph);
  const inputs = (hasBroll ? `-i "${avatar}" -i "${broll}"` : `-i "${avatar}"`)
    + (bubble ? ` -loop 1 -i "${bubbleMaskPath}" -loop 1 -i "${bubbleRingPath}"` : '');
  const cmd = `ffmpeg -y ${inputs} ${FILTER_SCRIPT_FLAG} "${script}" -map "[v]" -map 0:a -shortest -c:v libx264 -preset medium -crf 18 -c:a aac -b:a 192k -movflags +faststart "${out}"`;
  try {
    execSync(cmd, { stdio: 'pipe' });
    composed++;
    console.log(`[Compose] ${scene.sceneId}: ${isLandscape ? `${W}x${H} ${hasBroll ? 'B-roll bg' : 'blurred bg'} + presenter PiP` : `${hasBroll ? 'B-roll' : 'blurred fallback'} top + avatar bottom`}${withCaptions ? ' + captions' : ''} -> ${path.relative(process.cwd(), out)}`);
  } catch (err) {
    console.error(`[Compose] ${scene.sceneId}: ffmpeg failed: ${(err as Error).message.split('\n').slice(-3).join(' | ')}`);
  }
}

if (composed > 0) {
  const final = FFmpegMerger.mergeScenes(outDir, finalTitle, config.speedMultiplier || 1,
    config.transition || { type: 'crossfade', durationSeconds: 0.25 });
  console.log(`[Compose] Done: ${composed} scene(s). Final: ${final || '(merge failed)'}`);
} else {
  console.log('[Compose] Nothing composed.');
}
