/**
 * Long-wait login. Same job as login.ts, but it never needs a terminal prompt: it opens the browser,
 * polls for the Flow workspace for up to 20 minutes, then saves the session and closes.
 * Use this when the login is driven from a background/automated shell where stdin is not interactive.
 * Credentials are typed by the user into Google's own page; nothing is read, logged or stored here.
 */
import { BrowserManager } from './browser';
import { CONFIG } from './config';

const WAIT_MINUTES = 20;

async function run(): Promise<void> {
  const bm = new BrowserManager({ headless: false });
  let { page } = await bm.init();

  console.log(`[INFO] Opening Google Flow...`);
  await page.goto(CONFIG.FLOW_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(3000);

  const onFlow = async () => {
    try {
      return /flow\.google\.com/.test(page.url())
        && !(await page.$('input[type="email"], input[type="password"]'))
        && !!(await page.$('button:has-text("New project"), div[contenteditable="true"]'));
    } catch { return false; }
  };

  if (!(await onFlow())) {
    if (!/accounts\.google\.com/.test(page.url())) {
      await page.goto('https://accounts.google.com/signin/v2/identifier?continue='
        + encodeURIComponent(CONFIG.FLOW_URL) + '&flowName=GlifWebSignIn&flowEntry=ServiceLogin',
        { waitUntil: 'domcontentloaded' }).catch(() => {});
    }
    console.log(`[ACTION] Sign in to Google in the browser window. Waiting up to ${WAIT_MINUTES} minutes...`);
  }

  const deadline = Date.now() + WAIT_MINUTES * 60 * 1000;
  let ok = await onFlow();
  let ticks = 0;
  let closed = false;
  while (!ok && !closed && Date.now() < deadline) {
    try {
      // sign-in sometimes lands Flow in a second tab
      for (const p of bm.getContext().pages()) {
        if (p !== page && /flow\.google\.com/.test(p.url())) { page = p as typeof page; break; }
      }
      if (++ticks % 6 === 0) console.log(`[INFO] still waiting... (${Math.round((deadline - Date.now()) / 60000)} min left)`);
      await page.waitForTimeout(5000);
      ok = await onFlow();
    } catch (e) {
      // The window being shut is the common case here, and it used to kill the process with no message.
      const msg = (e as Error).message || '';
      if (/closed|Target page|context or browser/i.test(msg)) {
        closed = true;
        console.log('BROWSER WINDOW WAS CLOSED before sign-in finished. Leave it open next time.');
      } else {
        console.log(`[WARN] ${msg.split('\n')[0]}`);
        await new Promise(r => setTimeout(r, 3000));
      }
    }
  }

  if (ok) {
    console.log(`[INFO] Flow workspace reached. Saving session to ${CONFIG.USER_DATA_DIR}`);
    await bm.close();
    console.log(`SESSION SAVED SUCCESSFULLY`);
  } else {
    await bm.close();
    console.log(`LOGIN NOT COMPLETED — not signed in. Re-run when you are ready.`);
    process.exitCode = 1;
  }
}

run().catch(err => { console.error('[Error]', err.message); process.exitCode = 1; });
