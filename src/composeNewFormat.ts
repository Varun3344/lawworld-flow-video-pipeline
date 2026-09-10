/**
 * New-format compositor for the explainer / news-roundup style.
 *
 * Three per-scene visual modes, every one of them driven by that scene's own audio so the voice track never
 * breaks even when the presenter is off screen:
 *   "presenter" - presenter fills the right of the frame, headline on a dark panel to the left
 *   "card"      - no presenter at all: a dark text card whose lines land one at a time as he says them
 *   "broll"     - full-frame photoreal B-roll, text over a gradient scrim, presenter optionally in a bubble
 *
 *   npx tsx src/composeNewFormat.ts --config <storyboard.json> --edit <edit.json> [--limit N] [--no-merge]
 *
 * The storyboard supplies the clips and the audio; the edit file supplies the treatment per scene, so the
 * visual cut can be reworked as often as you like without regenerating anything in Flow.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { FFmpegMerger } from './merger';
import { StoryboardConfig } from './types';

const args = process.argv.slice(2);
const flag = (name: string, def?: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def;
};
const configPath = path.resolve(process.cwd(), flag('--config', 'storyboard.json')!);
const editArg = flag('--edit');
if (!editArg) { console.error('[NewFormat] --edit <edit.json> is required'); process.exit(1); }
const editPath = path.resolve(process.cwd(), editArg);
const limit = parseInt(flag('--limit', '0')!, 10);
const doMerge = !args.includes('--no-merge');

const config: StoryboardConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

interface Line { text: string; size?: number; y: number; at: number; color?: string; hold?: number }
interface SceneEdit {
  mode: 'talking' | 'presenter' | 'card' | 'broll';
  chip?: string; headline?: string; sub?: string;
  lines?: Line[]; bubble?: boolean;
  captions?: boolean;      // kinetic word-timed captions burned over the shot
  accent?: string;         // caption highlight colour (default: the reference's bright green)
  keywords?: string[];     // which words get the accent colour
  scrim?: boolean;         // "broll" mode: false = full-bleed footage, no dark gradient
  title?: string;          // "broll" mode: one big centred title over the footage
  captionY?: number;
}
const edit: { scenes: Record<string, SceneEdit> } = JSON.parse(fs.readFileSync(editPath, 'utf-8'));

const W = 1920, H = 1080;
const PALETTE: Record<string, string> = { ink: '0xF2F4F8', amber: '0xFFC13B', muted: '0x99A1B3', white: '0xFFFFFF' };
const FONTS = ['/System/Library/Fonts/Supplemental/Arial Black.ttf', 'C:/Windows/Fonts/ariblk.ttf'];
const FONTS_BOLD = ['/System/Library/Fonts/Supplemental/Arial Bold.ttf', 'C:/Windows/Fonts/arialbd.ttf'];
const BLACK = FONTS.find(f => fs.existsSync(f)) || '';
const BOLD = FONTS_BOLD.find(f => fs.existsSync(f)) || BLACK;
if (!BLACK) { console.error('[NewFormat] No heavy sans font found (Arial Black).'); process.exit(1); }

// Flow burns a sparkle watermark into the bottom-right of every clip; these windows stop before it.
const BROLL_SAFE = 'crop=trunc(iw*0.888/2)*2:trunc(ih*0.888/2)*2:0:0';
const AVATAR_SAFE_H = 1100;
const BUBBLE_D = 300, BUBBLE_B = 6, BUBBLE_OUT = BUBBLE_D + 2 * BUBBLE_B;

const projectDir = path.resolve(process.cwd(), config.downloadFolder || `./downloads/${config.projectTitle}`);
const brollDir = path.join(projectDir, config.brollStyle === 'realistic' ? 'broll_realistic' : config.brollStyle === '3d' ? 'broll_3d' : 'broll');
const outDir = path.join(projectDir, 'newformat');
const assetDir = path.join(outDir, 'assets');
fs.mkdirSync(assetDir, { recursive: true });

const FILTER_SCRIPT_FLAG: string = (() => {
  try {
    const help = execSync('ffmpeg -hide_banner -h full', { stdio: 'pipe', maxBuffer: 64 * 1024 * 1024 }).toString();
    if (help.includes('filter_complex_script')) return '-filter_complex_script';
  } catch { /* fall through */ }
  return '-/filter_complex';
})();

/** Static backdrops are rendered once as stills — as per-frame geq they were ~100x slower. */
function ensureAssets() {
  const glow = path.join(assetDir, 'card_bg.png');
  const scrim = path.join(assetDir, 'scrim.png');
  const mask = path.join(assetDir, `mask_${BUBBLE_D}.png`);
  const ring = path.join(assetDir, `ring_${BUBBLE_OUT}.png`);
  if (!fs.existsSync(glow))
    execSync(`ffmpeg -v error -y -f lavfi -i color=0x0B0D13:s=${W}x${H} -vf "format=rgba,`
      + `geq=r='r(X,Y)+22*exp(-((X-560)^2+(Y-540)^2)/900000)':g='g(X,Y)+16*exp(-((X-560)^2+(Y-540)^2)/900000)'`
      + `:b='b(X,Y)+6*exp(-((X-560)^2+(Y-540)^2)/900000)':a='255',`
      // a little grain dithers the gradient; without it the glow shows concentric 8-bit banding rings
      + `noise=alls=7:allf=t" -frames:v 1 "${glow}"`);
  // Left-to-right dark gradient so text stays readable over live-action footage.
  if (!fs.existsSync(scrim))
    execSync(`ffmpeg -v error -y -f lavfi -i color=0x07090E:s=${W}x${H} -vf "format=rgba,`
      + `geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='238*clip((1180-X)/820,0,1)'" -frames:v 1 "${scrim}"`);
  if (!fs.existsSync(mask))
    execSync(`ffmpeg -v error -y -f lavfi -i color=black:s=${BUBBLE_D}x${BUBBLE_D} -vf `
      + `"geq=lum='clip((${BUBBLE_D / 2 - 1}-hypot(X-${BUBBLE_D / 2},Y-${BUBBLE_D / 2}))*255,0,255)',format=gray" -frames:v 1 "${mask}"`);
  if (!fs.existsSync(ring))
    execSync(`ffmpeg -v error -y -f lavfi -i color=white:s=${BUBBLE_OUT}x${BUBBLE_OUT} -vf "format=rgba,`
      + `geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='clip((${BUBBLE_OUT / 2 - 1}-hypot(X-${BUBBLE_OUT / 2},Y-${BUBBLE_OUT / 2}))*255,0,255)'" -frames:v 1 "${ring}"`);
  return { glow, scrim, mask, ring };
}

const esc = (t: string) => t.replace(/\\/g, '').replace(/:/g, '\\:').replace(/'/g, '').replace(/,/g, '\\,').replace(/%/g, '\\%');

/** One line that fades in and eases up into place at `at` seconds. Commas inside the easing must stay quoted. */
function dt(text: string, font: string, size: number, color: string, x: number, y: number, at: number, hold?: number) {
  const p = `clip((t-${at})/0.35,0,1)`;
  const a = hold ? `(${p})*clip((${at}+${hold}-t)/0.3,0,1)` : p;
  return `drawtext=fontfile='${font}':text='${esc(text)}':fontsize=${size}:fontcolor=${color}`
    + `:x=${x}:y='(${y})+22*(1-${p})':alpha='${a}'`;
}

function textChain(e: SceneEdit): string {
  const parts: string[] = [];
  if (e.chip) {
    parts.push(`drawbox=x=110:y=96:w=${48 + e.chip.length * 23}:h=62:color=${PALETTE.amber}@0.16:t=fill`);
    parts.push(`drawtext=fontfile='${BOLD}':text='${esc(e.chip)}':fontsize=34:fontcolor=${PALETTE.amber}:x=134:y=114`);
  }
  for (const l of e.lines || []) {
    const size = l.size ?? 64;
    parts.push(dt(l.text, size >= 66 ? BLACK : BOLD, size, PALETTE[l.color || 'ink'] || PALETTE.ink, 110, l.y, l.at, l.hold));
  }
  return parts.join(',');
}


/** Word-timed kinetic captions, the signature of the reference style: 2-3 words at a time, big and
 *  left-aligned, with the key word flipped to the accent colour. Timing comes from the clip's own audio. */
function duration(file: string): number {
  return parseFloat(execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${file}"`).toString().trim()) || 10;
}

function speechSegments(file: string, dur: number): [number, number][] {
  const out = execSync(`ffmpeg -hide_banner -i "${file}" -af silencedetect=noise=-35dB:d=0.25 -f null - 2>&1`, { stdio: 'pipe' }).toString();
  const starts = [...out.matchAll(/silence_start: ([\d.]+)/g)].map(m => parseFloat(m[1]));
  const ends = [...out.matchAll(/silence_end: ([\d.]+)/g)].map(m => parseFloat(m[1]));
  const segs: [number, number][] = [];
  let cursor = 0;
  starts.forEach((st, i) => {
    if (st - cursor > 0.15) segs.push([cursor, st]);
    cursor = ends[i] ?? dur;
  });
  if (dur - cursor > 0.15) segs.push([cursor, dur]);
  return segs.length ? segs : [[0.2, dur - 0.2]];
}

function captionChunks(dialogue: string, segs: [number, number][]) {
  const words = dialogue.replace(/\s+/g, ' ').trim().split(' ');
  const total = segs.reduce((a, [s, e]) => a + (e - s), 0);
  const chunks: { text: string; start: number; end: number }[] = [];
  let wi = 0;
  segs.forEach(([s, e], idx) => {
    let count = idx === segs.length - 1 ? words.length - wi : Math.round(words.length * ((e - s) / total));
    count = Math.max(0, Math.min(count, words.length - wi));
    const segWords = words.slice(wi, wi + count); wi += count;
    if (!segWords.length) return;
    const groups: string[][] = []; let cur: string[] = [];
    for (const w of segWords) {
      cur.push(w);
      if (cur.length >= 3 || /[.?!:]$/.test(w)) { groups.push(cur); cur = []; }
    }
    if (cur.length) {
      const last = groups[groups.length - 1];
      if (cur.length === 1 && last && last.length < 3 && !/[.?!:]$/.test(last.slice(-1)[0])) last.push(cur[0]);
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
  for (let i = 0; i < chunks.length - 1; i++) chunks[i].end = chunks[i + 1].start;
  return chunks;
}

function kineticChain(sceneId: string, dialogue: string, avatar: string, accent: string, keywords: string[], y: number): string {
  const chunks = captionChunks(dialogue, speechSegments(avatar, duration(avatar)));
  const parts: string[] = [];
  chunks.forEach((c, i) => {
    // The reference stacks each word on its own line and colours only the word that matters. Colouring a
    // whole 2-3 word chunk (the first attempt) turned entire phrases green and lost the emphasis.
    const words = c.text.split(' ').filter(Boolean);
    words.forEach((w, j) => {
      const f = path.join(assetDir, `${sceneId}_cap${String(i).padStart(2, '0')}_${j}.txt`);
      fs.writeFileSync(f, w.toUpperCase());
      const hot = keywords.some(k => w.toLowerCase().replace(/[^a-z]/g, '').includes(k.toLowerCase()));
      parts.push(`drawtext=fontfile='${hot ? BLACK : BOLD}':textfile='${f}':fontsize=${hot ? 92 : 78}`
        + `:fontcolor=${hot ? accent : PALETTE.white}`
        + `:borderw=5:bordercolor=0x0A0C10@0.8:shadowx=0:shadowy=4:shadowcolor=0x000000@0.4`
        + `:x=110:y=${y + j * 96}:enable='between(t,${c.start.toFixed(2)},${c.end.toFixed(2)})'`);
    });
  });
  return parts.join(',');
}

function probeWH(file: string): { w: number; h: number } {
  const out = execSync(`ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "${file}"`).toString().trim().split(',');
  return { w: parseInt(out[0], 10) || 720, h: parseInt(out[1], 10) || 1280 };
}

const A = ensureAssets();

function compose(sceneId: string, e: SceneEdit): string | null {
  const avatar = path.join(projectDir, `${sceneId}.mp4`);
  const broll = path.join(brollDir, `${sceneId}_broll.mp4`);
  if (!fs.existsSync(avatar)) { console.warn(`[NewFormat] ${sceneId}: presenter clip missing, skipped`); return null; }
  const hasBroll = fs.existsSync(broll);
  const out = path.join(outDir, `${sceneId}.mp4`);
  const txt = textChain(e);

  let inputs: string[] = [];
  let graph = '';
  const bubbleOn = e.bubble === true;
  // [presenter, ...extras] — the bubble masks always come last so their indices are predictable.
  const bubbleChain = (base: string, idx: number) =>
    `[0:v]${bubCrop},scale=${BUBBLE_D}:${BUBBLE_D},setsar=1,format=rgba[bs];`
    + `[bs][${idx}:v]alphamerge[bc];[${idx + 1}:v]format=rgba[br];[br][bc]overlay=${BUBBLE_B}:${BUBBLE_B}:format=auto[pip];`
    + `[${base}][pip]overlay=${W - BUBBLE_OUT - 60}:${H - BUBBLE_OUT - 130}:format=auto[v]`;

  // A 16:9 presenter clip already fills the frame; a 9:16 one has to be centred on a blurred fill of itself.
  const av = probeWH(avatar);
  const avWide = av.w > av.h;
  const bubSide = avWide ? Math.round(av.h * 0.66 / 2) * 2 : 640;
  const bubCrop = avWide
    ? `crop=${bubSide}:${bubSide}:${Math.round((av.w - bubSide) / 4) * 2}:${Math.round(av.h * 0.04 / 2) * 2}`
    : `crop=640:640:40:160`;
  const accent = e.accent || '0x9EE84B';
  const kw = e.keywords || [];
  const dialogue = (config.scenes.find(x => x.sceneId === sceneId)?.dialogue) || '';
  const caps = e.captions && dialogue ? kineticChain(sceneId, dialogue, avatar, accent, kw, e.captionY ?? 300) : '';

  // A 16:9 presenter fills the frame directly; only a portrait clip needs the blurred-fill trick.
  const fillFrame = avWide
    ? `[0:v]${BROLL_SAFE},scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1[base]`
    : `[0:v]split=2[a][b];`
      + `[a]crop=720:${AVATAR_SAFE_H}:0:0,scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},`
      + `boxblur=30:3,eq=brightness=-0.05:saturation=0.92,setsar=1[bg];`
      + `[b]crop=720:${AVATAR_SAFE_H}:0:0,scale=-2:${H},setsar=1[fg];`
      + `[bg][fg]overlay=(W-w)/2:0[base]`;

  if (e.mode === 'talking') {
    // Presenter full frame with kinetic captions down the left. No panel, no box - the reference never uses one.
    inputs = [avatar];
    graph = `${fillFrame};[base]${caps || 'null'}[v]`;
  } else if (e.mode === 'presenter' && avWide) {
    // Landscape source: the side panel is pointless, so the headline sits low-left over the full-frame shot.
    inputs = [avatar];
    const head = [
      e.headline ? dt(e.headline, BLACK, 96, PALETTE.white, 110, 760, 0.5) : '',
      e.sub ? dt(e.sub, BOLD, 44, accent, 110, 890, 1.0) : ''
    ].filter(Boolean).join(',');
    graph = `${fillFrame};[base]${head || 'null'}[v]`;
  } else if (e.mode === 'presenter') {
    inputs = [avatar];
    graph = `[0:v]split=2[a][b];`
      + `[a]crop=720:${AVATAR_SAFE_H}:0:0,scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},`
      + `boxblur=26:3,eq=brightness=-0.14:saturation=0.85,setsar=1[bg];`
      + `[b]crop=720:${AVATAR_SAFE_H}:0:0,scale=-2:${H},setsar=1[fg];`
      + `[bg][fg]overlay=W-w:0[base];`
      + `[base]drawbox=x=0:y=0:w=1214:h=${H}:color=0x0B0D13@0.86:t=fill,drawbox=x=1212:y=0:w=4:h=${H}:color=${PALETTE.amber}@0.9:t=fill[scrim];`
      + `[scrim]${dt(e.headline || '', BLACK, 92, PALETTE.ink, 110, 400, 0.5)}`
      + (e.sub ? `,${dt(e.sub, BOLD, 46, PALETTE.amber, 110, 530, 1.1)}` : '') + `[v]`;
  } else if (e.mode === 'broll' && hasBroll) {
    // scrim:false leaves the footage full-bleed - the reference plays its B-roll clean, with at most
    // one big title over it, and never buries it under a dark panel.
    const useScrim = e.scrim !== false;
    const titleChain = e.title
      ? `,drawtext=fontfile='${BLACK}':text='${esc(e.title)}':fontsize=120:fontcolor=${PALETTE.white}`
        + `:shadowx=0:shadowy=6:shadowcolor=0x000000@0.5:x=(w-text_w)/2:y=(h-text_h)/2`
        + `:alpha='clip((t-0.4)/0.5,0,1)'`
      : '';
    const over = [caps, txt, titleChain.replace(/^,/, '')].filter(Boolean).join(',');
    inputs = [avatar, broll, ...(useScrim ? [A.scrim] : []), ...(bubbleOn ? [A.mask, A.ring] : [])];
    graph = `[1:v]${BROLL_SAFE},scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=24,setsar=1[bgv];`
      + (useScrim ? `[2:v]format=rgba[sc];[bgv][sc]overlay=0:0:format=auto[shaded];` : `[bgv]copy[shaded];`)
      + `[shaded]${over || 'null'}[card]`
      + (bubbleOn ? `;${bubbleChain('card', useScrim ? 3 : 2)}` : `;[card]copy[v]`);
  } else {
    if (e.mode === 'broll') console.warn(`[NewFormat] ${sceneId}: no B-roll on disk, falling back to a text card`);
    inputs = [avatar, A.glow, ...(bubbleOn ? [A.mask, A.ring] : [])];
    graph = `[1:v]${txt || 'null'}[card]`
      + (bubbleOn ? `;${bubbleChain('card', 2)}` : `;[card]copy[v]`);
  }

  const script = path.join(assetDir, `${sceneId}.filter`);
  fs.writeFileSync(script, graph);
  // Stills need -loop 1 so they last the whole clip; -t caps everything to the presenter clip's length.
  const inArgs = inputs.map((f, i) => (i > 0 && f.endsWith('.png') ? `-loop 1 -i "${f}"` : `-i "${f}"`)).join(' ');
  const cmd = `ffmpeg -y ${inArgs} ${FILTER_SCRIPT_FLAG} "${script}" -map "[v]" -map 0:a -shortest -r 24 `
    + `-c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p -c:a aac -b:a 192k -movflags +faststart "${out}"`;
  try {
    execSync(cmd, { stdio: 'pipe' });
    console.log(`[NewFormat] ${sceneId}: ${e.mode}${bubbleOn ? ' + bubble' : ''} -> ${path.relative(process.cwd(), out)}`);
    return out;
  } catch (err) {
    console.error(`[NewFormat] ${sceneId}: ffmpeg failed: ${(err as Error).message.split('\n').slice(-4).join(' | ')}`);
    return null;
  }
}

const scenes = config.scenes.filter(s => edit.scenes[s.sceneId]).slice(0, limit || undefined);
console.log(`[NewFormat] ${scenes.length} scene(s); B-roll from ${path.relative(process.cwd(), brollDir)}`);
let built = 0;
for (const s of scenes) if (compose(s.sceneId, edit.scenes[s.sceneId])) built++;
console.log(`[NewFormat] Composed ${built}/${scenes.length}`);
if (built && doMerge) {
  const final = FFmpegMerger.mergeScenes(outDir, `${config.projectTitle}_NewFormat`, config.speedMultiplier || 1, config.transition);
  console.log(`[NewFormat] Final: ${final || '(merge failed)'}`);
}
