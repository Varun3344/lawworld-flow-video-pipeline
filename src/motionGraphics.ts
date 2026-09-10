/**
 * 3D-style UI motion cards, rendered locally at true 1080p.
 *
 * These carry the parts of a judgment that footage cannot show — a chain of authorities, one statute
 * diverting into another, a verdict landing. Rendering them here rather than generating them means they are
 * genuinely sharp (no model upscale), cost nothing, and can be re-cut in seconds.
 *
 * Each panel is drawn flat, given a perspective tilt, then flown in on its own beat over a drifting grid,
 * which is what sells the depth.
 *
 *   npx tsx src/motionGraphics.ts --out <dir>
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const args = process.argv.slice(2);
const oi = args.indexOf('--out');
const OUT = path.resolve(process.cwd(), oi >= 0 && args[oi + 1] ? args[oi + 1] : './downloads/motion');
const TMP = path.join(OUT, '.parts');
fs.mkdirSync(TMP, { recursive: true });

const W = 1920, H = 1080, FPS = 24;
const INK = '0xF4F6FA', AMBER = '0xFFC13B', MUTED = '0x7E879B', PANEL = '0x141A26', EDGE = '0x263143';
const BLACK_F = '/System/Library/Fonts/Supplemental/Arial Black.ttf';
const BOLD_F = '/System/Library/Fonts/Supplemental/Arial Bold.ttf';

const sh = (cmd: string) => {
  try { execSync(cmd, { stdio: 'pipe' }); } catch (e) {
    console.error('ffmpeg failed:', (e as Error).message.split('\n').slice(-4).join(' | ')); process.exit(1);
  }
};
const esc = (t: string) => t.replace(/\\/g, '').replace(/:/g, '\\:').replace(/'/g, '').replace(/,/g, '\\,');

/** Backdrop: near-black with a faint grid and a warm pool of light behind the panels. */
function backdrop(): string {
  const f = path.join(TMP, 'grid.png');
  if (!fs.existsSync(f))
    sh(`ffmpeg -v error -y -f lavfi -i color=0x080A11:s=${W + 160}x${H + 160} -vf `
      + `"drawgrid=w=96:h=96:t=1:c=0x1B2434@0.55,format=rgba,`
      + `geq=r='r(X,Y)+26*exp(-((X-700)^2+(Y-560)^2)/1100000)':g='g(X,Y)+18*exp(-((X-700)^2+(Y-560)^2)/1100000)'`
      + `:b='b(X,Y)+6*exp(-((X-700)^2+(Y-560)^2)/1100000)':a='255',noise=alls=6:allf=t" -frames:v 1 "${f}"`);
  return f;
}

/** Soft amber dot that rides down the connector line. */
function pulseSprite(): string {
  const f = path.join(TMP, 'pulse.png'), d = 46;
  if (!fs.existsSync(f))
    sh(`ffmpeg -v error -y -f lavfi -i color=black@0:s=${d}x${d} -vf "format=rgba,`
      + `geq=r='255':g='193':b='59':a='255*exp(-(pow(X-${d / 2},2)+pow(Y-${d / 2},2))/90)'" -frames:v 1 "${f}"`);
  return f;
}

/** Wide, very soft diagonal sheen that travels across the card on a loop. */
function sweepSprite(): string {
  const f = path.join(TMP, 'sweep.png'), w = 700;
  if (!fs.existsSync(f))
    sh(`ffmpeg -v error -y -f lavfi -i color=black@0:s=${w}x${H} -vf "format=rgba,`
      + `geq=r='255':g='255':b='255':a='34*exp(-pow((X-${w / 2}-0.30*(Y-${H / 2})),2)/16000)'" -frames:v 1 "${f}"`);
  return f;
}

/**
 * One panel sprite. The first version alternated a strong perspective lean per panel, which sheared the
 * glyphs into a fake italic and read as a glitch. Depth now comes from a soft drop shadow plus a single
 * shallow tilt shared by every panel, so the whole card sits on one plane and the text stays crisp.
 * A large ghost numeral to the right fills the frame, which was otherwise dead space.
 */
function panel(id: string, boxW: number, h: number, label: string, sub: string, accent: boolean, index: number): string {
  const flat = path.join(TMP, `${id}_flat.png`), out = path.join(TMP, `${id}.png`);
  const w = boxW + 440;                       // room for the numeral beside the box
  const bar = accent ? AMBER : EDGE;
  const num = String(index + 1).padStart(2, '0');
  sh(`ffmpeg -v error -y -f lavfi -i color=black@0:s=${w}x${h} -vf "format=rgba,`
    + `drawbox=x=0:y=0:w=${boxW}:h=${h}:color=${PANEL}@0.97:t=fill,`
    + `drawbox=x=0:y=0:w=${boxW}:h=${h}:color=${EDGE}@0.95:t=2,`
    + `drawbox=x=0:y=0:w=8:h=${h}:color=${bar}:t=fill,`
    + `drawtext=fontfile='${BLACK_F}':text='${esc(label)}':fontsize=${h > 150 ? 60 : 48}`
    + `:fontcolor=${accent ? AMBER : INK}:x=48:y=${sub ? h / 2 - 50 : (h - 54) / 2}`
    + (sub ? `,drawtext=fontfile='${BOLD_F}':text='${esc(sub)}':fontsize=29:fontcolor=${MUTED}:x=50:y=${h / 2 + 16}` : '')
    + `,drawtext=fontfile='${BLACK_F}':text='${num}':fontsize=${Math.round(h * 0.86)}`
    + `:fontcolor=${accent ? AMBER : EDGE}@0.30:x=${boxW + 90}:y=${Math.round(h * 0.04)}`
    + `" -frames:v 1 "${flat}"`);
  // One shallow tilt for every panel (2%), just enough to feel dimensional without shearing the text.
  const dx = Math.round(w * 0.02), dy = Math.round(h * 0.03);
  sh(`ffmpeg -v error -y -i "${flat}" -vf "format=rgba,`
    + `perspective=x0=0:y0=${dy}:x1=${w}:y1=0:x2=${dx}:y2=${h - dy}:x3=${w}:y3=${h}:sense=destination" `
    + `-frames:v 1 "${out}"`);
  return out;
}

/** Fly-in: slides from `from` to `to` and fades up over 0.45s, easing out. */
function flyIn(idx: number, base: string, x: number, y: number, at: number, from: number): { g: string; label: string } {
  const p = `clip((t-${at})/0.45,0,1)`;
  const e = `(1-pow(1-${p},3))`;                       // ease-out cubic
  const sx = `'${x}+${from}*(1-${e})'`, sy = `'${y}+${Math.round(from * 0.18)}*(1-${e})'`;
  const lbl = `l${idx}`;
  return {
    g: `[${idx}:v]format=rgba,split=2[sh${idx}][pn${idx}];`
     + `[sh${idx}]colorchannelmixer=rr=0:gg=0:bb=0:aa=0.55,boxblur=18:2[shadow${idx}];`
     + `[${base}][shadow${idx}]overlay=x='${x}+18+${from}*(1-${e})':y='${y}+22+${Math.round(from * 0.18)}*(1-${e})'`
     + `:enable='gte(t,${at})':format=auto[sb${idx}];`
     + `[sb${idx}][pn${idx}]overlay=x=${sx}:y=${sy}:enable='gte(t,${at})':format=auto[${lbl}]`,
    label: lbl
  };
}

interface Card { id: string; seconds: number; title: string; panels: { label: string; sub: string; accent?: boolean }[]; }

function render(card: Card): string {
  const grid = backdrop(), pulse = pulseSprite(), sweep = sweepSprite();
  const out = path.join(OUT, `${card.id}.mp4`);
  const n = card.panels.length;
  const pw = 1090, ph = n > 3 ? 132 : 186, gap = n > 3 ? 30 : 46;
  const top = Math.round((H - (n * ph + (n - 1) * gap)) / 2) + 40;
  const step = ph + gap;
  const beat = 0.42, first = 0.35;                       // when each panel lands
  const lineX = 104, lineTop = top + 30;
  const lineMax = (n - 1) * step + ph / 2;               // stops at the last panel's middle
  const travel = `clip((t-${first})*${(lineMax / (beat * n)).toFixed(1)},0,${lineMax})`;

  const sprites = card.panels.map((p, i) =>
    panel(`${card.id}_${i}`, pw, ph, p.label, p.sub, p.accent === true, i));

  // 0 = grid, 1..n = panels, n+1 = pulse, n+2 = sweep
  let g = `[0:v]crop=${W}:${H}:'40+30*sin(t/6)':'40+22*cos(t/7)',setsar=1`
    + `,drawtext=fontfile='${BOLD_F}':text='${esc(card.title)}':fontsize=34:fontcolor=${AMBER}`
    + `:x=140:y=150:alpha='clip(t/0.5,0,1)'`
    // the spine draws itself downward, so the eye is led rather than shown a finished list
    + `,drawbox=x=${lineX}:y=${lineTop}:w=4:h='${travel}':color=${AMBER}@0.45:t=fill[bg];`;
  let base = 'bg';
  sprites.forEach((_, i) => {
    const f = flyIn(i + 1, base, 140, top + i * step, first + i * beat, -300);
    g += f.g + ';';
    base = f.label;
  });
  // pulse rides the spine while it grows, then fades out at the bottom
  g += `[${n + 1}:v]format=rgba[pl];[${base}][pl]overlay=x=${lineX - 21}:y='${lineTop}+${travel}-23'`
     + `:enable='between(t,${first},${(first + beat * n + 0.5).toFixed(2)})':format=auto[wp];`;
  // and a slow sheen keeps the frame alive once everything has landed
  g += `[${n + 2}:v]format=rgba[sw];[wp][sw]overlay=x='-700+mod(t*430,${W + 900})':y=0:format=auto,`
     + `format=yuv420p[v]`;

  const inputs = [`-loop 1 -i "${grid}"`, ...sprites.map(s => `-loop 1 -i "${s}"`),
                  `-loop 1 -i "${pulse}"`, `-loop 1 -i "${sweep}"`].join(' ');
  const gf = path.join(TMP, `${card.id}.filter`);
  fs.writeFileSync(gf, g);
  sh(`ffmpeg -y -v error ${inputs} -/filter_complex "${gf}" -map "[v]" -t ${card.seconds} -r ${FPS} `
    + `-c:v libx264 -preset medium -crf 17 -pix_fmt yuv420p "${out}"`);
  console.log(`[Motion] ${card.id}: ${card.seconds}s, ${n} panels + spine, pulse, sheen -> ${path.relative(process.cwd(), out)}`);
  return out;
}

const CARDS: Card[] = [
  { id: 'mg_chain', seconds: 6, title: 'WHERE HE WENT FIRST',
    panels: [
      { label: 'THE POLICE', sub: 'No action' },
      { label: 'THE LOKAYUKTA', sub: 'No action' },
      { label: 'THE GOVERNOR', sub: 'No action' },
      { label: 'THE MAGISTRATE', sub: 'Private complaint filed', accent: true }] },
  { id: 'mg_sections', seconds: 5, title: 'WHAT THE TRIAL COURT DID',
    panels: [
      { label: 'SECTION 175', sub: 'Investigation ordered' },
      { label: 'SECTION 223', sub: 'Diverted to enquiry instead', accent: true }] },
  { id: 'mg_verdict', seconds: 5, title: 'THE HIGH COURT HELD',
    panels: [
      { label: 'A CURABLE DEFECT', sub: 'The complaint survives', accent: true },
      { label: 'NOT A FATAL ONE', sub: 'It cannot end the case' }] },
];

fs.mkdirSync(OUT, { recursive: true });
for (const c of CARDS) render(c);
console.log(`[Motion] Done — ${CARDS.length} cards in ${path.relative(process.cwd(), OUT)}`);
