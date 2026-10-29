/**
 * Contact sheet of every generated clip, for eyeballing before assembly.
 *
 *   npx tsx src/reviewClips.ts <dir> [more dirs...]
 *
 * Why this exists: Flow renders the wrong thing often enough that clips must be
 * checked, and a single thumbnail hides the failures that matter. A clip whose
 * subject walks the wrong way, or whose motion reads as reversed, looks perfectly
 * fine in one frame — it only shows up across several. So each clip gets a strip of
 * frames spanning its length, on one row, labelled.
 *
 * The failure that prompted it: a prompt said an advocate "climbs the steps"; Flow
 * rendered him descending toward the lens while the camera retreated, so his legs read
 * as walking backwards. It shipped into a cut before anyone noticed.
 *
 * Things worth looking for in the output:
 *   - a subject moving the opposite way to the prompt, or appearing to moonwalk
 *   - limbs or faces that deform between frames
 *   - text, logos or watermarks that crept in despite the negative prompts
 *   - a shot that barely changes across its whole length (a dud, effectively a still)
 */
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

const BOLD = '/System/Library/Fonts/Supplemental/Arial Bold.ttf';
const COLS = 6;          // frames sampled per clip
const TH_W = 200;

function sh(bin: string, args: string[]): string {
  return execFileSync(bin, args, { encoding: 'utf8', maxBuffer: 1 << 27 });
}
function dur(f: string): number {
  return Number(sh('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=nw=1:nk=1', f]).trim());
}

function stripFor(clip: string, work: string, idx: number): string {
  const d = dur(clip);
  const name = path.basename(clip, path.extname(clip));
  const frames: string[] = [];
  for (let i = 0; i < COLS; i++) {
    // Spread across the clip but stay off the very ends, which are often soft.
    const t = (d * (i + 0.5)) / COLS;
    const out = path.join(work, `f_${idx}_${i}.png`);
    sh('ffmpeg', ['-hide_banner', '-v', 'error', '-y', '-ss', String(t.toFixed(2)), '-i', clip,
      '-frames:v', '1', '-vf',
      `scale=${TH_W}:-1,drawbox=0:0:${TH_W}:20:black@0.8:t=fill,` +
      `drawtext=fontfile='${BOLD}':text='${t.toFixed(1)}s':fontcolor=0xF0B429:fontsize=13:x=4:y=3`,
      out]);
    frames.push(out);
  }
  const row = path.join(work, `row_${idx}.png`);
  const args = ['-hide_banner', '-v', 'error', '-y'];
  frames.forEach(f => args.push('-i', f));
  args.push('-filter_complex',
    `${frames.map((_, i) => `[${i}]`).join('')}hstack=inputs=${frames.length},` +
    `drawbox=0:0:${TH_W * COLS}:26:black@0.85:t=fill,` +
    `drawtext=fontfile='${BOLD}':text='${name.replace(/[':]/g, ' ')}':fontcolor=white:fontsize=17:x=8:y=5`,
    '-frames:v', '1', row);
  sh('ffmpeg', args);
  return row;
}

if (require.main === module) {
  const dirs = process.argv.slice(2);
  if (!dirs.length) { console.error('usage: tsx src/reviewClips.ts <dir> [more dirs...]'); process.exit(1); }

  const clips: string[] = [];
  for (const d of dirs) {
    if (!fs.existsSync(d)) { console.warn(`skip (missing): ${d}`); continue; }
    for (const f of fs.readdirSync(d).sort()) {
      if (/\.mp4$/i.test(f)) clips.push(path.join(d, f));
    }
  }
  if (!clips.length) { console.error('no clips found'); process.exit(1); }

  const work = path.join('shorts_out', 'review');
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });

  console.log(`[review] ${clips.length} clips`);
  const rows = clips.map((c, i) => {
    console.log(`  ${path.basename(c)}`);
    return stripFor(c, work, i);
  });

  // Stack in batches; one very tall image is unreadable.
  const BATCH = 6;
  for (let b = 0; b * BATCH < rows.length; b++) {
    const slice = rows.slice(b * BATCH, (b + 1) * BATCH);
    const out = path.join(work, `review_${b + 1}.png`);
    const args = ['-hide_banner', '-v', 'error', '-y'];
    slice.forEach(f => args.push('-i', f));
    args.push('-filter_complex',
      `${slice.map((_, i) => `[${i}]`).join('')}vstack=inputs=${slice.length}`,
      '-frames:v', '1', out);
    sh('ffmpeg', args);
    console.log(`[review] wrote ${out}`);
  }
}
