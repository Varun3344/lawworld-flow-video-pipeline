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

/**
 * When is a given word actually spoken? Items reveal on these times rather than a fixed beat, because a
 * metronome can never match a person speaking at their own pace.
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
  const spans: [number, number][] = segs.length ? segs : [[0.2, total - 0.2]];

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

/** First moment `needle` is spoken, or null if it never is. */
function timeOf(times: { word: string; at: number }[], needle: string): number | null {
  const n = needle.toLowerCase().replace(/[^a-z]/g, '');
  const hit = times.find(t => t.word === n || (n.length > 4 && t.word.startsWith(n.slice(0, 5))));
  return hit ? hit.at : null;
}

/** Backdrop: a quiet dark wash with a vignette. The old version used a tech-style grid, which cheapened it. */
function letterboxCrop(file: string): string | null {
  try {
    const o = execSync(`ffmpeg -hide_banner -ss 1 -i "${file}" -vf cropdetect=24:2:0 -frames:v 30 -f null - 2>&1`,
      { stdio: 'pipe' }).toString();
    const m = [...o.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)].pop();
    if (!m) return null;
    const probe = execSync(`ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "${file}"`)
      .toString().trim().split(',');
    const [fw, fh] = [parseInt(probe[0], 10), parseInt(probe[1], 10)];
    const [w, h] = [parseInt(m[1], 10), parseInt(m[2], 10)];
    if (w === fw && h === fh) return null;
    if (w < fw * 0.6 || h < fh * 0.5) return null;
    return `crop=${m[1]}:${m[2]}:${m[3]}:${m[4]}`;
  } catch { return null; }
}

function backdrop(): string {
  const f = path.join(TMP, 'wash.png');
  if (!fs.existsSync(f))
    sh(`ffmpeg -v error -y -f lavfi -i color=0x0A0C10:s=${W + 160}x${H + 160} -vf "format=rgba,`
      + `geq=r='r(X,Y)+16*exp(-pow(Y-${(H + 160) * 0.42},2)/420000)'`
      + `:g='g(X,Y)+13*exp(-pow(Y-${(H + 160) * 0.42},2)/420000)'`
      + `:b='b(X,Y)+10*exp(-pow(Y-${(H + 160) * 0.42},2)/420000)':a='255',`
      + `vignette=angle=PI/5,noise=alls=5:allf=t" -frames:v 1 "${f}"`);
  return f;
}

/**
 * A single line of type on a transparent sprite — no box, no rule, no numeral. The previous card style
 * boxed every item and stamped a ghost number beside it, which read as a dashboard rather than an explainer.
 */
function textLine(id: string, label: string, sub: string, accent: boolean): { file: string; w: number; h: number } {
  const file = path.join(TMP, `${id}.png`);
  const size = accent ? 96 : 84;
  const w = 1500, h = sub ? size + 62 : size + 18;
  if (!fs.existsSync(file))
    // colorchannelmixer=aa=0 blanks the alpha before any text is drawn. "color=black@0" alone does not
    // survive rasterisation, and -pix_fmt rgba only adds an opaque alpha channel — either way the canvas
    // stayed solid black and every line sat in a visible rectangle.
    sh(`ffmpeg -v error -y -f lavfi -i color=black:s=${w}x${h} -vf "format=rgba,colorchannelmixer=aa=0,`
      + `drawtext=fontfile='${BLACK_F}':text='${esc(label)}':fontsize=${size}`
      + `:fontcolor=${accent ? AMBER : INK}:x=0:y=0`
      + (sub ? `,drawtext=fontfile='${BOLD_F}':text='${esc(sub)}':fontsize=32:fontcolor=${MUTED}:x=3:y=${size + 14}` : '')
      // -pix_fmt rgba is required: without it the PNG is written as rgb24, the transparent canvas becomes
      // solid black, and every line of type sits in a visible black rectangle.
      + `" -frames:v 1 -pix_fmt rgba "${file}"`);
  return { file, w, h };
}

/** Small letter-spaced eyebrow above the list; ffmpeg has no tracking, so space the characters by hand. */
const spaced = (t: string) => t.split('').join(' ');

/** Fly-in: slides from `from` to `to` and fades up over 0.45s, easing out. */
interface Card {
  id: string; seconds: number; title: string;
  panels: { label: string; sub: string; accent?: boolean; syncWord?: string }[];
  /** Narration this card plays under; when given, panels land on their own words. */
  syncClip?: string; syncDialogue?: string; syncOffset?: number;
  /**
   * Flow-generated footage to sit the type on. Flow renders atmosphere beautifully but cannot be trusted
   * with exact wording — it turned LOKAYUKTA into "LOKAY" and dropped a section number entirely — so the
   * picture comes from Flow and the words are drawn here, where they are guaranteed correct.
   */
  bgVideo?: string;
}

function render(card: Card): string {
  const wash = backdrop();
  const out = path.join(OUT, `${card.id}.mp4`);
  const n = card.panels.length;

  let atFor: (i: number) => number = i => 0.35 + i * 0.42;
  if (card.syncClip && card.syncDialogue && !fs.existsSync(card.syncClip))
    console.warn(`[Motion] ${card.id}: narration clip missing (${card.syncClip}) — items will NOT match the speech.`);
  if (card.syncClip && card.syncDialogue && fs.existsSync(card.syncClip)) {
    const times = wordTimes(card.syncClip, card.syncDialogue);
    const off = card.syncOffset ?? 0;
    const resolved = card.panels.map(p => {
      const t = p.syncWord ? timeOf(times, p.syncWord) : null;
      return t === null ? null : Math.max(0.15, t - off - 0.15);
    });
    if (resolved.every(v => v !== null)) {
      atFor = i => resolved[i] as number;
      console.log(`[Motion] ${card.id}: items synced to speech at ${resolved.map(v => (v as number).toFixed(1)).join('s, ')}s`);
    } else {
      console.warn(`[Motion] ${card.id}: word(s) not spoken in this clip; using the even fallback`);
    }
  }

  const lines = card.panels.map((p, i) => textLine(`${card.id}_${i}`, p.label, p.sub, p.accent === true));
  const gap = 54;
  const totalH = lines.reduce((a, l) => a + l.h, 0) + gap * (n - 1);
  const top = Math.round((H - totalH) / 2) + 36;
  const x = 250;
  const ys: number[] = [];
  let y = top;
  for (const l of lines) { ys.push(y); y += l.h + gap; }

  // A gold marker sits beside whichever item last appeared, stepping down the list as each one lands.
  const markY = ys.map((yy, i) => `if(gte(t,${atFor(i).toFixed(2)}),${yy}`).join(',') + `,-200` + ')'.repeat(n);

  const useFootage = !!card.bgVideo && fs.existsSync(card.bgVideo);
  if (card.bgVideo && !useFootage)
    console.warn(`[Motion] ${card.id}: background footage missing (${card.bgVideo}) — falling back to the flat wash.`);

  // Footage needs the watermark trimmed, then knocking back so white type reads cleanly over it.
  const bars = useFootage ? letterboxCrop(card.bgVideo as string) : null;
  if (bars) console.log(`[Motion] ${card.id}: letterbox bars trimmed from background (${bars})`);
  const bgChain = useFootage
    ? `[0:v]${bars ? bars + ',' : ''}crop=trunc(iw*0.888/2)*2:trunc(ih*0.888/2)*2:0:0,`
      + `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${FPS},setsar=1,`
      + `eq=brightness=-0.10:saturation=0.92,drawbox=x=0:y=0:w=${W}:h=${H}:color=0x07090E@0.52:t=fill`
    : `[0:v]crop=${W}:${H}:'80+16*sin(t/7)':'80+12*cos(t/8)',setsar=1`;

  let g = bgChain
    + `,drawtext=fontfile='${BOLD_F}':text='${esc(spaced(card.title))}':fontsize=27:fontcolor=${AMBER}`
    + `:x=${x}:y=${top - 118}:alpha='clip(t/0.6,0,1)'`
    + `,drawbox=x=${x}:y=${top - 74}:w='clip((t-0.25)*420,0,120)':h=3:color=${AMBER}@0.85:t=fill`
    + `,drawbox=x=${x - 42}:y='${markY}':w=6:h=${lines[0].h - 20}:color=${AMBER}:t=fill[bg];`;

  let base = 'bg';
  lines.forEach((l, i) => {
    const p = `clip((t-${atFor(i).toFixed(2)})/0.5,0,1)`;
    const e = `(1-pow(1-${p},3))`;
    g += `[${i + 1}:v]format=rgba[l${i}];`
       + `[${base}][l${i}]overlay=x='${x}+40*(1-${e})':y=${ys[i]}`
       + `:enable='gte(t,${atFor(i).toFixed(2)})':format=auto[s${i}];`;
    base = `s${i}`;
  });
  g += `[${base}]format=yuv420p[v]`;

  const inputs = [useFootage ? `-i "${card.bgVideo}"` : `-loop 1 -i "${wash}"`,
                  ...lines.map(l => `-loop 1 -i "${l.file}"`)].join(' ');
  const gf = path.join(TMP, `${card.id}.filter`);
  fs.writeFileSync(gf, g);
  sh(`ffmpeg -y -v error ${inputs} -/filter_complex "${gf}" -map "[v]" -t ${card.seconds} -r ${FPS} `
    + `-c:v libx264 -preset medium -crf 17 -pix_fmt yuv420p "${out}"`);
  console.log(`[Motion] ${card.id}: ${card.seconds}s, ${n} lines -> ${path.relative(process.cwd(), out)}`);
  return out;
}

const CLIPS = './downloads/LawWorld_OfficeDark_Case1';
const D1 = "A man in Bengaluru complained about a civic amenity site allotment. He went to the police, to the Lokayukta, even to the Governor. Nobody acted.";
const D2 = "So he filed a private complaint before a Magistrate. But the trial court found an unverified affidavit, and diverted the case into a Section two twenty three enquiry.";
const D3 = "The ruling went the other way. An unverified affidavit is a curable defect, not a fatal one. It cannot end a complaint before that complaint has even begun.";

// Each card only lists words spoken inside the clip it plays under — a panel whose word is never said
// cannot be synced, and would silently fall back to the fixed beat that caused the original mismatch.
// syncOffset is where the card starts inside that clip, so panel times are relative to the card.
const BG = './downloads/LawWorld_CardBG/broll_realistic';
const D4 = "So the complaint goes back to where it started. A procedural slip cannot decide a case on its merits. That protection exists for the complainant, and it has been restored.";

const CARDS: Card[] = [
  { id: 'mg_chain', seconds: 5.5, title: 'WHERE HE WENT FIRST', bgVideo: `${BG}/bg_chain_broll.mp4`,
    syncClip: `${CLIPS}/s1_hook.mp4`, syncDialogue: D1, syncOffset: 3.0,
    panels: [
      { label: 'THE POLICE',    sub: 'No action', syncWord: 'police' },
      { label: 'THE LOKAYUKTA', sub: 'No action', syncWord: 'lokayukta' },
      { label: 'THE GOVERNOR',  sub: 'No action', syncWord: 'governor', accent: true }] },

  { id: 'mg_sections', seconds: 4.0, title: 'WHAT THE TRIAL COURT DID', bgVideo: `${BG}/bg_sections_broll.mp4`,
    syncClip: `${CLIPS}/s2_divert.mp4`, syncDialogue: D2, syncOffset: 3.0,
    panels: [
      { label: 'UNVERIFIED AFFIDAVIT', sub: 'Spotted by the trial court', syncWord: 'affidavit' },
      { label: 'DIVERTED TO ENQUIRY',  sub: 'Section 223 instead of 175', syncWord: 'diverted', accent: true }] },

  { id: 'mg_verdict', seconds: 4.5, title: 'THE RULING', bgVideo: `${BG}/bg_verdict_broll.mp4`,
    syncClip: `${CLIPS}/s3_ruling.mp4`, syncDialogue: D3, syncOffset: 3.0,
    panels: [
      { label: 'A CURABLE DEFECT', sub: 'The complaint survives', syncWord: 'curable', accent: true },
      { label: 'NOT A FATAL ONE',  sub: 'It cannot end the case',  syncWord: 'fatal' }] },

  { id: 'mg_meaning', seconds: 4.5, title: 'WHAT IT MEANS', bgVideo: `${BG}/bg_meaning_broll.mp4`,
    syncClip: `${CLIPS}/s4_meaning.mp4`, syncDialogue: D4, syncOffset: 3.0,
    panels: [
      { label: 'A PROCEDURAL SLIP', sub: 'Cannot decide the merits', syncWord: 'procedural' },
      { label: 'THE SAFEGUARD HOLDS', sub: 'Protection for the complainant', syncWord: 'protection', accent: true }] },
];

fs.mkdirSync(OUT, { recursive: true });
for (const c of CARDS) render(c);
console.log(`[Motion] Done — ${CARDS.length} cards in ${path.relative(process.cwd(), OUT)}`);
