/**
 * Assemble the finished 9:16 reel from two differently-sourced halves.
 *
 *   npx tsx src/composeReel.ts --intro <intro.mp4> \
 *       --story downloads/<project> --broll downloads/<project>/broll_realistic \
 *       --out shorts_out/<name>.reel.mp4
 *
 * DIVISION OF LABOUR — set by the user, do not "improve" it:
 *
 *   intro   HeyGen avatar lip-syncing the cloned ElevenLabs voice. The only part
 *           HeyGen touches, because it is the only part that names the judges — which
 *           Google Flow refuses outright ("prominent people").
 *   story   Google Flow's own @me avatar, carrying ITS OWN verified voice. Flow supplies
 *           both picture and sound here; ElevenLabs is not involved past the intro.
 *   upper   Flow B-roll above the presenter for the story, court and judge cards above
 *           the intro.
 *
 * So the reel is a concatenation of self-contained segments, each with its own audio —
 * not one continuous narration with visuals hung off it. An earlier build did the
 * latter (single ElevenLabs track across all 90s) and was rejected.
 *
 * There is no divider between the halves; the user asked for the gold rule to go.
 */
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

const W = 1080, H = 1920, FPS = 25;
const SPLIT = H / 2;
/** Native geometry of a Flow clip, and the window compose.ts takes for the presenter. */
const SRC_W = 720, SRC_HALF = 640, AVATAR_CROP_Y = 180;
/** Flow's own clips already carry the studio grey; this only fills gaps. */
const FLOW_GREY = '0x808382';

function sh(bin: string, args: string[]): string {
  return execFileSync(bin, args, { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
}
function dur(f: string): number {
  return Number(sh('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=nw=1:nk=1', f]).trim());
}
function hasAudio(f: string): boolean {
  return sh('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries',
    'stream=index', '-of', 'csv=p=0', f]).trim().length > 0;
}

/**
 * One story segment: Flow's presenter clip in the lower half with its own audio, a
 * Flow B-roll clip above it.
 *
 * Flow burns a watermark bottom-right, so the presenter is cropped to 88.8% from the
 * top-left before being rescaled — the same window `assembleTimeline.ts` has always
 * used. Without it the watermark rides into the finished reel.
 */
function storySegment(presenter: string, broll: string | null, out: string) {
  const seconds = dur(presenter);
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', presenter];
  const chain: string[] = [];

  // Framing copied from compose.ts:311, which produced the delivered Kerala cut:
  // a STRAIGHT crop of 720x640 at y=180 out of the native 720x1280 Flow clip — no
  // scale-to-fill. Scaling a portrait source to cover a landscape box blows the
  // presenter up to a giant head, which is exactly what the first attempt did.
  // Cropping first and scaling the finished 720x640 window up to 1080x960 is a
  // uniform 1.5x, so the framing is identical to Kerala at a higher output size.
  // The crop also sits above Flow's bottom-right watermark, so nothing to strip.
  chain.push(
    `[0:v]crop=${SRC_W}:${SRC_HALF}:0:${AVATAR_CROP_Y},` +
    `scale=${W}:${SPLIT},fps=${FPS},setsar=1[low]`,
  );

  if (broll) {
    args.push('-stream_loop', '-1', '-i', broll);
    chain.push(
      `[1:v]scale=${W}:${SPLIT}:force_original_aspect_ratio=increase,crop=${W}:${SPLIT},` +
      `fps=${FPS},setsar=1[up]`,
    );
  } else {
    args.push('-f', 'lavfi', '-i', `color=c=${FLOW_GREY}:s=${W}x${SPLIT}:r=${FPS}`);
    chain.push(`[1:v]null[up]`);
  }

  chain.push(`[up][low]vstack=inputs=2[out]`);
  args.push('-filter_complex', chain.join(';'), '-map', '[out]', '-map', '0:a?',
    '-t', String(seconds),
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '44100', '-ac', '2', '-r', String(FPS), out);
  sh('ffmpeg', args);
}

/** Normalise any segment to identical codec settings so concat is seamless. */
function normalise(src: string, out: string) {
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', src];
  if (!hasAudio(src)) {
    args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
      '-shortest');
  }
  args.push('-vf', `scale=${W}:${H},fps=${FPS},setsar=1`,
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '44100', '-ac', '2', out);
  sh('ffmpeg', args);
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

if (require.main === module) {
  const introFile = arg('intro');
  const storyDir = arg('story');
  const brollDir = arg('broll');
  // The LawWorld advert that closes EVERY video. `--outro-clip` is a presenter clip
  // from assets/outro_library (generated once, reused forever — it carries no
  // case-specific content); `--outro-card` is the branded upper half that sits over it.
  const outroCard = arg('outro-card');
  const outroClip = arg('outro-clip');
  const out = arg('out') || 'shorts_out/reel.mp4';
  if (!introFile || !storyDir) {
    console.error('usage: tsx src/composeReel.ts --intro <intro.mp4> --story <dir> [--broll <dir>] [--out <file>]');
    process.exit(1);
  }

  const work = path.join(path.dirname(out), 'reel_work');
  fs.mkdirSync(work, { recursive: true });

  const presenters = fs.readdirSync(storyDir)
    .filter(f => /^s\d+.*\.mp4$/i.test(f) || /^scene_\d+.*\.mp4$/i.test(f))
    .sort().map(f => path.join(storyDir, f));
  if (!presenters.length) { console.error(`no presenter clips in ${storyDir}`); process.exit(1); }

  const brolls = brollDir && fs.existsSync(brollDir)
    ? fs.readdirSync(brollDir).filter(f => /\.mp4$/i.test(f)).sort().map(f => path.join(brollDir, f))
    : [];
  console.log(`[compose] ${presenters.length} story clips, ${brolls.length} b-roll clips`);

  const parts: string[] = [];
  const introNorm = path.join(work, 'p00_intro.mp4');
  normalise(introFile, introNorm);
  parts.push(introNorm);
  console.log(`[compose] intro ${dur(introNorm).toFixed(1)}s (HeyGen + ElevenLabs)`);

  presenters.forEach((p, i) => {
    const seg = path.join(work, `p${String(i + 1).padStart(2, '0')}_story.mp4`);
    // Without a dedicated outro clip the last story clip carries the end card, which is
    // how the first reel was built; with one, every story clip keeps its own B-roll.
    const isLast = i === presenters.length - 1;
    const useCardHere = isLast && outroCard && !outroClip;
    const top = useCardHere ? outroCard : (brolls.length ? brolls[i % brolls.length] : null);
    storySegment(p, top, seg);
    parts.push(seg);
    console.log(`[compose] story ${i + 1}/${presenters.length}  ${dur(seg).toFixed(1)}s  ${path.basename(p)}${useCardHere ? '  [+ end card]' : ''}`);
  });

  if (outroClip) {
    if (!fs.existsSync(outroClip)) throw new Error(`outro clip not found: ${outroClip}`);
    const seg = path.join(work, 'p99_outro.mp4');
    storySegment(outroClip, outroCard || null, seg);
    parts.push(seg);
    console.log(`[compose] outro    ${dur(seg).toFixed(1)}s  ${path.basename(outroClip)}  [LawWorld advert]`);
  }

  const list = path.join(work, 'parts.txt');
  fs.writeFileSync(list, parts.map(p => `file '${path.resolve(p)}'`).join('\n'));
  sh('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0',
    '-i', list, '-c', 'copy', out]);

  console.log(`\n[compose] wrote ${out}  (${dur(out).toFixed(1)}s)`);
}
