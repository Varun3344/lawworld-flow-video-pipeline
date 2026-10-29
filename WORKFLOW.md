# LawWorld Shorts — Project Workflow

Judgment PDF in → finished 9:16 reel out. This is the complete pipeline: what runs,
in what order, what it costs, and the traps that have already bitten us.

---

## 1. The one command

```bash
npx tsx src/makeReel.ts judgments/<file>.pdf
```

Eight stages, each resumable. Every stage skips itself if its output already exists, so
re-running after a failure costs nothing for the work already done.

| # | Stage | Does | Needs |
|---|-------|------|-------|
| 1 | `extract` | PDF → `JudgmentFacts` (court, bench, provisions, holding, story beats) | OpenAI |
| 2 | `write` | facts → story + B-roll storyboards | OpenAI |
| 3 | `validate` | every dialogue fills its 10s clip | — |
| 4 | `broll` | Flow: 10 narrative story clips | Flow (~25 min) |
| 5 | `story` | Flow: 8 presenter clips with verified voice | Flow (~20 min) |
| 6 | `review` | contact sheets → **STOPS for your eyes** | — |
| 7 | `intro` | ElevenLabs voice → HeyGen avatar | ElevenLabs + HeyGen |
| 8 | `compose` | stack halves, append outro, write reel | — |

Flags: `--yes` skips the review stop, `--from N` resumes at a stage.

**Total ~50 minutes**, almost all of it Flow generating unattended.

---

## 2. What the finished reel looks like

A 1080×1920 frame split **exactly in half** (boundary at y=960). No divider line.

```
┌─────────────────────────┐
│   UPPER — what is being │   intro:  chambers → court photo → judge → judge → land records
│   talked about          │   story:  one Flow story clip per beat
│                         │   outro:  LawWorld end card
├─────────────────────────┤  ← y=960, exactly 50%
│   LOWER — the presenter │   intro:  HeyGen avatar + cloned ElevenLabs voice
│   on Flow studio grey   │   story:  Flow @me avatar + its own verified voice
└─────────────────────────┘   outro:  Flow avatar (from the reusable library)
```

### Division of labour — fixed, do not "improve" it

| Part | Picture | Sound | Why |
|------|---------|-------|-----|
| **Intro** ~18s | HeyGen | ElevenLabs clone | The only place judges are **named**. Flow refuses named judges outright. |
| **Story** ~80s | Flow @me avatar | Flow verified voice | Better looking than HeyGen's still-animation, and free of HeyGen cost. |
| **Outro** ~10s | Flow (reusable) | Flow verified voice | The advert never changes, so it is generated once and reused forever. |

An earlier build rendered all 90s through HeyGen for voice continuity. That was rejected
— the brief is **intro only** — and it burned $4.70 of a $13.50 API balance for nothing.

---

## 3. Accounts and cost

| Service | Used for | Cost per reel | Notes |
|---------|----------|---------------|-------|
| **OpenAI** | stages 1–2 | < $0.01 | `gpt-4o-mini` |
| **ElevenLabs** | intro voice | included in plan | `mp3_44100_128` — 192k is Creator-tier only |
| **HeyGen** | intro only | **~$0.65** | **API balance is separate from Studio credits** |
| **Google Flow** | all clips | plan credits | 720p ceiling even on AI Ultra |

> **HeyGen's two pots do not mix.** The Creator plan's monthly credits work only in the
> web Studio. The API draws on a prepaid balance topped up at
> `app.heygen.com/developers/api → Add balance`. Studio credits showing "595 remaining"
> while the API returns `MOVIO_PAYMENT_INSUFFICIENT_CREDIT` is expected, not a bug.

Keys live in `.env` (chmod 600, gitignored): `OPENAI_API_KEY`, `ELEVENLABS_API_KEY`,
`ELEVENLABS_VOICE_ID`, `HEYGEN_API_KEY`, `HEYGEN_SOURCE_IMAGE`.

---

## 4. The two mandatory gates

Both exist because a defect reached a delivered cut.

### Before generating — `checkFill.ts`

```bash
npx tsx src/checkFill.ts storyboard_story_<name>.json
```

The @me avatar speaks at **3.1 words/sec**, so a 10s clip needs **~31 words**. Writing 25
leaves ~2s of dead air *and* makes the avatar **repeat phrases** to pad the duration.
One reel shipped with 12.4s of dead air this way.

`maxWordsPerClip: 33` in the storyboard is a **ceiling, not a target**. Exits non-zero so
it can gate the pipeline.

### After generating — `reviewClips.ts`

```bash
npx tsx src/reviewClips.ts downloads/<project>/broll_realistic downloads/<project>
```

Writes `shorts_out/review/review_*.png`: **six frames spanning each clip**, one row per
clip. A single thumbnail cannot show reversed motion. Look for:

- a subject moving the opposite way to the prompt, or appearing to moonwalk
- readable text or signage that crept past the negative prompts
- deforming limbs or faces between frames
- a shot that barely changes across its length

**Realistic hit rate: 3 bad clips in 10.** On its first run it caught two defects nobody
had noticed, on top of the one the user spotted.

To regenerate one clip:

```bash
mv downloads/<proj>/broll_realistic/<scene>_broll.mp4 /tmp/
npx tsx src/index.ts --config <storyboard> --broll --scene <id> --no-merge
```

> `--scene` **alone will not regenerate an existing clip.** The downloader skips any
> scene already on disk and reports "Done: 0 clip(s)" without saying why. Move the file
> aside first.

---

## 5. Hard-won rules

### Google Flow refuses three things

1. **Named judges** — "Justice Nagaprasanna disagreed" → *"policies about generating
   prominent people"*. Write "The High Court disagreed". This is the entire reason
   HeyGen renders the intro.
2. **A party admitting fault** — "the State admitted" is blocked. Write what the Court
   *held*. "Crucially, that notification was missing" passed where the admission framing
   did not.
3. **News framing of any kind** — "I bring you clear and accurate updates on the
   judgements" was refused, and so was a clip whose *delivery* said "neutral newsreader
   tone". No judge or government named in either.

A refusal costs **no credit** and shows as a red Failed tile. To the watchdog it looks
identical to a slow render, so read `logs/policy_error_*.png` before assuming a timeout.

### Never prompt a walk toward or away from camera

Directional gait is the least reliable thing Flow renders. "The advocate climbs the
steps" came back as him descending toward the lens while the camera retreated — legs
reading as moonwalking. **Keep the subject still and move the camera instead.** The
reshoot was a better shot than the original brief.

### B-roll must re-enact, not illustrate

Generic imagery (empty fields, a register, a corridor) was rejected against the delivered
Kerala cut, which *dramatises* its story. Each clip gets a specific staged moment: two
families arguing across a boundary bund, a record keeper's finger on one line, a boundary
stake driven in at dusk while the true owner watches. Read `storyboard.json` — the Kerala
storyboard — before writing B-roll for a new case. It is the house style.

### Never pair a name with an unverified face

An early matcher fell back to surname, so "Gnanesh Kumar" resolved to **Aravind Kumar's
photograph**, captioned with the wrong name. `judgeImage()` now requires an exact match or
every meaningful word present in exactly one candidate; anything ambiguous returns null
and a **name-only card** is drawn. On a legal channel this is the worst failure available.

The same principle applies to court photographs: a plain typographic card beats a wrong
or AI-invented courthouse.

---

## 6. Geometry (measured, not guessed)

| Constant | Value | Source |
|----------|-------|--------|
| Frame | 1080×1920 @ 25fps | — |
| Split | y=960, exactly 50% | measured off `Kerala_Sudden_Fight_REALISTIC_Final.mp4` (row 640 of 1280) |
| Studio grey | `#808382` | sampled from Flow clips, nudged to match the reference's 129.7 luminance |
| **Story presenter** | `crop=720:640:0:180` then scale to 1080×960 | `compose.ts:311` — a **straight crop, no scale-to-fill** |
| **Intro presenter** | `zoom 0.97, crop_y 197` | tuned so HeyGen matches the Flow story (head 87px vs 86px) |

> **The story geometry is the reference; the intro bends to match it.** Writing
> `scale=1080:960:force_original_aspect_ratio=increase` on the story presenter scales a
> *portrait* source to cover a *landscape* box (1080×1923) and crops a band from the
> middle — a giant head with the chin cut off.

Flow burns a watermark bottom-right. The presenter window (y=180–820) never reaches it, so
no watermark crop is needed there. B-roll still needs `crop=iw*0.888`.

---

## 7. Assets

| Asset | Where | Notes |
|-------|-------|-------|
| Avatar source still | `assets/avatar_source.png` | Generated in Flow via `storyboard_avatar_source.json`, chosen with `pickAvatarFrame.ts`. HeyGen animates **this image** (`type: "image"`), not a stored avatar. |
| Logo lockup | `assets/lawworld_logo.png` | Pulled from `lawworld.ai/logo.png`. **Serif** wordmark — do not set it in Arial Black. Only 396×126; no larger asset exists. |
| Logo mark | `assets/lawworld_icon.png` | 192×192 RGBA |
| Outro library | `assets/outro_library/` | 4 advert variants, generated once, rotated across videos |
| SC judges | `~/Desktop/judge-iamge-courts/judge_images_official/` | 34, incl. the Chief Justice |
| Karnataka judges | `~/Desktop/judge-iamge-courts/judge_images_karnataka/` | 19 (administrative judges only — incomplete) |
| Courts | `~/Desktop/judge-iamge-courts/court_images_real/` | Supreme Court + Karnataka, client-supplied |

### Brand palette — from lawworld.ai's own stylesheet

| Token | Hex |
|-------|-----|
| `--color-brand` | `#d97757` terracotta |
| `--color-accent-deep` | `#b3573f` |
| `--color-brand-soft` | `#f0b79e` |
| `--color-ink` | `#2a2722` |
| logo background | `#f5f0e8` (**not** the page's `#f0eee6`) |

The gold `#F0B429` elsewhere in the reels is a **placeholder, not a brand colour**.

---

## 8. Environment traps (macOS 13, Intel)

- `npm install` needs `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` — Playwright refuses to install
  chromium on mac13. `browser.ts` uses the real Chrome.
- ffmpeg is a static build (ffmpeg 9) at `/usr/local/bin`; it removed
  `-filter_complex_script`. `timeout` is not installed.
- **One browser at a time.** Concurrent Playwright instances corrupt `user_data`.
  Clear `user_data/Singleton*` between runs. Flow stages are strictly sequential.
- **zsh does not word-split unquoted `$var`** — `ffmpeg $ins ...` passes the whole string
  as one argument. Use an array. A failing glob in `rm -f` also aborts the whole `&&` chain.
- ffmpeg's `tile` filter silently drops frames; build contact sheets with `hstack`/`vstack`.
- `drawtext`'s `tw` is the width of the *current* text, not the previous one.
- `pdf-parse` v2 is a class: `new PDFParse({data}).getText()`, not the v1 callable.
- VP9 alpha: `ffprobe` reports `pix_fmt=yuv420p` even when alpha is present. Decode a
  frame to check, and pass `-c:v libvpx-vp9` or ffmpeg picks a decoder that drops it.

---

## 9. Per-judgment checklist

1. Drop the PDF in `judgments/`
2. `npx tsx src/makeReel.ts judgments/<file>.pdf`
3. At the review stop, open `shorts_out/review/review_*.png`
4. Regenerate any bad clip (move it aside first), then `--from 7`
5. Output lands at `shorts_out/<stem>_reel.mp4`

**Before publishing:** credit CC BY-SA images from `court_images_real/ATTRIBUTION.md`, and
check that no judge is named anywhere except the intro.

---

## 10. Open items

- **HeyGen API balance** — stage 7 cannot run until topped up
- **Social handles** — the outro card says "Follow LawWorld on all our channels"
- **Brand colour** — outro uses the real terracotta; the rest of the reel is still the gold placeholder
- **Court coverage** — only Supreme Court and Karnataka; every other court falls back to a name card
- **High Court judges** — Karnataka set covers administrative judges only
- **Client court images crop to ~56% width** — they are 2:1, the box is 1.125:1; re-render nearer 1600×1400
