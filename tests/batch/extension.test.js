import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, cp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright';

test('Moodle page button opens the extension panel with its quiz selected', async () => {
  const root = await mkdtemp(join(tmpdir(), 'moodle-batch-extension-'));
  const extension = join(root, 'extension');
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify({ origin: 'https://sdo.sibupk.su', userScope: '1', authRequired: false,
      running: false, overview: { courses: [], summary: {} }, jobs: [] }));
  });
  let context;
  try {
    await cp(resolve('batch-extension'), extension, { recursive: true });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address();
    await writeFile(join(extension, 'config.js'), `globalThis.batchConfig = ${JSON.stringify({
      endpoint: `http://127.0.0.1:${address.port}`, token: 'test', origin: 'https://sdo.sibupk.su', userScope: '1',
    })};\n`);
    context = await chromium.launchPersistentContext(join(root, 'profile'), { channel: 'chromium', headless: true,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const page = await context.newPage();
    await page.route('https://sdo.sibupk.su/**', route => route.fulfill({ contentType: 'text/html', body: '<main id="region-main"></main>' }));
    await page.goto('https://sdo.sibupk.su/mod/quiz/view.php?id=12345', { waitUntil: 'domcontentloaded' });
    const button = page.locator('#moodle-batch-open');
    await button.waitFor({ state: 'visible' });
    const opened = context.waitForEvent('page');
    await button.click();
    const panel = await opened;
    await panel.locator('#nav-tests').waitFor({ state: 'visible' });
    assert.match(worker.url(), /^chrome-extension:\/\//u);
    assert.equal(new URL(panel.url()).searchParams.get('quiz'), '12345');
  } finally {
    await context?.close();
    if (server.listening) await new Promise(done => server.close(done));
    await rm(root, { recursive: true, force: true });
  }
});
