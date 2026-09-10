/**
 * 3D-style UI motion cards, rendered locally at true 1080p.
 *
 * These carry the parts of a judgment that footage cannot show — a chain of authorities, one statute
 * diverting into another, a verdict landing. Rendering them here rather than generating them means they are
 * genuinely sharp (no model upscale), cost nothing, and can be re-cut in seconds.
 *
 * Each panel is drawn flat, given a perspective tilt, then flown in on its own beat over a drifting grid,
 * which is what sells the depth.
 *
 *   npx tsx src/motionGraphics.ts --out <dir>
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const args = process.argv.slice(2);
const oi = args.indexOf('--out');
const OUT = path.resolve(process.cwd(), oi >= 0 && args[oi + 1] ? args[oi + 1] : './downloads/motion');
const TMP = path.join(OUT, '.parts');
fs.mkdirSync(TMP, { recursive: true });

const W = 1920, H = 1080, FPS = 24;
const INK = '0xF4F6FA', AMBER = '0xFFC13B', MUTED = '0x7E879B', PANEL = '0x141A26', EDGE = '0x263143';
const BLACK_F = '/System/Library/Fonts/Supplemental/Arial Black.ttf';
const BOLD_F = '/System/Library/Fonts/Supplemental/Arial Bold.ttf';

const sh = (cmd: string) => {
  try { execSync(cmd, { stdio: 'pipe' }); } catch (e) {
    console.error('ffmpeg failed:', (e as Error).message.split('\n').slice(-4).join(' | ')); process.exit(1);
  }
};
const esc = (t: string) => t.replace(/\\/g, '').replace(/:/g, '\\:').replace(/'/g, '').replace(/,/g, '\\,');

/** Backdrop: near-black with a faint grid and a warm pool of light behind the panels. */

/**
 * When does he actually say a given word?
 *
 * Panels used to reveal on a fixed beat, which cannot match a person speaking at their own pace — that
 * mismatch was the single most visible flaw in the cards. Timing is now taken from the narration itself:
 * speech is split on silence, the dialogue's words are distributed across those spans by length, and each
 * panel is told the moment its own word is spoken.
 */
function wordTimes(clip: string, dialogue: string): { word: string; at: number }[] {
  const total = parseFloat(execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${clip}"`)
    .toString().trim()) || 10;
  const o = execSync(`ffmpeg -hide_banner -i "${clip}" -af silencedetect=noise=-35dB:d=0.22 -f null - 2>&1`,
    { stdio: 'pipe' }).toString();
  const starts = [...o.matchAll(/silence_start: ([\d.]+)/g)].map(m => parseFloat(m[1]));
  const ends = [...o.matchAll(/silence_end: ([\d.]+)/g)].map(m => parseFloat(m[1]));
  const segs: [number, number][] = [];
  let cur = 0;
  starts.forEach((st, i) => { if (st - cur > 0.12) segs.push([cur, st]); cur = ends[i] ?? total; });
  if (total - cur > 0.12) segs.push([cur, total]);
  const spans = segs.length ? segs : [[0.2, total - 0.2] as [number, number]];

  const words = dialogue.replace(/\s+/g, ' ').trim().split(' ');
  const span = spans.reduce((a, [x, y]) => a + (y - x), 0);
  const out: { word: string; at: number }[] = [];
  let wi = 0;
  spans.forEach(([x, y], si) => {
    let take = si === spans.length - 1 ? words.length - wi : Math.round(words.length * ((y - x) / span));
    take = Math.max(0, Math.min(take, words.length - wi));
    const mine = words.slice(wi, wi + take); wi += take;
    const chars = mine.reduce((a, w) => a + w.length, 0) || 1;
    let t = x;
    mine.forEach(w => {
      out.push({ word: w.toLowerCase().replace(/[^a-z]/g, ''), at: t });
      t += (y - x) * (w.length / chars);
    });
  });
  return out;
}

/** First moment `needle` is spoken in the clip, or null if it is never said. */
function timeOf(times: { word: string; at: number }[], needle: string): number | null {
  const n = needle.toLowerCase().replace(/[^a-z]/g, '');
  const hit = times.find(t => t.word === n || (n.length > 4 && t.word.startsWith(n.slice(0, 5))));
  return hit ? hit.at : null;
}

function backdrop(): string {
  const f = path.join(TMP, 'grid.png');
  if (!fs.existsSync(f))
    sh(`ffmpeg -v error -y -f lavfi -i color=0x080A11:s=${W + 160}x${H + 160} -vf `
      + `"drawgrid=w=96:h=96:t=1:c=0x1B2434@0.55,format=rgba,`
      + `geq=r='r(X,Y)+26*exp(-((X-700)^2+(Y-560)^2)/1100000)':g='g(X,Y)+18*exp(-((X-700)^2+(Y-560)^2)/1100000)'`
      + `:b='b(X,Y)+6*exp(-((X-700)^2+(Y-560)^2)/1100000)':a='255',noise=alls=6:allf=t" -frames:v 1 "${f}"`);
  return f;
}

/** Soft amber dot that rides down the connector line. */
function pulseSprite(): string {
  const f = path.join(TMP, 'pulse.png'), d = 46;
  if (!fs.existsSync(f))
    sh(`ffmpeg -v error -y -f lavfi -i color=black@0:s=${d}x${d} -vf "format=rgba,`
      + `geq=r='255':g='193':b='59':a='255*exp(-(pow(X-${d / 2},2)+pow(Y-${d / 2},2))/90)'" -frames:v 1 "${f}"`);
  return f;
}

/** Wide, very soft diagonal sheen that travels across the card on a loop. */
function sweepSprite(): string {
  const f = path.join(TMP, 'sweep.png'), w = 700;
  if (!fs.existsSync(f))
    sh(`ffmpeg -v error -y -f lavfi -i color=black@0:s=${w}x${H} -vf "format=rgba,`
      + `geq=r='255':g='255':b='255':a='34*exp(-pow((X-${w / 2}-0.30*(Y-${H / 2})),2)/16000)'" -frames:v 1 "${f}"`);
  return f;
}

/**
 * One panel sprite. The first version alternated a strong perspective lean per panel, which sheared the
 * glyphs into a fake italic and read as a glitch. Depth now comes from a soft drop shadow plus a single
 * shallow tilt shared by every panel, so the whole card sits on one plane and the text stays crisp.
 * A large ghost numeral to the right fills the frame, which was otherwise dead space.
 */
function panel(id: string, boxW: number, h: number, label: string, sub: string, accent: boolean, index: number): string {
  const flat = path.join(TMP, `${id}_flat.png`), out = path.join(TMP, `${id}.png`);
  const w = boxW + 440;                       // room for the numeral beside the box
  const bar = accent ? AMBER : EDGE;
  const num = String(index + 1).padStart(2, '0');
  sh(`ffmpeg -v error -y -f lavfi -i color=black@0:s=${w}x${h} -vf "format=rgba,`
    + `drawbox=x=0:y=0:w=${boxW}:h=${h}:color=${PANEL}@0.97:t=fill,`
    + `drawbox=x=0:y=0:w=${boxW}:h=${h}:color=${EDGE}@0.95:t=2,`
    + `drawbox=x=0:y=0:w=8:h=${h}:color=${bar}:t=fill,`
    + `drawtext=fontfile='${BLACK_F}':text='${esc(label)}':fontsize=${h > 150 ? 60 : 48}`
    + `:fontcolor=${accent ? AMBER : INK}:x=48:y=${sub ? h / 2 - 50 : (h - 54) / 2}`
    + (sub ? `,drawtext=fontfile='${BOLD_F}':text='${esc(sub)}':fontsize=29:fontcolor=${MUTED}:x=50:y=${h / 2 + 16}` : '')
    + `,drawtext=fontfile='${BLACK_F}':text='${num}':fontsize=${Math.round(h * 0.86)}`
    + `:fontcolor=${accent ? AMBER : EDGE}@0.30:x=${boxW + 90}:y=${Math.round(h * 0.04)}`
    + `" -frames:v 1 "${flat}"`);
  // One shallow tilt for every panel (2%), just enough to feel dimensional without shearing the text.
  const dx = Math.round(w * 0.02), dy = Math.round(h * 0.03);
  sh(`ffmpeg -v error -y -i "${flat}" -vf "format=rgba,`
    + `perspective=x0=0:y0=${dy}:x1=${w}:y1=0:x2=${dx}:y2=${h - dy}:x3=${w}:y3=${h}:sense=destination" `
    + `-frames:v 1 "${out}"`);
  return out;
}

/** Fly-in: slides from `from` to `to` and fades up over 0.45s, easing out. */
function flyIn(idx: number, base: string, x: number, y: number, at: number, from: number): { g: string; label: string } {
  const p = `clip((t-${at})/0.45,0,1)`;
  const e = `(1-pow(1-${p},3))`;                       // ease-out cubic
  const sx = `'${x}+${from}*(1-${e})'`, sy = `'${y}+${Math.round(from * 0.18)}*(1-${e})'`;
  const lbl = `l${idx}`;
  return {
    g: `[${idx}:v]format=rgba,split=2[sh${idx}][pn${idx}];`
     + `[sh${idx}]colorchannelmixer=rr=0:gg=0:bb=0:aa=0.55,boxblur=18:2[shadow${idx}];`
     + `[${base}][shadow${idx}]overlay=x='${x}+18+${from}*(1-${e})':y='${y}+22+${Math.round(from * 0.18)}*(1-${e})'`
     + `:enable='gte(t,${at})':format=auto[sb${idx}];`
     + `[sb${idx}][pn${idx}]overlay=x=${sx}:y=${sy}:enable='gte(t,${at})':format=auto[${lbl}]`,
    label: lbl
  };
}

interface Card {
  id: string; seconds: number; title: string;
  panels: { label: string; sub: string; accent?: boolean; syncWord?: string }[];
  /** Narration this card plays under; when given, panels land on their own words. */
  syncClip?: string; syncDialogue?: string; syncOffset?: number;
}

function render(card: Card): string {
  const grid = backdrop(), pulse = pulseSprite(), sweep = sweepSprite();
  const out = path.join(OUT, `${card.id}.mp4`);
  const n = card.panels.length;
  const pw = 1090, ph = n > 3 ? 132 : 186, gap = n > 3 ? 30 : 46;
  const top = Math.round((H - (n * ph + (n - 1) * gap)) / 2) + 40;
  const step = ph + gap;
  // Panel beats: taken from the narration when the card declares one, otherwise an even fallback rhythm.
  const beat = 0.42, first = 0.35;
  let atFor: (i: number) => number = i => first + i * beat;
  if (card.syncClip && card.syncDialogue && !fs.existsSync(card.syncClip))
    console.warn(`[Motion] ${card.id}: narration clip missing (${card.syncClip}) — panels will use the even `
      + `fallback beat and will NOT match the speech.`);
  if (card.syncClip && card.syncDialogue && fs.existsSync(card.syncClip)) {
    const times = wordTimes(card.syncClip, card.syncDialogue);
    const off = card.syncOffset ?? 0;
    const resolved = card.panels.map((p, i) => {
      const t = p.syncWord ? timeOf(times, p.syncWord) : null;
      return t === null ? null : Math.max(0.15, t - off - 0.15);
    });
    if (resolved.every(v => v !== null)) {
      atFor = i => resolved[i] as number;
      console.log(`[Motion] ${card.id}: panels synced to speech at ${resolved.map(v => (v as number).toFixed(1)).join('s, ')}s`);
    } else {
      const missing = card.panels.filter((p, i) => resolved[i] === null).map(p => p.syncWord).join(', ');
      console.warn(`[Motion] ${card.id}: word(s) not found in the narration (${missing}); using the even fallback`);
    }
  }
  const lineX = 104, lineTop = top + 30;
  const lineMax = (n - 1) * step + ph / 2;               // stops at the last panel's middle
  const lastAt = atFor(n - 1);
  const travel = `clip((t-${atFor(0).toFixed(2)})*${(lineMax / Math.max(0.5, lastAt - atFor(0) + 0.4)).toFixed(1)},0,${lineMax})`;

  const sprites = card.panels.map((p, i) =>
    panel(`${card.id}_${i}`, pw, ph, p.label, p.sub, p.accent === true, i));

  // 0 = grid, 1..n = panels, n+1 = pulse, n+2 = sweep
  let g = `[0:v]crop=${W}:${H}:'40+30*sin(t/6)':'40+22*cos(t/7)',setsar=1`
    + `,drawtext=fontfile='${BOLD_F}':text='${esc(card.title)}':fontsize=34:fontcolor=${AMBER}`
    + `:x=140:y=150:alpha='clip(t/0.5,0,1)'`
    // the spine draws itself downward, so the eye is led rather than shown a finished list
    + `,drawbox=x=${lineX}:y=${lineTop}:w=4:h='${travel}':color=${AMBER}@0.45:t=fill[bg];`;
  let base = 'bg';
  sprites.forEach((_, i) => {
    const f = flyIn(i + 1, base, 140, top + i * step, atFor(i), -300);
    g += f.g + ';';
    base = f.label;
  });
  // pulse rides the spine while it grows, then fades out at the bottom
  g += `[${n + 1}:v]format=rgba[pl];[${base}][pl]overlay=x=${lineX - 21}:y='${lineTop}+${travel}-23'`
     + `:enable='between(t,${atFor(0).toFixed(2)},${(lastAt + 0.6).toFixed(2)})':format=auto[wp];`;
  // and a slow sheen keeps the frame alive once everything has landed
  g += `[${n + 2}:v]format=rgba[sw];[wp][sw]overlay=x='-700+mod(t*430,${W + 900})':y=0:format=auto,`
     + `format=yuv420p[v]`;

  const inputs = [`-loop 1 -i "${grid}"`, ...sprites.map(s => `-loop 1 -i "${s}"`),
                  `-loop 1 -i "${pulse}"`, `-loop 1 -i "${sweep}"`].join(' ');
  const gf = path.join(TMP, `${card.id}.filter`);
  fs.writeFileSync(gf, g);
  sh(`ffmpeg -y -v error ${inputs} -/filter_complex "${gf}" -map "[v]" -t ${card.seconds} -r ${FPS} `
    + `-c:v libx264 -preset medium -crf 17 -pix_fmt yuv420p "${out}"`);
  console.log(`[Motion] ${card.id}: ${card.seconds}s, ${n} panels + spine, pulse, sheen -> ${path.relative(process.cwd(), out)}`);
  return out;
}

const CLIPS = './downloads/LawWorld_OfficeDark_Case1';
const D1 = "A man in Bengaluru complained about a civic amenity site allotment. He went to the police, to the Lokayukta, even to the Governor. Nobody acted.";
const D2 = "So he filed a private complaint before a Magistrate. But the trial court found an unverified affidavit, and diverted the case into a Section two twenty three enquiry.";
const D3 = "The ruling went the other way. An unverified affidavit is a curable defect, not a fatal one. It cannot end a complaint before that complaint has even begun.";

// Each card only lists words spoken inside the clip it plays under — a panel whose word is never said
// cannot be synced, and would silently fall back to the fixed beat that caused the original mismatch.
// syncOffset is where the card starts inside that clip, so panel times are relative to the card.
const CARDS: Card[] = [
  { id: 'mg_chain', seconds: 5.5, title: 'WHERE HE WENT FIRST',
    syncClip: `${CLIPS}/s1_hook.mp4`, syncDialogue: D1, syncOffset: 3.0,
    panels: [
      { label: 'THE POLICE',    sub: 'No action', syncWord: 'police' },
      { label: 'THE LOKAYUKTA', sub: 'No action', syncWord: 'lokayukta' },
      { label: 'THE GOVERNOR',  sub: 'No action', syncWord: 'governor', accent: true }] },

  { id: 'mg_sections', seconds: 4.0, title: 'WHAT THE TRIAL COURT DID',
    syncClip: `${CLIPS}/s2_divert.mp4`, syncDialogue: D2, syncOffset: 3.0,
    panels: [
      { label: 'UNVERIFIED AFFIDAVIT', sub: 'Spotted by the trial court', syncWord: 'affidavit' },
      { label: 'DIVERTED TO ENQUIRY',  sub: 'Section 223 instead of 175', syncWord: 'diverted', accent: true }] },

  { id: 'mg_verdict', seconds: 4.5, title: 'THE HIGH COURT HELD',
    syncClip: `${CLIPS}/s3_ruling.mp4`, syncDialogue: D3, syncOffset: 3.0,
    panels: [
      { label: 'A CURABLE DEFECT', sub: 'The complaint survives', syncWord: 'curable', accent: true },
      { label: 'NOT A FATAL ONE',  sub: 'It cannot end the case',  syncWord: 'fatal' }] },
];

fs.mkdirSync(OUT, { recursive: true });
for (const c of CARDS) render(c);
console.log(`[Motion] Done — ${CARDS.length} cards in ${path.relative(process.cwd(), OUT)}`);
