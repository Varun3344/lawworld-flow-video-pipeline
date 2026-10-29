/**
 * Judgment -> structured facts -> LawWorld shorts script.
 *
 * The user's existing service at ~/Desktop/judge-iamge-courts extracts only
 * { court, judges } from a judgment. A short needs a good deal more: the section
 * or article at issue, what the court actually held, and the story beats that
 * carry the middle of the video. So this asks for the whole shape in one call.
 *
 * Two hard rules are baked into the prompt rather than left to review:
 *
 *  1. NEVER invent. Redacted judgments are normal — this repo's first real input
 *     had "THE HON'BLE MR. JUSTICE [NAME REDACTED]" and "WRIT PETITION NO. [TO BE
 *     NUMBERED]". A model that helpfully fills those in puts a fabricated judge's
 *     name on a legal news channel. Missing facts come back null and the pipeline
 *     works around them.
 *
 *  2. Story scenes must survive Google Flow's policy filter. Flow blocks sentences
 *     framing a government body as admitting wrongdoing ("the State admitted ...")
 *     and refuses to render named judges at all. So story dialogue names no judge
 *     and states what the court HELD, never what the State conceded. The intro is
 *     the one place names are allowed, because HeyGen renders it, not Flow.
 */
import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';

export interface JudgmentFacts {
  court: string;
  courtSlug: string | null;
  judges: string[];
  judgesRedacted: boolean;
  caseNumber: string | null;
  caseDate: string | null;
  parties: { petitioner: string | null; respondent: string | null };
  statute: string | null;
  provisions: string[];
  question: string;
  holding: string;
  outcome: string;
  storyBeats: string[];
  headline: string;
}

/** Court name -> the slug used by court_images_real/ and the judge JSONs. */
const COURT_SLUGS: Record<string, string> = {
  'supreme court of india': 'supreme_court',
  allahabad: 'allahabad', 'andhra pradesh': 'andhra_pradesh', bombay: 'bombay',
  calcutta: 'calcutta', chhattisgarh: 'chhattisgarh', delhi: 'delhi',
  gauhati: 'gauhati', gujarat: 'gujarat', 'himachal pradesh': 'himachal_pradesh',
  'jammu and kashmir': 'jammu_kashmir', jharkhand: 'jharkhand',
  karnataka: 'karnataka', kerala: 'kerala', 'madhya pradesh': 'madhya_pradesh',
  madras: 'madras', manipur: 'manipur', meghalaya: 'meghalaya', orissa: 'orissa',
  patna: 'patna', 'punjab and haryana': 'punjab_haryana', rajasthan: 'rajasthan',
  sikkim: 'sikkim', telangana: 'telangana', tripura: 'tripura',
  uttarakhand: 'uttarakhand',
};

export function courtSlug(court: string): string | null {
  const c = court.toLowerCase();
  if (c.includes('supreme court')) return 'supreme_court';
  for (const [key, slug] of Object.entries(COURT_SLUGS)) {
    if (key !== 'supreme court of india' && c.includes(key)) return slug;
  }
  return null;
}

/** True when the judgment carries a redaction placeholder rather than a real name. */
export function isRedacted(v: string | null | undefined): boolean {
  if (!v) return true;
  return /\[?\s*(name\s+)?redacted\s*\]?|\[to be numbered\]|x{4,}|_{4,}/i.test(v);
}

export async function extractText(file: string): Promise<string> {
  const buf = fs.readFileSync(file);
  if (path.extname(file).toLowerCase() === '.pdf' || buf.subarray(0, 4).toString() === '%PDF') {
    // pdf-parse v2 is a class, not the v1 callable default export — the older
    // `require('pdf-parse')(buf)` form throws here.
    const { PDFParse } = require('pdf-parse');
    const parser = new PDFParse({ data: buf });
    try {
      return (await parser.getText()).text || '';
    } finally {
      await parser.destroy?.();
    }
  }
  return buf.toString('utf8');
}

const SCHEMA_PROMPT = `You are a legal analyst preparing a short news video about an Indian judgment.

Return JSON only, with exactly these keys:
{
  "court": "full court name as written in the judgment",
  "judges": ["full names, no 'Hon'ble'/'Justice' prefix"],
  "caseNumber": "case number or null",
  "caseDate": "date of judgment or null",
  "parties": {"petitioner": "...", "respondent": "..."},
  "statute": "the Act at issue, or null",
  "provisions": ["sections/articles at issue, e.g. 'Section 1(3)', 'Article 265'"],
  "question": "the legal question in one sentence",
  "holding": "what the court held, one or two sentences",
  "outcome": "the operative order in one sentence",
  "storyBeats": ["4 to 6 beats telling the story in plain order"],
  "headline": "a punchy 4-8 word headline for the video"
}

CRITICAL RULES:
- NEVER invent or guess a fact that is not in the text. If the judgment says
  "[NAME REDACTED]", "[TO BE NUMBERED]" or similar, return null for that field
  (empty array for judges). Do not substitute a plausible name. Do not infer a
  judge from the court or the subject matter.
- storyBeats and holding must state what the COURT held or found. Never write that
  the State, the Government or any official body "admitted", "conceded", "failed"
  or "was wrong" — describe the legal position neutrally instead. For example write
  "the commencement notification was never published in the Official Gazette",
  NOT "the State admitted it never published the notification".
- Do not name any judge inside storyBeats. Refer to "the High Court" or "the Court".
- Plain language. These beats are spoken aloud to a general audience.`;

/**
 * Facts for a judgment, from `<judgment>.facts.json` if it exists, else the model.
 *
 * The cache is not only a cost saving. Extraction is the one non-deterministic step
 * in the pipeline, and a short gets re-rendered many times while the edit is tuned —
 * pinning the facts keeps every re-render telling the same story. Delete the file to
 * re-extract.
 */
export async function factsFor(file: string): Promise<{ facts: JudgmentFacts; cached: boolean }> {
  const cache = file.replace(/\.[^.]+$/, '') + '.facts.json';
  if (fs.existsSync(cache)) {
    return { facts: JSON.parse(fs.readFileSync(cache, 'utf8')), cached: true };
  }
  const facts = await extractFacts(await extractText(file));
  fs.writeFileSync(cache, JSON.stringify(facts, null, 2));
  return { facts, cached: false };
}


/** "HIGH COURT OF KARNATAKA AT BENGALURU" -> "High Court of Karnataka at Bengaluru". */
export function titleCaseCourt(c: string): string {
  if (!/[a-z]/.test(c)) {
    const small = new Set(['of', 'at', 'the', 'and', 'for']);
    return c.toLowerCase().split(/\s+/).map((w, i) =>
      i > 0 && small.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  }
  return c;
}

export async function extractFacts(text: string): Promise<JudgmentFacts> {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const res = await client.chat.completions.create({
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    response_format: { type: 'json_object' },
    temperature: 0.2,
    messages: [
      { role: 'system', content: SCHEMA_PROMPT },
      { role: 'user', content: text.slice(0, 60000) },
    ],
  });

  const raw = JSON.parse(res.choices[0].message.content || '{}');
  const judges: string[] = (Array.isArray(raw.judges) ? raw.judges : [])
    .filter((j: string) => j && !isRedacted(j));

  // Judgment headers are set in caps ("HIGH COURT OF KARNATAKA AT BENGALURU"), which
  // the model echoes verbatim. Caps reach the TTS and the on-screen kicker, so
  // normalise to title case while leaving genuine acronyms alone.
  const court = titleCaseCourt(raw.court || 'Unknown Court');
  return {
    court,
    courtSlug: courtSlug(court),
    judges,
    judgesRedacted: judges.length === 0,
    caseNumber: isRedacted(raw.caseNumber) ? null : raw.caseNumber,
    caseDate: raw.caseDate || null,
    parties: {
      petitioner: raw.parties?.petitioner || null,
      respondent: raw.parties?.respondent || null,
    },
    statute: raw.statute || null,
    provisions: Array.isArray(raw.provisions) ? raw.provisions : [],
    question: raw.question || '',
    holding: raw.holding || '',
    outcome: raw.outcome || '',
    storyBeats: Array.isArray(raw.storyBeats) ? raw.storyBeats : [],
    headline: raw.headline || '',
  };
}

// ── Intro script ─────────────────────────────────────────────────────────────

/**
 * Say a provision the way a presenter would, not the way a pleading writes it.
 *
 * "Section 13(1)(i-a)" spoken literally becomes "thirteen sub-section one bracket i
 * dash a" — nonsense on a 15-second intro. Sub-clauses are dropped: the intro is a
 * headline, and the precise clause belongs in the story, not the opening line.
 */
export function speakProvision(p: string): string {
  const kind = /article/i.test(p) ? 'Article' : 'Section';
  const num = p.match(/(\d+)/);
  if (!num) return p;
  return `${kind} ${spellNumber(+num[1])}`;
}

function spellNumber(n: number): string {
  const ones = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
    'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen',
    'eighteen', 'nineteen'];
  const tens = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
  if (n < 20) return ones[n];
  if (n < 100) return tens[Math.floor(n / 10)] + (n % 10 ? '-' + ones[n % 10] : '');
  if (n < 1000) {
    const r = n % 100;
    return ones[Math.floor(n / 100)] + ' hundred' + (r ? ' and ' + spellNumber(r) : '');
  }
  return String(n);
}

/**
 * Statute names are written for the eye, not the ear. "Karnataka Cine and Cultural
 * Activists (Welfare) Act, 2024" is read aloud with the brackets voiced and the year
 * as a bare number; strip one and spell the other.
 */
export function speakStatute(s: string): string {
  return s
    .replace(/[()]/g, '')
    .replace(/,?\s*\b(19|20)(\d{2})\b/g, (_, c, y) => {
      const century = c === '19' ? 'nineteen' : 'twenty';
      const yy = +y;
      if (yy === 0) return ` ${century} hundred`;
      if (yy < 10) return ` ${century} oh ${spellNumber(yy)}`;
      return ` ${century} ${spellNumber(yy)}`;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The intro, in the user's own established format. This is the ONE place judges
 * are named — HeyGen renders it, so Flow's filter never sees it.
 */
export interface IntroScript {
  /** The words to speak. */
  text: string;
  /** Exact substrings of `text`, for timing the top half against the alignment. */
  cues: { courtPhrase: string; judgePhrases: string[] };
}

export function buildIntroScript(f: JudgmentFacts): IntroScript {
  const isSupreme = /supreme court/i.test(f.court);
  // Drop the seat ("at Bengaluru") — it is a mouthful and the photo shows where.
  const courtPhrase = isSupreme
    ? 'the Supreme Court'
    : 'the ' + f.court.replace(/^the\s+/i, '').replace(/\s+at\s+[A-Za-z .]+$/i, '');

  // Do not prepend "Shri" when the name already carries an honorific — otherwise
  // Shree Chandrashekhar becomes "Justice Shri Shree Chandrashekhar". The same fix
  // exists in shortsReel.ts; this path was missed the first time.
  const judgePhrases = f.judges.map(j =>
    /^(shri|shree|sri|smt)\b/i.test(j) ? `Justice ${j}` : `Justice Shri ${j}`);

  let bench = '';
  if (judgePhrases.length === 1) {
    bench = `, delivered by Honourable ${judgePhrases[0]}`;
  } else if (judgePhrases.length > 1) {
    const rest = judgePhrases.slice(0, -1).join(', ');
    bench = `, delivered by the bench of Honourable ${rest} and ${judgePhrases[judgePhrases.length - 1]}`;
  }

  const statute = f.statute ? speakStatute(f.statute) : null;
  const on = f.provisions.length
    ? `, on ${speakProvision(f.provisions[0])}${statute ? ' of the ' + statute : ''}`
    : statute ? `, on the ${statute}` : '';

  // The host's line, tidied into grammatical English at his request ("you can refine")
  // while keeping his identity, his tagline, and the two things the intro exists for:
  // the court's name and the bench.
  const text = (
    `Hi, I am Ravishankar from LawWorld, India's cost effective and accurate legal solution. ` +
    `I bring you this recent judgement from ${courtPhrase}${bench}${on}. ` +
    `Let us look at the story.`
  ).replace(/\s+/g, ' ').replace(/\s([,.])/g, '$1');

  return { text, cues: { courtPhrase, judgePhrases } };
}

if (require.main === module) {
  (async () => {
    const file = process.argv[2];
    if (!file) { console.error('usage: tsx src/judgment.ts <judgment.pdf>'); process.exit(1); }
    require('dotenv').config();
    const { facts, cached } = await factsFor(file);
    console.log(`[judgment] facts ${cached ? 'from cache' : 'extracted'}`);
    console.log(JSON.stringify(facts, null, 2));
    // buildIntroScript returns { text, cues }, not a string; printing the object
    // itself gave "[object Object]".
    console.log('\n--- INTRO SCRIPT ---\n' + buildIntroScript(facts).text);
    if (facts.judgesRedacted) {
      console.log('\n[warn] no judge name in this judgment - intro will not name the bench');
    }
    if (!facts.courtSlug) console.log('[warn] no court image slug matched for: ' + facts.court);
  })().catch(e => { console.error(e); process.exit(1); });
}
