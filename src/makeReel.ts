/**
 * ONE COMMAND: judgment PDF -> finished 9:16 LawWorld reel.
 *
 *   npx tsx src/makeReel.ts judgments/<file>.pdf
 *   npx tsx src/makeReel.ts judgments/<file>.pdf --yes     (skip the review gate)
 *   npx tsx src/makeReel.ts judgments/<file>.pdf --from 4  (resume at a stage)
 *
 * Stages, each resumable and each skipped if its output already exists:
 *
 *   1  extract   PDF -> JudgmentFacts               (LLM; cached as <pdf>.facts.json)
 *   2  write     facts -> story + B-roll storyboards (LLM; cached as storyboard_*_<stem>.json)
 *   3  validate  every dialogue fills its clip       (checkFill; hard gate)
 *   4  broll     Flow: 10 narrative story clips
 *   5  story     Flow: 8 presenter clips, verified voice
 *   6  review    contact sheets -> STOP for approval (bypass with --yes)
 *   7  intro     ElevenLabs voice + HeyGen avatar
 *   8  compose   stack, append the outro, write the reel
 *
 * WHY STAGE 6 IS A STOP, NOT A CHECK
 * Flow produces an unusable clip roughly a third of the time — a subject walking the
 * wrong way, readable signage despite a negative prompt, a rectangular artifact. None of
 * those are detectable automatically with any reliability; they need eyes. The pipeline
 * therefore builds the contact sheets and waits. `--yes` skips the wait for unattended
 * runs, and accepts that some reels will need a clip regenerated afterwards.
 *
 * PREREQUISITES, both external and both currently unmet:
 *   OPENAI_API_KEY   stages 1-2. The key in .env returns 401.
 *   HeyGen credit    stage 7. Wallet is $0.03; an intro costs ~$0.65.
 * Everything else — ElevenLabs, Flow, ffmpeg — is working.
 */
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { factsFor, JudgmentFacts } from './judgment';
import { targetWords } from './checkFill';

require('dotenv').config();

const OUT = 'shorts_out';

function run(cmd: string, args: string[], label: string) {
  console.log(`\n→ ${label}`);
  execFileSync(cmd, args, { stdio: 'inherit' });
}
function has(p: string): boolean {
  return fs.existsSync(p) && (fs.statSync(p).isDirectory()
    ? fs.readdirSync(p).length > 0
    : fs.statSync(p).size > 1000);
}

/** Ask the model for the per-scene dialogue and the narrative B-roll, in one call. */
const PLAN_PROMPT = (f: JudgmentFacts, words: number) => `
You are writing a 90-second vertical video about an Indian judgment for LawWorld, a legal
explainer channel. Return JSON only:

{
  "story":  [ { "sceneId": "s01_...", "dialogue": "..." }, ... 8 scenes ],
  "broll":  [ { "sceneId": "b01_...", "brollRealistic": "..." }, ... 10 shots ],
  "headline": "4-8 word headline"
}

DIALOGUE RULES — these are hard constraints, not preferences:
- EXACTLY 8 scenes. Each dialogue MUST be ${words - 1} to ${words + 1} words. Not fewer.
  The presenter speaks 3.1 words/sec into a 10-second clip; a short line leaves dead air
  and makes the avatar repeat itself to pad the time.
- Spell numbers as words ("nineteen eighty one", "Section one hundred") — digits are read
  out wrongly.
- NEVER name a judge in the dialogue. Say "the High Court", "the Court", "the Bench".
- NEVER write that the State, the Government or any party "admitted", "conceded" or
  "failed". State what the Court HELD. Both of these are refused by the video generator.
- Plain spoken language for a general audience, not legalese. Tell it as a story.

B-ROLL RULES:
- EXACTLY 10 shots, one per story beat plus two spare, each RE-ENACTING its moment with
  real people doing a specific thing in a specific Indian place. Not stock scenery.
- NEVER describe anyone walking toward or away from camera — the generator renders gait
  backwards. Keep subjects still or seated and let the CAMERA move.
- No text, signage, logos or recognisable public figures. No courtroom with a judge.

THE JUDGMENT:
court: ${f.court}
provisions: ${f.provisions.join(', ')}
question: ${f.question}
holding: ${f.holding}
outcome: ${f.outcome}
facts: ${f.storyBeats.join(' ')}
`.trim();

async function plan(facts: JudgmentFacts, stem: string): Promise<{ story: string; broll: string }> {
  const storyPath = `storyboard_story_${stem}.json`;
  const brollPath = `storyboard_broll_${stem}.json`;
  if (has(storyPath) && has(brollPath)) {
    console.log('  storyboards already written, reusing');
    return { story: storyPath, broll: brollPath };
  }

  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY missing — stage 2 cannot run');
  const OpenAI = require('openai').default || require('openai').OpenAI;
  const client = new OpenAI({ apiKey: key });
  const { ideal } = targetWords(10);

  const res = await client.chat.completions.create({
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    response_format: { type: 'json_object' },
    temperature: 0.4,
    messages: [{ role: 'user', content: PLAN_PROMPT(facts, ideal) }],
  });
  const out = JSON.parse(res.choices[0].message.content || '{}');

  // Clone the proven style blocks rather than letting the model invent them; only the
  // dialogue and the B-roll subjects vary between judgments.
  const storyBase = JSON.parse(fs.readFileSync('storyboard_story_bhagsingh.json', 'utf8'));
  const brollBase = JSON.parse(fs.readFileSync('storyboard_broll_bhagsingh.json', 'utf8'));
  storyBase.projectTitle = `LawWorld_Story_${stem}`;
  storyBase.downloadFolder = `./downloads/LawWorld_Story_${stem}`;
  delete storyBase.flowProjectUrl;
  storyBase.scenes = out.story.map((s: any) => ({
    sceneId: s.sceneId, sanitizeDialogue: false, dialogue: s.dialogue,
    visual3D: 'Ravishankar speaking to camera, same pose and framing as every other clip, plain grey background, no props, no graphics.',
  }));
  brollBase.projectTitle = `LawWorld_Broll_${stem}`;
  brollBase.downloadFolder = `./downloads/LawWorld_Broll_${stem}`;
  delete brollBase.flowProjectUrl;
  brollBase.scenes = out.broll.map((b: any) => ({ sceneId: b.sceneId, brollRealistic: b.brollRealistic }));

  fs.writeFileSync(storyPath, JSON.stringify(storyBase, null, 2));
  fs.writeFileSync(brollPath, JSON.stringify(brollBase, null, 2));
  console.log(`  wrote ${storyPath} and ${brollPath}`);
  return { story: storyPath, broll: brollPath };
}

(async () => {
  const pdf = process.argv[2];
  if (!pdf) { console.error('usage: tsx src/makeReel.ts <judgment.pdf> [--yes] [--from N]'); process.exit(1); }
  const skipReview = process.argv.includes('--yes');
  const fromIdx = process.argv.indexOf('--from');
  const from = fromIdx > 0 ? Number(process.argv[fromIdx + 1]) : 1;
  const stem = path.basename(pdf).replace(/\.[^.]+$/, '').slice(0, 32).replace(/[^A-Za-z0-9_]/g, '_');

  // 1 — facts
  console.log('\n→ 1/8 extracting facts');
  const { facts, cached } = await factsFor(pdf);
  console.log(`  ${facts.court} — ${facts.judges.length} judge(s) — facts ${cached ? 'cached' : 'extracted'}`);
  if (facts.judgesRedacted) console.log('  [warn] no judge named in this judgment');

  // 2 — storyboards
  console.log('\n→ 2/8 planning story and B-roll');
  const sb = await plan(facts, stem);

  // 3 — validate
  if (from <= 3) run('npx', ['tsx', 'src/checkFill.ts', sb.story], '3/8 validating dialogue fill');

  // 4, 5 — Flow. One browser at a time, so these are strictly sequential.
  const brollDir = `downloads/LawWorld_Broll_${stem}/broll_realistic`;
  if (from <= 4 && !has(brollDir)) {
    run('npx', ['tsx', 'src/index.ts', '--config', sb.broll, '--broll', '--no-merge'], '4/8 Flow: story B-roll');
  } else console.log('\n→ 4/8 B-roll already present, skipping');

  const storyDir = `downloads/LawWorld_Story_${stem}`;
  if (from <= 5 && !has(storyDir)) {
    run('npx', ['tsx', 'src/index.ts', '--config', sb.story, '--no-merge'], '5/8 Flow: presenter clips');
  } else console.log('\n→ 5/8 story clips already present, skipping');

  // 6 — the human gate
  if (from <= 6) {
    run('npx', ['tsx', 'src/reviewClips.ts', brollDir, storyDir], '6/8 building review sheets');
    if (!skipReview) {
      console.log(`\n── REVIEW ──`);
      console.log(`Open ${OUT}/review/review_*.png and check every clip for:`);
      console.log('  a subject moving the wrong way, readable text, deformed limbs, a shot that never moves');
      console.log('To regenerate one:  mv <clip> /tmp/ && npx tsx src/index.ts --config <storyboard> --broll --scene <id> --no-merge');
      console.log(`Then continue:      npx tsx src/makeReel.ts ${pdf} --from 7\n`);
      process.exit(0);
    }
  }

  // 7 — intro
  const intro = path.join(OUT, `${stem}_intro.mp4`);
  if (from <= 7 && !has(intro)) {
    run('npx', ['tsx', 'src/shortsIntro.ts', pdf], '7/8 HeyGen intro');
  }

  // 8 — compose
  const outroLib = 'assets/outro_library';
  const outros = fs.existsSync(outroLib) ? fs.readdirSync(outroLib).filter(f => /\.mp4$/.test(f)).sort() : [];
  const args = ['tsx', 'src/composeReel.ts',
    '--intro', has(intro) ? intro : path.join(OUT, 'bhagsingh_intro.mp4'),
    '--story', storyDir, '--broll', brollDir,
    '--out', path.join(OUT, `${stem}_reel.mp4`)];
  if (fs.existsSync(path.join(OUT, 'outro_card.mp4'))) args.push('--outro-card', path.join(OUT, 'outro_card.mp4'));
  if (outros.length) {
    // Rotate the advert so consecutive uploads do not end identically.
    const pick = outros[Math.abs([...stem].reduce((a, c) => a + c.charCodeAt(0), 0)) % outros.length];
    args.push('--outro-clip', path.join(outroLib, pick));
  }
  run('npx', args, '8/8 composing');
  console.log(`\ndone: ${OUT}/${stem}_reel.mp4`);
})().catch(e => { console.error('\n' + (e.message || e)); process.exit(1); });
