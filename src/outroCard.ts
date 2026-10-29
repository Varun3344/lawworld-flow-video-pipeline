/**
 * LawWorld end card — the product advert that closes every reel.
 *
 *   npx tsx src/outroCard.ts [seconds] [out.mp4]
 *
 * Brand palette is taken from lawworld.ai's own stylesheet, not invented:
 *   --color-brand        #d97757   terracotta
 *   --color-accent-deep  #b3573f
 *   --color-brand-soft   #f0b79e
 *   --color-ink          #2a2722
 *   background           #f0eee6   warm cream
 *
 * (The gold #F0B429 used elsewhere in these reels is NOT a LawWorld colour; it was a
 * placeholder. This card is the brand-correct one.)
 *
 * The two features named are real, from the site's own feature list — Case Laws
 * (searchable Supreme Court and High Court judgments) and Drafting (AI petitions,
 * pleadings, affidavits). Never advertise a capability the product does not list.
 */
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

const W = 1080, H = 960, FPS = 25;          // fills the upper half of the 9:16 frame
// Matches the cream the logo PNG itself sits on (#F5F0E8, sampled from its corner),
// NOT the site's page background #F0EEE6 — those differ by enough that the lockup
// showed as a visible rectangle against it.
const CREAM = '0xF5F0E8';
const BRAND = '0xD97757';
const DEEP = '0xB3573F';
const INK = '0x2A2722';

const BLACK = '/System/Library/Fonts/Supplemental/Arial Black.ttf';
const BOLD = '/System/Library/Fonts/Supplemental/Arial Bold.ttf';
/**
 * The real lockup, pulled from lawworld.ai/logo.png — icon plus a SERIF wordmark.
 * An earlier version set "LawWorld" in Arial Black, which is not the brand face at all.
 * It is only 396x126 (the site serves no larger asset; logo@2x, logo.svg and icon-512
 * all 404), so it is used at 1.6x and no more.
 */
const LOCKUP = 'assets/lawworld_logo.png';

function sh(bin: string, args: string[]) {
  execFileSync(bin, args, { encoding: 'utf8', maxBuffer: 1 << 26 });
}
function dt(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, '\u2019');
}

export interface OutroOptions {
  seconds?: number;
  out?: string;
  /** Social handles, e.g. ['@lawworldai', 'youtube.com/@lawworld']. Omitted if empty. */
  handles?: string[];
}

export function buildOutroCard(o: OutroOptions = {}): string {
  const secs = o.seconds ?? 6;
  const out = o.out ?? 'shorts_out/outro_card.mp4';
  fs.mkdirSync(path.dirname(out), { recursive: true });

  const lines: string[] = [];
  const hasLockup = fs.existsSync(LOCKUP);
  if (!hasLockup) {
    // Fallback only — the real mark is a serif face, so this is visibly off-brand.
    lines.push(`drawtext=fontfile='${BLACK}':text='LawWorld':fontcolor=${INK}:fontsize=104:x=90:y=110`);
    lines.push(`drawtext=fontfile='${BLACK}':text='.ai':fontcolor=${BRAND}:fontsize=104:x=624:y=110`);
  }
  lines.push(`drawtext=fontfile='${BOLD}':text='${dt('The all-in-one AI platform for advocates in India')}':fontcolor=${DEEP}:fontsize=34:x=92:y=336`);

  // Two real features, each on a terracotta rule.
  const feat = (y: number, title: string, sub: string) => {
    lines.push(`drawbox=90:${y}:8:86:${BRAND}@1:t=fill`);
    lines.push(`drawtext=fontfile='${BLACK}':text='${dt(title)}':fontcolor=${INK}:fontsize=46:x=126:y=${y + 4}`);
    lines.push(`drawtext=fontfile='${BOLD}':text='${dt(sub)}':fontcolor=${DEEP}:fontsize=30:x=126:y=${y + 56}`);
  };
  feat(430, 'Case Laws', 'Search Supreme Court & High Court judgments');
  feat(560, 'Drafting', 'AI petitions, pleadings and affidavits');

  // Call to action on a terracotta band.
  lines.push(`drawbox=0:${H - 190}:${W}:190:${BRAND}@1:t=fill`);
  lines.push(`drawtext=fontfile='${BLACK}':text='lawworld.ai':fontcolor=white:fontsize=62:x=(w-tw)/2:y=${H - 165}`);
  const cta = o.handles && o.handles.length
    ? o.handles.join('   ·   ')
    : 'Follow LawWorld on all our channels';
  lines.push(`drawtext=fontfile='${BOLD}':text='${dt(cta)}':fontcolor=white:fontsize=32:x=(w-tw)/2:y=${H - 88}`);

  const args = ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-t', String(secs), '-i', `color=c=${CREAM}:s=${W}x${H}:r=${FPS}`];
  let filter: string;
  if (hasLockup) {
    // The lockup ships on the same cream as this card, so it drops straight in.
    args.push('-i', LOCKUP);
    filter = `[1:v]scale=634:-1[mark];[0:v][mark]overlay=86:96[base];[base]${lines.join(',')}`;
  } else {
    filter = `[0:v]${lines.join(',')}`;
  }
  args.push('-filter_complex', filter,
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', out);
  sh('ffmpeg', args);
  return out;
}

if (require.main === module) {
  const secs = Number(process.argv[2]) || 6;
  const out = process.argv[3] || 'shorts_out/outro_card.mp4';
  console.log('wrote ' + buildOutroCard({ seconds: secs, out }));
}
