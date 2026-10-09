import { parseArgs } from 'node:util';
import { randomBytes } from 'node:crypto';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openMoodle } from './moodle.js';
import { openAnswers } from './answers.js';
import { webSolver } from './web.js';
import { openService, serviceServer } from './service.js';
import { safeCode } from './overview.js';

async function main() {
  const { values } = parseArgs({ options: {
    auth: { type: 'string', default: '.playwright-mcp/reference-auth/cookies.json' },
    origin: { type: 'string', default: 'https://sdo.sibupk.su' },
    root: { type: 'string', default: '.playwright-mcp/batch' },
    port: { type: 'string', default: '49805' },
    'gpt-profile': { type: 'string', default: join(process.env.LOCALAPPDATA || '', 'Yandex/YandexBrowser/User Data') },
    'gpt-browser': { type: 'string', default: 'C:/Program Files/Yandex/YandexBrowser/Application/browser.exe' },
  } });
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('INVALID_PORT');
  const root = resolve(values.root); await mkdir(root, { recursive: true });
  let token;
  const tokenPath = join(root, 'service-token.txt');
  try { token = (await readFile(tokenPath, 'utf8')).trim(); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    token = randomBytes(32).toString('hex'); await writeFile(tokenPath, token, { mode: 0o600, flag: 'wx' });
  }
  if (!/^[a-f0-9]{64}$/u.test(token)) throw new Error('INVALID_SERVICE_TOKEN');
  let moodle, store, service, web, server;
  try {
    // Reserve the port before reading or changing durable jobs. A duplicate launch
    // must not mark the still-running service's jobs as interrupted.
    server = serviceServer({
      state: () => { if (!service) throw new Error('SERVICE_STARTING'); return service.state(); },
      start: input => service.start(input), stop: id => service.stop(id), refresh: () => service.refresh(),
    }, token, port);
    await new Promise((done, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', done); });
    moodle = await openMoodle({ authFile: resolve(values.auth), origin: values.origin });
    store = openAnswers(join(root, 'answers.sqlite'));
    web = webSolver({ extension: true, profileDir: resolve(values['gpt-profile']), executablePath: values['gpt-browser'] });
    service = await openService({ moodle, store, web, root });
    const extensionDir = join(root, 'extension');
    await cp(fileURLToPath(new URL('../batch-extension/', import.meta.url)), extensionDir, { recursive: true });
    await writeFile(join(extensionDir, 'config.js'), `globalThis.batchConfig = ${JSON.stringify({ endpoint: `http://127.0.0.1:${port}`, token, origin: moodle.origin, userScope: moodle.userScope })};\n`, { mode: 0o600 });
    console.log(`Moodle Batch готов. Рабочее расширение: ${extensionDir}`);
    console.log('Загрузите эту папку в браузере один раз. Сервис должен оставаться запущенным.');
    await new Promise(done => { process.once('SIGINT', done); process.once('SIGTERM', done); });
  } finally {
    if (server?.listening) await new Promise(done => server.close(done));
    await service?.close(); await web?.close(); store?.close(); await moodle?.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`Moodle Batch: ${safeCode(error)}`); process.exitCode = 1; });
}
