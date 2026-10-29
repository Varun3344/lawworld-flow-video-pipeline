/**
 * Check that every scene's dialogue actually FILLS its clip.
 *
 *   npx tsx src/checkFill.ts storyboard_story_<name>.json
 *
 * Run this BEFORE generating. An under-filled scene is the single most common quality
 * fault in the finished reel, and it shows up two ways:
 *
 *   - dead air, the avatar standing silent for a second or two at the end of a clip
 *   - the avatar REPEATING a phrase to pad the duration, despite the prompt saying
 *     "speak the dialogue exactly once, never repeat"
 *
 * Measured from eight delivered clips: the @me avatar speaks at **3.1 words/sec**.
 * A 10s clip therefore wants ~31 words. Writing 25 leaves ~2s of silence; across seven
 * story clips that was 12.4 seconds of dead air in one reel.
 *
 * maxWordsPerClip in the storyboard is a CEILING, not a target — it was set to 33 while
 * the dialogues ran 24-27, so nothing complained.
 */
import fs from 'fs';

/** Words per second for the Flow @me avatar at the storyboard's brisk explainer pace. */
export const WORDS_PER_SEC = 3.1;
/** Leave a breath at the end, but no more. */
export const TAIL_SECONDS = 0.35;

export function targetWords(clipSeconds: number): { min: number; ideal: number; max: number } {
  const usable = clipSeconds - TAIL_SECONDS;
  const ideal = Math.round(usable * WORDS_PER_SEC);
  return { min: ideal - 2, ideal, max: ideal + 2 };
}

if (require.main === module) {
  const file = process.argv[2];
  if (!file) { console.error('usage: tsx src/checkFill.ts <storyboard.json>'); process.exit(1); }
  const sb = JSON.parse(fs.readFileSync(file, 'utf8'));
  const secs: number = sb.clipDurationSeconds ?? 10;
  const t = targetWords(secs);

  console.log(`clip ${secs}s at ${WORDS_PER_SEC} w/s -> target ${t.min}-${t.max} words (ideal ${t.ideal})\n`);
  let bad = 0;
  for (const sc of sb.scenes || []) {
    const d: string = sc.dialogue || '';
    if (!d) continue;
    const w = d.split(/\s+/).filter(Boolean).length;
    const speech = w / WORDS_PER_SEC;
    const slack = secs - speech;
    let flag = '';
    if (w < t.min) { flag = `UNDER-FILLED — ~${slack.toFixed(1)}s dead air, risks repetition`; bad++; }
    else if (w > t.max) { flag = `OVER-FILLED — will be rushed or truncated`; bad++; }
    console.log(`${sc.sceneId.padEnd(18)} ${String(w).padStart(3)} words  speech ~${speech.toFixed(1)}s  ${flag}`);
  }
  console.log(bad ? `\n${bad} scene(s) need rewriting before generating.` : '\nAll scenes fill their clips.');
  process.exit(bad ? 1 : 0);
}
