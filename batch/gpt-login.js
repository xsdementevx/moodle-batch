import { parseArgs } from 'node:util';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { chromium } from 'playwright';
import { cookieState } from './moodle.js';
import { readyWeb } from './web.js';
import { connectExtension, closeExtensionTabs } from './extension.js';

const { values } = parseArgs({ options: {
  auth: { type: 'string', default: '.playwright-mcp/reference-auth/cookies_gpt.json' },
  profile: { type: 'string', default: '.playwright-mcp/batch/gpt-profile' },
  'executable-path': { type: 'string' },
  extension: { type: 'boolean' },
} });
await mkdir(resolve(values.profile), { recursive: true });
let context;
let attachedBrowser;
let ownPage;
const input = createInterface({ input: process.stdin, output: process.stdout });
try {
  if (values.extension) {
    console.log('В окне расширения разрешите подключение Moodle Batch и выберите вкладку ChatGPT.');
    attachedBrowser = await connectExtension({ executablePath: values['executable-path'], profileDir: resolve(values.profile) });
    context = attachedBrowser.contexts()[0];
    if (!context) throw new Error('GPT_EXTENSION_CONTEXT_UNAVAILABLE');
  } else {
    context = await chromium.launchPersistentContext(resolve(values.profile), {
      headless: false, executablePath: values['executable-path'],
    });
  }
  try {
    if (!values.extension && !(await context.cookies('https://chatgpt.com')).length) {
      await context.addCookies(cookieState(JSON.parse(await readFile(values.auth, 'utf8')), 'https://chatgpt.com').cookies);
    }
  }
  catch { console.log('Сохранённых cookies нет. Можно войти в открывшемся браузере.'); }
  const page = values.extension
    ? context.pages().find(p => p.url().startsWith('https://chatgpt.com/')) || (ownPage = await context.newPage())
    : context.pages()[0] || await context.newPage();
  if (!values.extension || ownPage) await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded' });
  if (values.extension) {
    await readyWeb(page);
    console.log('GPT_EXTENSION_READY: подключена вкладка ChatGPT в вашем обычном браузере.');
  } else {
    while (true) {
      const reply = await input.question('Когда появится поле сообщения ChatGPT, нажмите Enter здесь. Для выхода: q. ');
      if (reply.trim().toLowerCase() === 'q') { process.exitCode = 1; break; }
      try { await readyWeb(page); break; }
      catch (error) {
        if (!['GPT_WEB_CHALLENGE', 'GPT_WEB_LOGIN_OR_UI_UNAVAILABLE'].includes(error.message)) throw error;
        console.log(`Поле сообщения пока недоступно: ${error.message}. Окно остаётся открытым.`);
      }
    }
  }
  if (process.exitCode) {
    console.log('Подготовка сессии остановлена без подтверждения входа.');
  } else if (!values.extension) {
    await context.storageState({ path: resolve('.playwright-mcp/batch/gpt-state.json') });
    console.log('Авторизация сохранена в отдельном локальном профиле. Можно запускать batch с --solve --gpt-visible и теми же --gpt-profile/--gpt-browser.');
  }
} catch (error) {
  const code = /^[A-Z][A-Z_0-9]+$/u.test(error.message || '') ? error.message : 'LOCAL_OR_NETWORK_ERROR';
  console.error(`Авторизация ещё не подтверждена: ${code}`); process.exitCode = 1;
}
finally {
  input.close();
  await ownPage?.close();
  if (attachedBrowser) {
    await closeExtensionTabs(attachedBrowser);
    await attachedBrowser.close();
  }
  else await context?.close();
}
