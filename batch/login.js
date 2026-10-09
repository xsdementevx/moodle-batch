import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { connectExtension, closeExtensionTabs } from './extension.js';
import { cookieState, openMoodle } from './moodle.js';

async function main() {
  const { values } = parseArgs({ options: {
    credentials: { type: 'string', default: '.playwright-mcp/reference-auth/moodle-login.json' },
    auth: { type: 'string', default: '.playwright-mcp/reference-auth/cookies.json' },
    root: { type: 'string', default: '.playwright-mcp/batch' },
  } });
  const origin = 'https://sdo.sibupk.su';
  const authFile = resolve(values.auth), temporary = `${authFile}.${process.pid}.login`;
  let expected;
  try { expected = JSON.parse(await readFile(resolve(values.root, 'overview.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const browser = await connectExtension({
    profileDir: resolve(process.env.LOCALAPPDATA || '', 'Yandex/YandexBrowser/User Data'),
    executablePath: 'C:/Program Files/Yandex/YandexBrowser/Application/browser.exe',
  });
  let page, moodle;
  try {
    const context = browser.contexts()[0];
    if (!context) throw new Error('GPT_EXTENSION_CONTEXT_UNAVAILABLE');
    page = await context.newPage();
    await page.goto(`${origin}/login/index.php`, { waitUntil: 'domcontentloaded' });
    await closeExtensionTabs(browser);
    if (await page.locator('#username').count()) {
      const credentials = JSON.parse(await readFile(resolve(values.credentials), 'utf8'));
      if (credentials.url !== origin || typeof credentials.username !== 'string' || !credentials.username
          || typeof credentials.password !== 'string' || !credentials.password) throw new Error('LOGIN_FILE_INVALID');
      const action = await page.locator('#username').evaluate(input => input.form.action);
      if (new URL(page.url()).origin !== origin || new URL(action).origin !== origin) throw new Error('LOGIN_ORIGIN_MISMATCH');
      await page.locator('#username').fill(credentials.username);
      await page.locator('#password').fill(credentials.password);
      // One submission only: an uncertain result must never trigger another login.
      await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), page.locator('#loginbtn').click()]);
    }
    await page.goto(`${origin}/user/profile.php`, { waitUntil: 'domcontentloaded' });
    await writeFile(temporary, JSON.stringify(cookieState(await context.cookies(origin), origin)), { mode: 0o600 });
    moodle = await openMoodle({ authFile: temporary, origin });
    if (expected && (expected.origin !== origin || expected.userScope !== moodle.userScope)) throw new Error('USER_SCOPE_MISMATCH');
    await moodle.close(); moodle = null;
    await rename(temporary, authFile);
    console.log('Вход выполнен. Нажмите «Обновить анализ» в расширении.');
  } finally {
    await moodle?.close({ save: false });
    await page?.close();
    await closeExtensionTabs(browser);
    await browser.close();
    await rm(temporary, { force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    const code = /^[A-Z_0-9]+$/u.test(error.message) ? error.message : 'LOGIN_FAILED';
    console.error(`Moodle Batch: ${code}`); process.exitCode = 1;
  });
}
