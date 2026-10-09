import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);

export async function closeExtensionTabs(browser) {
  const statusPage = browser.contexts().flatMap(context => context.pages?.() || []).find(page => {
    const url = new URL(page.url());
    return url.protocol === 'chrome-extension:' && url.hostname === 'mmlmfjhmonkocbjadbfplnigmagldckm' && url.pathname === '/connect.html';
  });
  if (!statusPage) return;
  try {
    await statusPage.evaluate(async () => {
      const tabs = await chrome.tabs.query({ url: 'chrome-extension://mmlmfjhmonkocbjadbfplnigmagldckm/connect.html*' });
      const ids = tabs.filter(tab => {
        try { return JSON.parse(new URL(tab.url).searchParams.get('client'))?.name === 'Moodle Batch'; }
        catch { return false; }
      }).map(tab => tab.id);
      if (ids.length) await chrome.tabs.remove(ids);
    });
  } catch {
    // Closing the page running evaluate can interrupt its return after successful removal.
    if (!statusPage.isClosed()) console.error('GPT_EXTENSION_STATUS_CLEANUP_FAILED');
  }
}

export async function connectExtension({ executablePath, profileDir }) {
  // ponytail: reuse the installed Playwright relay; this internal API needs checking on upgrades.
  const { tools } = require('playwright-core/lib/coreBundle');
  if (typeof tools.createBrowserWithInfo !== 'function') throw new Error('GPT_EXTENSION_VERSION_UNSUPPORTED');
  const originalToken = process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN;
  if (!originalToken) {
    try {
      const token = (await readFile(new URL('../.playwright-mcp/reference-auth/playwright-extension-token.txt', import.meta.url), 'utf8')).trim();
      if (token) process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN = token;
    } catch (error) { if (error.code !== 'ENOENT') throw new Error('GPT_EXTENSION_TOKEN_READ_FAILED'); }
  }
  try {
    const { browser } = await tools.createBrowserWithInfo({
      extension: true,
      browser: { browserName: 'chromium', launchOptions: {}, userDataDir: profileDir },
    }, { cwd: process.cwd(), clientName: 'Moodle Batch' },
    { executablePath }, { title: 'Moodle Batch', workspaceDir: process.cwd() });
    return browser;
  } catch { throw new Error('GPT_EXTENSION_CONNECTION_FAILED'); }
  finally {
    if (originalToken === undefined) delete process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN;
    else process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN = originalToken;
  }
}
