/**
 * ElevenLabs text-to-speech in the host's cloned voice.
 *
 * The voice (`ELEVENLABS_VOICE_ID`) is an Instant Voice Clone built from two minutes
 * of the host's *Google Flow avatar* audio, not from his real voice — so that the
 * HeyGen intro and the Flow story segments that follow it sound like one person.
 *
 * Note the API key in use lacks `user_read` and `voices_read`; only text-to-speech
 * is authorised. Do not add pre-flight quota or voice-lookup calls without widening
 * the key's permissions first, or every run will 401 before it speaks.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const API = 'https://api.elevenlabs.io/v1';

export interface SpeakOptions {
  outFile: string;
  /** Reuse an identical earlier render instead of spending credits again. */
  cache?: boolean;
}

/** Character-level alignment, written alongside the mp3 as `<out>.align.json`. */
export interface Alignment {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
}

/**
 * When, in seconds, `needle` is spoken within `text`.
 *
 * The top half of the intro cuts to a judge's portrait exactly as his name is
 * said, so this has to be measured rather than estimated — a photo landing half a
 * second late reads as a mistake.
 */
export function timeOf(align: Alignment, text: string, needle: string): { start: number; end: number } | null {
  const i = text.indexOf(needle);
  if (i < 0) return null;
  const n = align.characters.length;
  // The alignment is over the same string, so indices line up; clamp defensively
  // in case the model normalised something away.
  const a = Math.min(i, n - 1);
  const b = Math.min(i + needle.length - 1, n - 1);
  return {
    start: align.character_start_times_seconds[a],
    end: align.character_end_times_seconds[b],
  };
}

function settings() {
  return {
    stability: Number(process.env.ELEVENLABS_STABILITY ?? 0.5),
    similarity_boost: Number(process.env.ELEVENLABS_SIMILARITY ?? 0.8),
    style: Number(process.env.ELEVENLABS_STYLE ?? 0.3),
    use_speaker_boost: (process.env.ELEVENLABS_SPEAKER_BOOST ?? 'true') === 'true',
  };
}

export function alignPath(mp3: string): string {
  return mp3.replace(/\.mp3$/, '') + '.align.json';
}

export function readAlignment(mp3: string): Alignment | null {
  const p = alignPath(mp3);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
}

/** Speak `text`, writing an MP3 to `outFile`. Returns that path. */
export async function speak(text: string, opts: SpeakOptions): Promise<string> {
  const key = process.env.ELEVENLABS_API_KEY;
  const voice = process.env.ELEVENLABS_VOICE_ID;
  if (!key) throw new Error('ELEVENLABS_API_KEY missing from .env');
  if (!voice) throw new Error('ELEVENLABS_VOICE_ID missing from .env');

  const model = process.env.ELEVENLABS_MODEL || 'eleven_multilingual_v2';
  const body = {
    text,
    model_id: model,
    voice_settings: settings(),
  };

  // Cache on the exact request, so changing a word or a slider re-renders but an
  // unchanged re-run costs nothing.
  const stamp = path.join(
    path.dirname(opts.outFile),
    '.' + path.basename(opts.outFile) + '.hash',
  );
  const hash = crypto.createHash('sha1')
    .update(JSON.stringify({ voice, ...body })).digest('hex');
  if (opts.cache !== false && fs.existsSync(opts.outFile) && fs.existsSync(stamp)
      && fs.existsSync(alignPath(opts.outFile))
      && fs.readFileSync(stamp, 'utf8') === hash) {
    console.log(`[voice] cached ${path.basename(opts.outFile)}`);
    return opts.outFile;
  }

  // 192 kbps is gated to Creator tier and above; this account is below it and gets a
  // 403 output_format_not_allowed. 128 is the safe default and is what the web app
  // hands out anyway — the difference is inaudible once the mix is composited.
  const fmt = process.env.ELEVENLABS_OUTPUT_FORMAT || 'mp3_44100_128';

  console.log(`[voice] speaking ${text.length} chars via ${model} (${fmt})`);
  // `with-timestamps` returns base64 audio *plus* character alignment in one call,
  // for the same credit cost as plain TTS. The alignment is what lets the top half
  // of the intro cut on the spoken name.
  const res = await fetch(`${API}/text-to-speech/${voice}/with-timestamps?output_format=${fmt}`, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const out = await res.json() as any;
  fs.mkdirSync(path.dirname(opts.outFile), { recursive: true });
  fs.writeFileSync(opts.outFile, Buffer.from(out.audio_base64, 'base64'));
  fs.writeFileSync(alignPath(opts.outFile), JSON.stringify(out.alignment));
  fs.writeFileSync(stamp, hash);
  const kb = (fs.statSync(opts.outFile).size / 1024).toFixed(0);
  console.log(`[voice] wrote ${path.basename(opts.outFile)} (${kb} KB)`);
  return opts.outFile;
}
