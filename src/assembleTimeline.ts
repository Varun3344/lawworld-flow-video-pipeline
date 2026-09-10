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
const dur = (f: string): number =>
  parseFloat(execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${f}"`).toString().trim()) || 0;

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
    const wm = seg.source === 'broll' ? 'crop=trunc(iw*0.888/2)*2:trunc(ih*0.888/2)*2:0:0,' : '';
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
sh(`ffmpeg -v error -y -i "${silent}" -i "${master}" -map 0:v -map 1:a -t ${total} `
  + `-c:v copy -c:a aac -b:a 192k -movflags +faststart "${out}"`);

console.log(`[Assemble] Done: ${dur(out).toFixed(1)}s -> ${path.relative(process.cwd(), out)}`);
