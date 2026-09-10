import readline from 'readline';
import { BrowserManager } from './browser';
import { CONFIG } from './config';

/**
 * First-time login. If FLOW_EMAIL / FLOW_PASSWORD are set in the environment the form is filled
 * automatically; any Google challenge (2-step verification, "confirm it's you") must be completed
 * in the browser window. The session is saved to ./user_data when the Flow workspace appears.
 * Credentials are never logged or written to disk.
 */
async function runLogin(): Promise<void> {
  console.log(`======================================================`);
  console.log(` Google Flow AI Video - Login Utility`);
  console.log(`======================================================\n`);

  const email = process.env.FLOW_EMAIL || '';
  const password = process.env.FLOW_PASSWORD || '';

  const browserManager = new BrowserManager({ headless: false });
  let { page } = await browserManager.init();

  console.log(`[INFO] Navigating to Google Flow (${CONFIG.FLOW_URL})...`);
  await page.goto(CONFIG.FLOW_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);

  const onFlow = async () =>
    /flow\.google\.com/.test(page.url()) &&
    !!(await page.$('button:has-text("New project"), div[contenteditable="true"]'));

  const shot = async (name: string) => {
    try { await page.screenshot({ path: `${CONFIG.LOGS_DIR}/login_${name}.png` }); } catch { /* ignore */ }
  };

  if (!(await onFlow())) {
    await shot('1_landing');
    // Logged-out profiles land on flow.google.com/about (no sign-in link). Go straight to Google's sign-in,
    // asking it to continue to Flow afterwards.
    if (!/accounts\.google\.com/.test(page.url())) {
      console.log(`[INFO] Opening Google sign-in (continue -> Flow)...`);
      await page.goto('https://accounts.google.com/signin/v2/identifier?continue=' + encodeURIComponent(CONFIG.FLOW_URL) + '&flowName=GlifWebSignIn&flowEntry=ServiceLogin',
        { waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.waitForTimeout(4000);
      await shot('2_signin_page');
    }

    if (email && password) {
      console.log(`[INFO] Filling sign-in form for ${email}...`);
      try {
        // Google's identifier page: #identifierId is the visible box (a hidden input[type=email] may precede it)
        const emailBox = page.locator('input#identifierId, input[type="email"]:visible, input[name="identifier"]:visible').first();
        await emailBox.waitFor({ state: 'visible', timeout: 20000 });
        await emailBox.click();
        await emailBox.pressSequentially(email, { delay: 40 });
        await page.waitForTimeout(500);
        await shot('2b_email_typed');
        await page.keyboard.press('Enter');

        const pwBox = page.locator('input[type="password"]:visible, input[name="Passwd"]:visible').first();
        await pwBox.waitFor({ state: 'visible', timeout: 30000 });
        await page.waitForTimeout(1000);
        await pwBox.click();
        await pwBox.pressSequentially(password, { delay: 40 });
        await page.keyboard.press('Enter');
        console.log(`[INFO] Credentials submitted. If Google asks for verification, complete it in the browser window.`);
        await page.waitForTimeout(6000);
        await shot('3_after_password');
      } catch (err) {
        await shot('3_form_error');
        console.warn(`[WARN] Could not auto-fill the sign-in form (${(err as Error).message.split('\n')[0]}). Please sign in manually in the window.`);
      }
    } else {
      console.log(`[ACTION] Please sign into your Google account inside the browser window.`);
    }

    // Wait for the Flow workspace (user may be solving a challenge meanwhile)
    console.log(`[INFO] Waiting up to 4 minutes for the Flow workspace to appear...`);
    const deadline = Date.now() + 240000;
    let ok = false;
    let ticks = 0;
    while (Date.now() < deadline) {
      if (++ticks % 10 === 0) await shot(`4_waiting_${ticks}`);
      // If sign-in opened Flow in another tab, follow it
      for (const p of browserManager.getContext().pages()) {
        if (p !== page && /flow\.google\.com\/(project|$)/.test(p.url())) { page = p as typeof page; break; }
      }
      if (/flow\.google\.com/.test(page.url()) && !(await page.$('input[type="email"], input[type="password"]'))) {
        await page.waitForTimeout(3000);
        if (await onFlow()) { ok = true; break; }
        // On Flow but the home is still loading / a consent dialog is up: give it a moment
        await page.goto(CONFIG.FLOW_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
      }
      await page.waitForTimeout(3000);
    }
    if (!ok) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      await new Promise<void>(resolve => rl.question('[INFO] Not on the Flow workspace yet. Finish signing in, then press ENTER here... ', () => { rl.close(); resolve(); }));
    }
  }

  const who = await page.evaluate(() => {
    const el = document.querySelector('[aria-label*="Account" i], [aria-label*="Google Account" i]');
    return el ? (el.getAttribute('aria-label') || '') : '';
  }).catch(() => '');
  console.log(`\n[INFO] Flow workspace reached${who ? ` (${who})` : ''}. Saving session to: ${CONFIG.USER_DATA_DIR}`);
  await browserManager.close();

  console.log(`\n======================================================`);
  console.log(` Session Saved Successfully!`);
  console.log(`======================================================\n`);
}

runLogin().catch((err) => {
  console.error('[Error] Login process failed:', err.message);
  process.exit(1);
});
