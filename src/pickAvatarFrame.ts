/**
 * Pick the best still from a presenter clip to use as the HeyGen avatar source.
 *
 *   npx tsx src/pickAvatarFrame.ts <clip.mp4> [outDir]
 *
 * "Best" here means two things, and they pull against each other:
 *
 *  - **Sharp.** Flow clips have motion blur on most frames. Scored as the mean edge
 *    energy over the face region, which is a decent proxy and needs no face model.
 *  - **Mouth closed.** The avatar source sets the resting pose; a frame caught
 *    mid-syllable bakes an odd half-open mouth into every video HeyGen renders from
 *    it. Scored as brightness variance across the mouth band — an open mouth shows
 *    teeth and shadow, so it varies far more than closed lips.
 *
 * The two scores are reported separately rather than blended, and a contact sheet is
 * written, because the final call is visual and worth making by eye.
 */
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

function sh(bin: string, args: string[]): string {
  return execFileSync(bin, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function duration(file: string): number {
  return Number(sh('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=nw=1:nk=1', file]).trim());
}

function dims(file: string): { w: number; h: number } {
  const [w, h] = sh('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file]).trim().split(',').map(Number);
  return { w, h };
}

/** Mean value of a single-channel raw frame produced by an ffmpeg filter chain. */
function meanOf(file: string, t: number, vf: string, size: number): number {
  const tmp = path.join(process.env.TMPDIR || '/tmp', `pick_${process.pid}.raw`);
  sh('ffmpeg', ['-hide_banner', '-v', 'error', '-y', '-ss', String(t), '-i', file,
    '-frames:v', '1', '-vf', vf, '-f', 'rawvideo', '-pix_fmt', 'gray', tmp]);
  const buf = fs.readFileSync(tmp);
  fs.unlinkSync(tmp);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i];
  return buf.length ? sum / buf.length : 0;
}

function variance(file: string, t: number, vf: string): number {
  const tmp = path.join(process.env.TMPDIR || '/tmp', `pickv_${process.pid}.raw`);
  sh('ffmpeg', ['-hide_banner', '-v', 'error', '-y', '-ss', String(t), '-i', file,
    '-frames:v', '1', '-vf', vf, '-f', 'rawvideo', '-pix_fmt', 'gray', tmp]);
  const buf = fs.readFileSync(tmp);
  fs.unlinkSync(tmp);
  if (!buf.length) return 0;
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i];
  const mean = sum / buf.length;
  let v = 0;
  for (let i = 0; i < buf.length; i++) v += (buf[i] - mean) ** 2;
  return v / buf.length;
}

export interface FrameScore { t: number; sharpness: number; mouthVariance: number }

export function scoreFrames(clip: string, step = 0.4): FrameScore[] {
  const dur = duration(clip);
  const { w, h } = dims(clip);
  // Face sits in the upper-middle of a 9:16 presenter frame; the mouth band a little
  // below centre of that. Both windows are generous so they survive small pose shifts.
  const faceW = Math.round(w * 0.42), faceH = Math.round(h * 0.22);
  const faceX = Math.round((w - faceW) / 2), faceY = Math.round(h * 0.16);
  const mouthW = Math.round(w * 0.16), mouthH = Math.round(h * 0.05);
  const mouthX = Math.round((w - mouthW) / 2), mouthY = Math.round(h * 0.30);

  const out: FrameScore[] = [];
  for (let t = 0.3; t < dur - 0.3; t += step) {
    const sharpness = meanOf(clip, t,
      `crop=${faceW}:${faceH}:${faceX}:${faceY},edgedetect=low=0.1:high=0.3`, faceW * faceH);
    const mouthVariance = variance(clip, t, `crop=${mouthW}:${mouthH}:${mouthX}:${mouthY}`);
    out.push({ t: Number(t.toFixed(2)), sharpness, mouthVariance });
  }
  return out;
}

if (require.main === module) {
  const clip = process.argv[2];
  const outDir = process.argv[3] || 'avatar_candidates';
  if (!clip) { console.error('usage: tsx src/pickAvatarFrame.ts <clip.mp4> [outDir]'); process.exit(1); }
  fs.mkdirSync(outDir, { recursive: true });

  const scores = scoreFrames(clip);
  // Shortlist: sharpest half, then the calmest mouths within it.
  const bySharp = [...scores].sort((a, b) => b.sharpness - a.sharpness);
  const top = bySharp.slice(0, Math.max(6, Math.ceil(bySharp.length / 2)));
  const best = [...top].sort((a, b) => a.mouthVariance - b.mouthVariance).slice(0, 6);

  console.log('t      sharpness  mouthVar');
  for (const f of best) {
    console.log(`${String(f.t).padStart(5)}  ${f.sharpness.toFixed(2).padStart(8)}  ${f.mouthVariance.toFixed(0).padStart(7)}`);
  }

  best.forEach((f, i) => {
    sh('ffmpeg', ['-hide_banner', '-v', 'error', '-y', '-ss', String(f.t), '-i', clip,
      '-frames:v', '1', path.join(outDir, `cand_${i}_t${f.t}.png`)]);
  });
  console.log(`\n${best.length} candidates written to ${outDir}/`);
}
