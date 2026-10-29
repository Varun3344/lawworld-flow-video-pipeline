/**
 * Judgment PDF -> finished 9:16 intro scene.
 *
 *   npx tsx src/shortsIntro.ts judgments/<file>.pdf
 *
 * Stages, each cached on disk so a re-run only redoes what changed:
 *   1. judgment -> facts        (cached as <judgment>.facts.json)
 *   2. facts    -> intro script
 *   3. script   -> ElevenLabs mp3 in the host's cloned voice
 *   4. mp3      -> HeyGen transparent webm of the presenter
 *   5. composite over the court photograph, with judge cards
 *
 * The presenter layer is scaled 1.10 and cropped at y=40 before compositing. That is
 * not a taste call: HeyGen frames the avatar smaller and higher than Google Flow does,
 * and measuring 1.10 / 1.16 / 1.22 against a real Flow frame showed 1.10 matches and
 * anything more overshoots. Without it the cut from intro to story reads as a zoom.
 */
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { factsFor, buildIntroScript, JudgmentFacts, IntroScript } from './judgment';
import { speak, readAlignment, timeOf, Alignment } from './voice';
import { renderAvatar, account } from './heygen';

require('dotenv').config();

const COURTS = path.join(process.env.HOME!, 'Desktop/judge-iamge-courts/court_images_real');
// Portrait sets, searched in order. Supreme Court first, then per-High-Court sets
// added as judgments from those courts come through.
const JUDGE_DIRS = [
  path.join(process.env.HOME!, 'Desktop/judge-iamge-courts/judge_images_official'),
  path.join(process.env.HOME!, 'Desktop/judge-iamge-courts/judge_images_karnataka'),
];
const BOLD = '/System/Library/Fonts/Supplemental/Arial Bold.ttf';
const BLACK = '/System/Library/Fonts/Supplemental/Arial Black.ttf';

const W = 1080, H = 1920, FPS = 25;

/**
 * The shorts frame is split exactly in half — measured off the delivered reference
 * cut (Kerala_Sudden_Fight_REALISTIC_Final.mp4): the boundary sits on row 640 of
 * 1280, i.e. 50.0%. Content above, presenter below.
 */
const SPLIT = H / 2;                     // 960

/**
 * Backdrop grey for the lower half.
 *
 * Sampled from a Flow presenter clip as #7D807F (luminance 127), but measured against
 * the delivered Kerala cut the backdrop there averages 129.7, so this is nudged to
 * match. Kept deliberately flat: an earlier version ran `vignette=mode=backward` to
 * imitate a falloff, and that mode BRIGHTENS the edges rather than darkening them —
 * it pushed the corners to 154.7 and was why the frame looked washed out beside the
 * reference.
 */
const FLOW_GREY = '0x80838 2'.replace(' ', '');

/**
 * Framing of the HeyGen presenter in the lower half.
 *
 * These numbers exist to make the HeyGen intro match the FLOW story that follows it,
 * measured on the finished reel rather than guessed: the intro presenter came out with
 * a head 77px wide sitting 51px down (in a 230x205 sample), against the story's 86px at
 * 28px. Scaling 86/77 gives 0.97, and the crop then starts at y=197 to lift him onto
 * the story's eye-line.
 *
 * The story half is NOT tunable here — it is a straight crop of 720x640 at y=180 from
 * the native Flow clip (compose.ts:311). The intro is what bends to match it.
 */
const PRESENTER_ZOOM = 0.97;
const PRESENTER_CROP_Y = 197;

function sh(bin: string, args: string[]): string {
  return execFileSync(bin, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function probeDuration(file: string): number {
  return Number(sh('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=nw=1:nk=1', file]).trim());
}

/** ffmpeg drawtext needs colons, quotes and backslashes escaped. */
function dt(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\u2019");
}

/** The court photograph for these facts, or null to fall back to a typographic card. */
function courtImage(f: JudgmentFacts): string | null {
  if (!f.courtSlug) return null;
  const p = path.join(COURTS, `${f.courtSlug}.jpg`);
  return fs.existsSync(p) ? p : null;
}

/**
 * Official portrait for a judge, or null if we cannot be certain which judge it is.
 *
 * An earlier version fell back to matching on surname alone, which put Justice Aravind
 * Kumar's photograph on screen captioned "Justice Gnanesh Kumar" — "Kumar" is shared by
 * several judges. Showing one judge's face under another's name is a serious error on a
 * legal news channel, so the rule is now: an exact match, or every meaningful word of the
 * name present in exactly one candidate. Anything ambiguous returns null and the caller
 * shows a name-only card.
 */
function judgeImage(name: string): string | null {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
  const target = norm(name);

  const files: string[] = [];
  for (const dir of JUDGE_DIRS) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (/\.(jpe?g|png)$/i.test(f)) files.push(path.join(dir, f));
    }
  }
  if (!files.length) return null;

  const stem = (f: string) => norm(path.basename(f, path.extname(f)));
  const exact = files.find(f => stem(f) === target);
  if (exact) return exact;

  // Initials ("B.V.", "D.K.") carry little identifying weight once punctuation is
  // stripped, so require the real words to line up.
  const words = target.split(' ').filter(w => w.length > 1);
  if (!words.length) return null;

  const matches = files.filter(f => {
    const cand = stem(f).split(' ');
    return words.every(w => cand.includes(w));
  });
  return matches.length === 1 ? matches[0] : null;
}

export interface BuildResult {
  script: string;
  audio: string;
  presenter: string;
  video: string;
  seconds: number;
  warnings: string[];
}

export async function buildIntro(judgmentFile: string, outDir: string): Promise<BuildResult> {
  const warnings: string[] = [];
  fs.mkdirSync(outDir, { recursive: true });
  const stem = path.basename(judgmentFile).replace(/\.[^.]+$/, '');

  // 1-2. facts and script
  const { facts, cached } = await factsFor(judgmentFile);
  console.log(`[intro] ${facts.court} — facts ${cached ? 'cached' : 'extracted'}`);
  const script = buildIntroScript(facts);
  fs.writeFileSync(path.join(outDir, `${stem}.intro.txt`), script.text + '\n');
  console.log(`[intro] script: ${script.text}`);

  if (facts.judgesRedacted) {
    warnings.push('Judgment names no judge (redacted), so the intro does not name the bench — ' +
      'which is the one thing HeyGen exists to do here.');
  }

  // 3. voice, with character alignment for timing the upper half
  const audio = path.join(outDir, `${stem}.intro.mp3`);
  await speak(script.text, { outFile: audio });
  const align = readAlignment(audio);
  if (!align) warnings.push('No alignment data; the upper half will hold the court photo throughout.');

  // 4. presenter, transparent so it can sit on Flow's exact grey
  const presenter = path.join(outDir, `${stem}.presenter.webm`);
  await renderAvatar({
    audioFile: audio, outFile: presenter, aspectRatio: '9:16', resolution: '1080p',
    // Waist-up Flow still; see HEYGEN_SOURCE_IMAGE in .env.
    sourceImage: process.env.HEYGEN_SOURCE_IMAGE,
  });

  // 5. composite
  const seconds = probeDuration(presenter);
  const video = path.join(outDir, `${stem}.intro.mp4`);
  const workDir = path.join(outDir, 'cards');
  fs.mkdirSync(workDir, { recursive: true });
  compose({ facts, presenter, audio, script, align, out: video, seconds, warnings, workDir });

  return { script: script.text, audio, presenter, video, seconds, warnings };
}

/** One 1080x960 card for the upper half, pre-rendered as a still. */
function renderTopCard(o: {
  out: string; photo: string | null; caption: string; kicker?: string; portrait: boolean;
}) {
  const args = ['-hide_banner', '-loglevel', 'error', '-y'];
  const chain: string[] = [];

  if (o.photo && !o.portrait) {
    // Court building: fill the box edge to edge.
    args.push('-i', o.photo);
    chain.push(`[0:v]scale=${W}:${SPLIT}:force_original_aspect_ratio=increase,crop=${W}:${SPLIT},eq=brightness=-0.04:saturation=0.95[base]`);
  } else if (o.photo) {
    // Judge portrait: it is a 300px tall studio shot, so blowing it up to fill a
    // 1080-wide box would look like mush. Sit it on a dark card at native scale.
    args.push('-f', 'lavfi', '-i', `color=c=0x11161C:s=${W}x${SPLIT}`);
    args.push('-i', o.photo);
    chain.push(`[1:v]scale=-1:660:flags=lanczos,pad=iw+10:670:5:5:color=0xF0B429[p]`);
    chain.push(`[0:v][p]overlay=(W-w)/2:120[base]`);
  } else {
    // No verified portrait. Rather than an empty box with a small caption, set the
    // name large and centred so the card reads as a deliberate title, not a missing
    // image. Never substitute another judge's face to fill the space.
    args.push('-f', 'lavfi', '-i', `color=c=0x11161C:s=${W}x${SPLIT}`);
    const name = (o.caption || '').replace(/^Justice\s+/i, '');
    chain.push(
      `[0:v]drawbox=90:${SPLIT / 2 - 150}:6:300:0xF0B429@1:t=fill,` +
      `drawtext=fontfile='${BOLD}':text='HON\u2019BLE':fontcolor=0xF0B429:fontsize=34:x=140:y=${SPLIT / 2 - 130},` +
      `drawtext=fontfile='${BLACK}':text='JUSTICE':fontcolor=white:fontsize=52:x=140:y=${SPLIT / 2 - 80},` +
      `drawtext=fontfile='${BLACK}':text='${dt(name.toUpperCase())}':fontcolor=white:fontsize=68:x=140:y=${SPLIT / 2 - 10}[base]`,
    );
    o.caption = '';   // the name is already the card
  }

  const txt: string[] = [];
  if (o.kicker) {
    txt.push(`drawbox=0:0:${W}:96:black@0.55:t=fill`);
    txt.push(`drawtext=fontfile='${BLACK}':text='${dt(o.kicker)}':fontcolor=0xF0B429:fontsize=40:x=(w-tw)/2:y=28`);
  }
  if (o.caption) {
    txt.push(`drawbox=0:${SPLIT - 92}:${W}:92:black@0.62:t=fill`);
    txt.push(`drawtext=fontfile='${BOLD}':text='${dt(o.caption)}':fontcolor=white:fontsize=42:x=(w-tw)/2:y=${SPLIT - 68}`);
  }
  chain.push(`[base]${txt.length ? txt.join(',') : 'null'}[out]`);

  args.push('-filter_complex', chain.join(';'), '-map', '[out]', '-frames:v', '1', o.out);
  sh('ffmpeg', args);
}

/**
 * Build the intro frame: presenter on Flow grey in the lower half, and in the upper
 * half a card that changes as he speaks — the court while he names the court, then
 * each judge's portrait as he names that judge. Cut points come from ElevenLabs
 * character alignment, so a portrait lands on the name rather than near it.
 */
function compose(a: {
  facts: JudgmentFacts; presenter: string; audio: string; script: IntroScript;
  align: Alignment | null; out: string; seconds: number; warnings: string[]; workDir: string;
}) {
  const { facts } = a;
  const courtPhoto = courtImage(facts);
  if (!courtPhoto) {
    a.warnings.push(`No verified photograph for ${facts.court}; using a name card instead. ` +
      'Better a plain card than a wrong or invented courthouse.');
  }

  // Build the upper-half timeline: [from, to, cardPng]
  type Seg = { from: number; to: number; card: string };
  const segs: Seg[] = [];
  const courtCard = path.join(a.workDir, 'top_court.png');
  const courtLine = facts.court.replace(/^the\s+/i, '').replace(/\s+at\s+[A-Za-z .]+$/i, '').toUpperCase();
  renderTopCard({ out: courtCard, photo: courtPhoto, caption: '', kicker: courtLine, portrait: false });

  const cuts: { at: number; card: string }[] = [];
  let lastNameEnds = 0;
  facts.judges.forEach((name, n) => {
    const phrase = a.script.cues.judgePhrases[n];
    const img = judgeImage(name);
    if (!img) {
      // Never pair a name with an unverified face. A name-only card is honest.
      a.warnings.push(`No verified portrait for Justice ${name} — showing a name card, not a stand-in photo.`);
    }
    const t = a.align ? timeOf(a.align, a.script.text, phrase) : null;
    if (!t) {
      a.warnings.push(`Could not time "${phrase}" in the narration; its card is skipped.`);
      return;
    }
    const card = path.join(a.workDir, `top_judge_${n}.png`);
    renderTopCard({ out: card, photo: img, caption: `Justice ${name}`, kicker: courtLine, portrait: true });
    // Land just before the name is said, so the picture leads the words slightly.
    cuts.push({ at: Math.max(0, t.start - 0.25), card });
    lastNameEnds = Math.max(lastNameEnds, t.end);
  });

  // Once the bench has been named, go back to the court. Otherwise the final judge's
  // card sits on screen for the whole run-out — six seconds of static type in an
  // eighteen second video.
  if (lastNameEnds > 0 && a.seconds - lastNameEnds > 1.5) {
    cuts.push({ at: lastNameEnds + 0.4, card: courtCard });
  }

  cuts.sort((x, y) => x.at - y.at);
  let cursor = 0;
  for (const c of cuts) {
    if (c.at > cursor) segs.push({ from: cursor, to: c.at, card: courtCard });
    cursor = c.at;
  }
  if (cuts.length === 0) {
    segs.push({ from: 0, to: a.seconds, card: courtCard });
  } else {
    cuts.forEach((c, i) => {
      const to = i + 1 < cuts.length ? cuts[i + 1].at : a.seconds;
      segs.push({ from: c.at, to, card: c.card });
    });
  }

  // ── assemble ───────────────────────────────────────────────────────────────
  const inputs: string[] = [];
  const chain: string[] = [];
  let idx = 0;

  inputs.push('-f', 'lavfi', '-t', String(a.seconds), '-i', `color=c=${FLOW_GREY}:s=${W}x${H}:r=${FPS}`);
  const greyIdx = idx++;
  chain.push(`[${greyIdx}:v]null[grey]`);

  inputs.push('-c:v', 'libvpx-vp9', '-i', a.presenter);
  const presIdx = idx++;
  chain.push(
    `[${presIdx}:v]scale=iw*${PRESENTER_ZOOM}:ih*${PRESENTER_ZOOM},` +
    `crop=iw:${SPLIT}:0:${PRESENTER_CROP_Y}[pres]`,
  );
  chain.push(`[grey][pres]overlay=(W-w)/2:${SPLIT}:format=auto[stage0]`);

  let last = 'stage0';
  segs.forEach((s, i) => {
    inputs.push('-loop', '1', '-t', String(a.seconds), '-i', s.card);
    const ci = idx++;
    chain.push(`[${ci}:v]setpts=PTS-STARTPTS[card${i}]`);
    chain.push(
      `[${last}][card${i}]overlay=0:0:enable='between(t,${s.from.toFixed(3)},${s.to.toFixed(3)})'[stage${i + 1}]`,
    );
    last = `stage${i + 1}`;
  });

  // A hairline in the brand gold makes the split deliberate rather than accidental.
  chain.push(`[${last}]drawbox=0:${SPLIT - 3}:${W}:6:0xF0B429@1:t=fill[out]`);

  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    ...inputs,
    '-i', a.audio,
    '-filter_complex', chain.join(';'),
    '-map', '[out]', '-map', `${idx}:a`,
    '-t', String(a.seconds),
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-r', String(FPS), '-shortest',
    a.out,
  ];
  console.log(`[intro] compositing ${segs.length} top segment(s)…`);
  sh('ffmpeg', args);
  console.log(`[intro] wrote ${path.basename(a.out)}`);
}

if (require.main === module) {
  (async () => {
    const file = process.argv[2];
    if (!file) { console.error('usage: tsx src/shortsIntro.ts <judgment.pdf>'); process.exit(1); }
    const acct = await account();
    console.log(`[heygen] wallet $${acct.balance} (${acct.email})`);
    const r = await buildIntro(file, 'shorts_out');
    console.log(`\nintro: ${r.video}  (${r.seconds.toFixed(1)}s)`);
    if (r.warnings.length) {
      console.log('\nwarnings:');
      for (const w of r.warnings) console.log('  - ' + w);
    }
  })().catch(e => { console.error(e.message || e); process.exit(1); });
}
