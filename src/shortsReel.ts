/**
 * Judgment PDF -> a complete 9:16 reel: intro, story, outro.
 *
 *   npx tsx src/shortsReel.ts judgments/<file>.pdf [--broll <dir>]
 *
 * Structure, in the split frame the channel already uses (boundary at exactly 50%):
 *
 *   lower half   the presenter on Flow's studio grey, for the WHOLE reel, rendered
 *                once by HeyGen from a Flow-generated still and driven by the host's
 *                cloned ElevenLabs voice.
 *   upper half   intro  - the court photograph, then each judge's portrait as his
 *                         name is spoken, each with a slow push so it is a moving
 *                         shot rather than a pasted still
 *                story  - Google Flow animation, one clip per beat
 *                outro  - a closing card
 *
 * DIVISION OF LABOUR — fixed by the user, do not "improve" it:
 *
 *   intro   HeyGen avatar + the cloned ElevenLabs voice. This is the ONLY part HeyGen
 *           renders, because it is the only part that names the judges, which Flow
 *           refuses ("prominent people").
 *   story   Google Flow's own @me avatar with its verified voice, plus Flow B-roll
 *           above it. Everything after the intro is Flow.
 *
 * An earlier build rendered all 90s through HeyGen so the voice never changed mid-reel.
 * That was rejected: the brief is intro-only. The seam between the HeyGen intro and the
 * Flow story is accepted and was measured as slight (see AB_TEST_seam.mp3).
 *
 * No divider line between the halves — the user asked for the gold rule to be removed.
 */
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { factsFor, JudgmentFacts, speakProvision, speakStatute } from './judgment';
import { speak, readAlignment, timeOf, Alignment } from './voice';
import { renderAvatar, account } from './heygen';

require('dotenv').config();

const COURTS = path.join(process.env.HOME!, 'Desktop/judge-iamge-courts/court_images_real');
const JUDGE_DIRS = [
  path.join(process.env.HOME!, 'Desktop/judge-iamge-courts/judge_images_official'),
  path.join(process.env.HOME!, 'Desktop/judge-iamge-courts/judge_images_karnataka'),
];
const BOLD = '/System/Library/Fonts/Supplemental/Arial Bold.ttf';
const BLACK = '/System/Library/Fonts/Supplemental/Arial Black.ttf';

const W = 1080, H = 1920, FPS = 25;
const SPLIT = H / 2;
const FLOW_GREY = '0x808382';
const GOLD = '0xF0B429';
/** Matches the presenter to the delivered Kerala cut; see shortsIntro for the measurements. */
const PRESENTER_ZOOM = 0.87;
const PRESENTER_CROP_Y = 150;

function sh(bin: string, args: string[]): string {
  return execFileSync(bin, args, { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
}
function probeDuration(f: string): number {
  return Number(sh('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=nw=1:nk=1', f]).trim());
}
function dt(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, '\u2019');
}

function courtImage(f: JudgmentFacts): string | null {
  if (!f.courtSlug) return null;
  const p = path.join(COURTS, `${f.courtSlug}.jpg`);
  return fs.existsSync(p) ? p : null;
}

/** Only returns a portrait we can be certain of; see shortsIntro for why. */
function judgeImage(name: string): string | null {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
  const target = norm(name);
  const files: string[] = [];
  for (const d of JUDGE_DIRS) {
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) if (/\.(jpe?g|png)$/i.test(f)) files.push(path.join(d, f));
  }
  const stem = (f: string) => norm(path.basename(f, path.extname(f)));
  const exact = files.find(f => stem(f) === target);
  if (exact) return exact;
  const words = target.split(' ').filter(w => w.length > 1);
  if (!words.length) return null;
  const m = files.filter(f => { const c = stem(f).split(' '); return words.every(w => c.includes(w)); });
  return m.length === 1 ? m[0] : null;
}

// ── script ───────────────────────────────────────────────────────────────────

export interface ReelScript {
  text: string;
  courtPhrase: string;
  judgePhrases: string[];
  beats: string[];
  outro: string;
}

export function buildReelScript(f: JudgmentFacts & { outro?: string }): ReelScript {
  const isSupreme = /supreme court/i.test(f.court);
  const courtPhrase = isSupreme
    ? 'the Supreme Court'
    : 'the ' + f.court.replace(/^the\s+/i, '').replace(/\s+at\s+[A-Za-z .]+$/i, '');
  // "Shri" is dropped when the name already opens with an honorific — the first draft
  // said "Justice Shri Shree Chandrashekhar".
  const judgePhrases = f.judges.map(j =>
    /^(shri|shree|sri|smt)\b/i.test(j) ? `Justice ${j}` : `Justice Shri ${j}`);

  let bench = '';
  if (judgePhrases.length === 1) bench = `, delivered by Honourable ${judgePhrases[0]}`;
  else if (judgePhrases.length > 1) {
    const rest = judgePhrases.slice(0, -1).join(', ');
    bench = `, delivered by the bench of Honourable ${rest} and ${judgePhrases[judgePhrases.length - 1]}`;
  }

  const statute = f.statute ? speakStatute(f.statute) : null;
  const on = f.provisions.length
    ? `, on ${speakProvision(f.provisions[0])}${statute ? ' of the ' + statute : ''}`
    : statute ? `, on the ${statute}` : '';

  const intro =
    `Hi, I am Ravishankar from LawWorld, India's cost effective and accurate legal solution. ` +
    `I bring you this recent judgement from ${courtPhrase}${bench}${on}. Let us look at the story.`;

  const outro = f.outro || 'Follow LawWorld for judgements explained simply.';
  const text = [intro, ...f.storyBeats, outro].join(' ').replace(/\s+/g, ' ').replace(/\s([,.])/g, '$1');
  return { text, courtPhrase, judgePhrases, beats: f.storyBeats, outro };
}

// ── upper-half cards ─────────────────────────────────────────────────────────

/** A still rendered into a 1080x960 card, optionally with a slow push applied later. */
function renderCard(o: { out: string; photo: string | null; kicker?: string; caption?: string; portrait: boolean }) {
  const args = ['-hide_banner', '-loglevel', 'error', '-y'];
  const chain: string[] = [];
  if (o.photo && !o.portrait) {
    args.push('-i', o.photo);
    chain.push(`[0:v]scale=${W}:${SPLIT}:force_original_aspect_ratio=increase,crop=${W}:${SPLIT},eq=brightness=-0.04:saturation=0.95[base]`);
  } else if (o.photo) {
    args.push('-f', 'lavfi', '-i', `color=c=0x11161C:s=${W}x${SPLIT}`, '-i', o.photo);
    chain.push(`[1:v]scale=-1:660:flags=lanczos,pad=iw+10:670:5:5:color=${GOLD}[p]`);
    chain.push(`[0:v][p]overlay=(W-w)/2:120[base]`);
  } else {
    args.push('-f', 'lavfi', '-i', `color=c=0x11161C:s=${W}x${SPLIT}`);
    chain.push(`[0:v]null[base]`);
  }
  const txt: string[] = [];
  if (o.kicker) {
    txt.push(`drawbox=0:0:${W}:96:black@0.55:t=fill`);
    txt.push(`drawtext=fontfile='${BLACK}':text='${dt(o.kicker)}':fontcolor=${GOLD}:fontsize=40:x=(w-tw)/2:y=28`);
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
 * Turn a still card into a moving clip.
 *
 * The user's note was explicit: the upper half must not look like a pasted photograph.
 * A slow push over the clip's length is the cheapest way to give a still some life, and
 * it matches how the B-roll behind it moves.
 */
function pushClip(card: string, seconds: number, out: string) {
  const frames = Math.max(2, Math.ceil(seconds * FPS));
  sh('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
    '-loop', '1', '-t', String(seconds), '-i', card,
    '-vf', `scale=${W * 2}:-1,zoompan=z='min(1+0.0009*on,1.12)':d=${frames}:s=${W}x${SPLIT}:fps=${FPS},setsar=1`,
    '-frames:v', String(frames), '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
    '-pix_fmt', 'yuv420p', out]);
}

/** Fit any clip to the upper half for `seconds`, looping or trimming as needed. */
function fitClip(src: string, seconds: number, out: string) {
  sh('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
    '-stream_loop', '-1', '-i', src, '-t', String(seconds),
    '-vf', `scale=${W}:${SPLIT}:force_original_aspect_ratio=increase,crop=${W}:${SPLIT},fps=${FPS},setsar=1`,
    '-an', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', out]);
}

// ── build ────────────────────────────────────────────────────────────────────

export interface Segment { from: number; to: number; clip: string; label: string }

export async function buildReel(judgmentFile: string, outDir: string, brollDir?: string) {
  const warnings: string[] = [];
  fs.mkdirSync(outDir, { recursive: true });
  const work = path.join(outDir, 'work');
  fs.mkdirSync(work, { recursive: true });
  const stem = path.basename(judgmentFile).replace(/\.[^.]+$/, '').slice(0, 40);

  const { facts, cached } = await factsFor(judgmentFile);
  console.log(`[reel] ${facts.court} — facts ${cached ? 'cached' : 'extracted'}`);
  const script = buildReelScript(facts as any);
  fs.writeFileSync(path.join(outDir, `${stem}.script.txt`), script.text + '\n');
  const words = script.text.split(/\s+/).length;
  console.log(`[reel] script ${words} words (~${Math.round(words / 2.6)}s at explainer pace)`);

  // 1. one narration for the whole reel, so the voice never changes mid-cut
  const audio = path.join(outDir, `${stem}.mp3`);
  await speak(script.text, { outFile: audio });
  const align = readAlignment(audio);
  if (!align) throw new Error('no alignment returned; the upper half cannot be timed without it');
  const total = probeDuration(audio);
  console.log(`[reel] narration ${total.toFixed(1)}s`);

  // 2. presenter for the whole reel
  const presenter = path.join(outDir, `${stem}.presenter.webm`);
  await renderAvatar({
    audioFile: audio, outFile: presenter, aspectRatio: '9:16', resolution: '1080p',
    sourceImage: process.env.HEYGEN_SOURCE_IMAGE,
  });

  // 3. upper-half timeline, timed off the narration itself
  const at = (phrase: string) => {
    const t = timeOf(align, script.text, phrase);
    return t ? t.start : null;
  };

  const segs: Segment[] = [];
  const courtPhoto = courtImage(facts);
  if (!courtPhoto) warnings.push(`No verified photograph for ${facts.court}; using a name card.`);

  const courtLine = facts.court.replace(/^the\s+/i, '').replace(/\s+at\s+[A-Za-z .]+$/i, '').toUpperCase();
  const courtCard = path.join(work, 'card_court.png');
  renderCard({ out: courtCard, photo: courtPhoto, kicker: courtLine, portrait: false });

  // intro: court -> judge -> judge, each landing just before the name is spoken
  const cuts: { at: number; card: string; label: string }[] = [{ at: 0, card: courtCard, label: 'court' }];
  facts.judges.forEach((name, i) => {
    const phrase = script.judgePhrases[i];
    const t = at(phrase);
    if (t === null) { warnings.push(`could not time "${phrase}"`); return; }
    const img = judgeImage(name);
    if (!img) warnings.push(`No verified portrait for Justice ${name} — name card only, never a stand-in face.`);
    const card = path.join(work, `card_judge${i}.png`);
    renderCard({ out: card, photo: img, kicker: courtLine, caption: `Justice ${name}`, portrait: true });
    cuts.push({ at: Math.max(0, t - 0.25), card, label: `judge:${name}` });
  });

  // story: one B-roll clip per beat
  const brolls = brollDir && fs.existsSync(brollDir)
    ? fs.readdirSync(brollDir).filter(f => /\.mp4$/i.test(f)).sort().map(f => path.join(brollDir, f))
    : [];
  if (brollDir && !brolls.length) warnings.push(`No B-roll clips found in ${brollDir}; the story will hold the court photo.`);

  const beatStarts: number[] = [];
  script.beats.forEach(b => {
    // Time each beat by its opening words, which are unique enough to locate.
    const key = b.split(/\s+/).slice(0, 5).join(' ');
    const t = at(key);
    if (t !== null) beatStarts.push(t);
    else { warnings.push(`could not time beat "${key}…"`); beatStarts.push(NaN); }
  });

  script.beats.forEach((b, i) => {
    const t = beatStarts[i];
    if (Number.isNaN(t)) return;
    const clip = brolls.length ? brolls[i % brolls.length] : null;
    cuts.push({ at: t, card: clip || courtCard, label: clip ? `broll${i}` : `beat${i}(no broll)` });
  });

  // outro
  const outroAt = at(script.outro.split(/\s+/).slice(0, 5).join(' '));
  const outroCard = path.join(work, 'card_outro.png');
  renderCard({ out: outroCard, photo: courtPhoto, kicker: 'LAWWORLD', caption: facts.headline, portrait: false });
  if (outroAt !== null) cuts.push({ at: outroAt, card: outroCard, label: 'outro' });

  cuts.sort((a, b) => a.at - b.at);
  for (let i = 0; i < cuts.length; i++) {
    const from = cuts[i].at;
    const to = i + 1 < cuts.length ? cuts[i + 1].at : total;
    if (to - from < 0.35) continue;                 // too short to register as a shot
    const seg = path.join(work, `seg_${String(segs.length).padStart(2, '0')}.mp4`);
    const secs = to - from;
    if (/\.png$/i.test(cuts[i].card)) pushClip(cuts[i].card, secs, seg);
    else fitClip(cuts[i].card, secs, seg);
    segs.push({ from, to, clip: seg, label: cuts[i].label });
  }
  console.log(`[reel] upper half: ${segs.length} shots`);
  for (const s of segs) console.log(`   ${s.from.toFixed(1).padStart(5)}s  ${s.label}`);

  // 4. concat the upper half, then stack presenter beneath it
  const listFile = path.join(work, 'upper.txt');
  fs.writeFileSync(listFile, segs.map(s => `file '${path.resolve(s.clip)}'`).join('\n'));
  const upper = path.join(work, 'upper.mp4');
  sh('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0',
    '-i', listFile, '-c', 'copy', upper]);

  const out = path.join(outDir, `${stem}.reel.mp4`);
  sh('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-t', String(total), '-i', `color=c=${FLOW_GREY}:s=${W}x${H}:r=${FPS}`,
    '-c:v', 'libvpx-vp9', '-i', presenter,
    '-i', upper,
    '-i', audio,
    '-filter_complex',
    `[1:v]scale=iw*${PRESENTER_ZOOM}:ih*${PRESENTER_ZOOM},crop=iw:${SPLIT}:0:${PRESENTER_CROP_Y}[pres];` +
    `[0:v][pres]overlay=(W-w)/2:${SPLIT}:format=auto[low];` +
    `[2:v]scale=${W}:${SPLIT}[up];` +
    `[low][up]overlay=0:0[out]`,
    '-map', '[out]', '-map', '3:a', '-t', String(total),
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-r', String(FPS), '-shortest', out]);

  console.log(`[reel] wrote ${out}`);
  return { out, total, warnings, segs, script };
}

if (require.main === module) {
  (async () => {
    const file = process.argv[2];
    const bi = process.argv.indexOf('--broll');
    const brollDir = bi > 0 ? process.argv[bi + 1] : undefined;
    if (!file) { console.error('usage: tsx src/shortsReel.ts <judgment.pdf> [--broll <dir>]'); process.exit(1); }
    const a = await account();
    console.log(`[heygen] wallet $${a.balance}`);
    const r = await buildReel(file, 'shorts_out', brollDir);
    console.log(`\nreel: ${r.out}  (${r.total.toFixed(1)}s)`);
    if (r.warnings.length) { console.log('\nwarnings:'); r.warnings.forEach(w => console.log('  - ' + w)); }
  })().catch(e => { console.error(e.message || e); process.exit(1); });
}
