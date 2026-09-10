/**
 * Timeline assembler: one continuous narration, a picture that cuts away from it.
 *
 * The presenter's audio runs unbroken for the whole video while the visible track cuts between him, the
 * cinematic inserts and the motion cards. Cutting the picture away from a talking head is the whole point of
 * the format — he should be on screen because a moment needs a face, not by default.
 *
 * Presenter segments are cut from a pre-built "master" (his clips concatenated, captions already burned in),
 * so a segment's pixels always line up with the audio underneath and lip sync cannot drift.
 *
 *   npx tsx src/assembleTimeline.ts --timeline <timeline.json>
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const args = process.argv.slice(2);
const ti = args.indexOf('--timeline');
if (ti < 0 || !args[ti + 1]) { console.error('[Assemble] --timeline <file.json> is required'); process.exit(1); }
const spec = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), args[ti + 1]), 'utf-8'));
const ci = args.indexOf('--config');
const storyboard = ci >= 0 && args[ci + 1]
  ? JSON.parse(fs.readFileSync(path.resolve(process.cwd(), args[ci + 1]), 'utf-8')) : null;

const W = 1920, H = 1080, FPS = 24;
const root = path.resolve(process.cwd(), spec.root || '.');
const out = path.resolve(process.cwd(), spec.output);
const work = path.join(path.dirname(out), '.assemble');
fs.mkdirSync(work, { recursive: true });

const sh = (cmd: string) => {
  try { execSync(cmd, { stdio: 'pipe' }); } catch (e) {
    console.error('[Assemble] ffmpeg failed:', (e as Error).message.split('\n').slice(-5).join(' | ')); process.exit(1);
  }
};
/**
 * Some Flow clips come back with letterbox bars baked into the frame. Scaling such a clip to fill just
 * scales the bars too, so they have to be detected and cropped away first — compose.ts has done this all
 * along; the assembler was missing it.
 */
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
    if (w === fw && h === fh) return null;              // nothing to trim
    if (w < fw * 0.6 || h < fh * 0.5) return null;      // implausible: a dark shot can fool cropdetect
    return `crop=${m[1]}:${m[2]}:${m[3]}:${m[4]}`;
  } catch { return null; }
}

const dur = (f: string): number =>
  parseFloat(execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${f}"`).toString().trim()) || 0;


// ── Speech-synced kinetic text ───────────────────────────────────────────────────────────────────────
// Timing is derived from the narration itself, then burned over the finished picture. Driving text off a
// fixed beat (what the motion cards did) guarantees a mismatch, because he does not speak on a metronome.
const BLACK_F = '/System/Library/Fonts/Supplemental/Arial Black.ttf';
const BOLD_F = '/System/Library/Fonts/Supplemental/Arial Bold.ttf';
const ACCENT = '0xFFC13B';

function speechSegments(file: string, total: number): [number, number][] {
  const o = execSync(`ffmpeg -hide_banner -i "${file}" -af silencedetect=noise=-35dB:d=0.22 -f null - 2>&1`,
    { stdio: 'pipe' }).toString();
  const starts = [...o.matchAll(/silence_start: ([\d.]+)/g)].map(m => parseFloat(m[1]));
  const ends = [...o.matchAll(/silence_end: ([\d.]+)/g)].map(m => parseFloat(m[1]));
  const segs: [number, number][] = [];
  let cur = 0;
  starts.forEach((st, i) => { if (st - cur > 0.12) segs.push([cur, st]); cur = ends[i] ?? total; });
  if (total - cur > 0.12) segs.push([cur, total]);
  return segs.length ? segs : [[0.2, total - 0.2]];
}

/** 1-2 word beats, so each hit is short enough to read at speed. */
function beats(dialogue: string, segs: [number, number][]) {
  const words = dialogue.replace(/\s+/g, ' ').trim().split(' ');
  const span = segs.reduce((a, [x, y]) => a + (y - x), 0);
  const out: { text: string; start: number; end: number }[] = [];
  let wi = 0;
  segs.forEach(([x, y], si) => {
    let take = si === segs.length - 1 ? words.length - wi : Math.round(words.length * ((y - x) / span));
    take = Math.max(0, Math.min(take, words.length - wi));
    const mine = words.slice(wi, wi + take); wi += take;
    // Group toward meaning, not word count: a beat spent on "TO THE" is a wasted hit, so runs of function
    // words are carried forward and land together with the content word that follows them.
    const FILLER = new Set(['a','an','the','to','of','in','on','at','for','and','but','so','it','is','was',
      'he','his','him','her','they','that','this','with','from','by','as','or','even','about','before','into']);
    const bare = (w: string) => w.toLowerCase().replace(/[^a-z]/g, '');
    const groups: string[][] = [];
    let carry: string[] = [];
    for (const w of mine) {
      carry.push(w);
      if (!FILLER.has(bare(w))) { groups.push(carry); carry = []; }
      else if (carry.length >= 3) { groups.push(carry); carry = []; }
    }
    if (carry.length) {
      if (groups.length) groups[groups.length - 1].push(...carry);
      else groups.push(carry);
    }
    const chars = groups.reduce((a, g) => a + g.join(' ').length, 0) || 1;
    let t = x;
    groups.forEach(g => {
      const d = (y - x) * (g.join(' ').length / chars);
      out.push({ text: g.join(' ').replace(/[.,:;]$/, ''), start: t, end: Math.min(y, t + d) });
      t += d;
    });
  });
  for (let i = 0; i < out.length - 1; i++) out[i].end = Math.min(out[i].end + 0.12, out[i + 1].start + 0.02);
  return out;
}

function kineticChain(): string {
  if (!storyboard) return '';
  const keys: string[] = (spec.highlight || []).map((k: string) => k.toLowerCase());
  const parts: string[] = [];
  let clock = 0;
  spec.presenter.forEach((file: string, i: number) => {
    const clip = path.join(root, file);
    const scene = storyboard.scenes[i];
    const d = dur(clip);
    if (scene?.dialogue) {
      for (const b of beats(scene.dialogue, speechSegments(clip, d))) {
        const hot = keys.some(k => b.text.toLowerCase().replace(/[^a-z ]/g, '').includes(k));
        const txt = path.join(work, `cap_${parts.length}.txt`);
        fs.writeFileSync(txt, b.text.toUpperCase());
        // A filled accent box behind the word that matters; everything else stays plain white.
        parts.push(`drawtext=fontfile='${hot ? BLACK_F : BOLD_F}':textfile='${txt}'`
          + `:fontsize=${hot ? 108 : 92}:fontcolor=${hot ? '0x101318' : 'white'}`
          + (hot ? `:box=1:boxcolor=${ACCENT}:boxborderw=22` : `:borderw=7:bordercolor=0x0A0C10@0.9`)
          + `:x=(w-text_w)/2:y=h-330`
          + `:enable='between(t,${(clock + b.start).toFixed(2)},${(clock + b.end).toFixed(2)})'`);
      }
    }
    clock += d;
  });
  return parts.join(',');
}

// ── 1. Presenter master: his clips end to end, normalised to 1080p ────────────────────────────────────
const masters: string[] = spec.presenter.map((f: string) => path.join(root, f));
for (const m of masters) if (!fs.existsSync(m)) { console.error(`[Assemble] missing presenter clip: ${m}`); process.exit(1); }

const normed = masters.map((m, i) => {
  const o = path.join(work, `pres_${i}.mp4`);
  // Flow burns a watermark bottom-right; this window stops before it, then rescales to fill.
  sh(`ffmpeg -v error -y -i "${m}" -vf "crop=trunc(iw*0.888/2)*2:trunc(ih*0.888/2)*2:0:0,`
    + `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${FPS},setsar=1" `
    + `-c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p -c:a aac -b:a 192k "${o}"`);
  return o;
});
const listFile = path.join(work, 'pres.txt');
fs.writeFileSync(listFile, normed.map(f => `file '${f}'`).join('\n'));
const master = path.join(work, 'master.mp4');
sh(`ffmpeg -v error -y -f concat -safe 0 -i "${listFile}" -c copy "${master}"`);
const masterDur = dur(master);
console.log(`[Assemble] presenter master: ${masterDur.toFixed(1)}s from ${normed.length} clip(s)`);

// ── 2. Cut each segment from the right source ────────────────────────────────────────────────────────
const parts: string[] = [];
spec.segments.forEach((seg: any, i: number) => {
  const len = +(seg.to - seg.from).toFixed(3);
  if (len <= 0) { console.error(`[Assemble] segment ${i} has no length`); process.exit(1); }
  const o = path.join(work, `seg_${String(i).padStart(2, '0')}.mp4`);

  if (seg.source === 'presenter') {
    // Offset into the master is the timeline position itself — that is what keeps the mouth on the words.
    sh(`ffmpeg -v error -y -ss ${seg.from} -t ${len} -i "${master}" -an `
      + `-c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p -r ${FPS} "${o}"`);
  } else {
    const src = path.join(root, seg.clip);
    if (!fs.existsSync(src)) { console.error(`[Assemble] missing clip: ${src}`); process.exit(1); }
    const srcDur = dur(src);
    const at = seg.at ?? 0;
    // An insert shorter than its slot is slowed to fit rather than looped — a visible loop reads as an error.
    const pts = srcDur - at < len ? (len / Math.max(0.1, srcDur - at)) : 1;
    const bars = letterboxCrop(src);
    if (bars) console.log(`[Assemble] seg ${i}: letterbox bars trimmed (${bars})`);
    const wm = (bars ? bars + ',' : '') + (seg.source === 'broll' ? 'crop=trunc(iw*0.888/2)*2:trunc(ih*0.888/2)*2:0:0,' : '');
    sh(`ffmpeg -v error -y -ss ${at} -i "${src}" -an -t ${len} -vf "${wm}`
      + `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},`
      + (pts > 1.001 ? `setpts=${pts.toFixed(4)}*PTS,` : '')
      + `fps=${FPS},setsar=1" -c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p "${o}"`);
    if (pts > 1.001) console.log(`[Assemble] seg ${i} (${seg.clip}): ${(srcDur - at).toFixed(1)}s stretched to ${len}s`);
  }
  parts.push(o);
  console.log(`[Assemble] seg ${i}: ${seg.from}s-${seg.to}s  ${seg.source}${seg.clip ? ' ' + seg.clip : ''}`);
});

// ── 3. Join the picture, then lay the unbroken narration under it ────────────────────────────────────
const segList = path.join(work, 'segs.txt');
fs.writeFileSync(segList, parts.map(f => `file '${f}'`).join('\n'));
const silent = path.join(work, 'picture.mp4');
sh(`ffmpeg -v error -y -f concat -safe 0 -i "${segList}" -c copy "${silent}"`);

const total = spec.segments[spec.segments.length - 1].to;
const caps = kineticChain();
if (caps) {
  const cf = path.join(work, 'caps.filter');
  fs.writeFileSync(cf, `[0:v]${caps}[v]`);
  sh(`ffmpeg -v error -y -i "${silent}" -i "${master}" -/filter_complex "${cf}" -map "[v]" -map 1:a -t ${total} `
    + `-c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p -c:a aac -b:a 192k -movflags +faststart "${out}"`);
  console.log(`[Assemble] burned speech-synced text over the whole cut`);
} else {
  sh(`ffmpeg -v error -y -i "${silent}" -i "${master}" -map 0:v -map 1:a -t ${total} `
    + `-c:v copy -c:a aac -b:a 192k -movflags +faststart "${out}"`);
}

console.log(`[Assemble] Done: ${dur(out).toFixed(1)}s -> ${path.relative(process.cwd(), out)}`);
