import { parseArgs } from 'node:util';
import { mkdir, writeFile, rename, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { openMoodle } from './moodle.js';
import { openAnswers } from './answers.js';
import { scanOverview, safeCode } from './overview.js';

export function overviewServer({ origin, userScope, state, refresh, userscript }) {
  return createServer((req, res) => {
    const json = (code, data) => {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': origin, 'Vary': 'Origin', 'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify(data));
    };
    if (!/^127\.0\.0\.1:\d+$/u.test(req.headers.host || '') || (req.headers.origin && req.headers.origin !== origin)) return json(403, { error: 'ORIGIN_MISMATCH' });
    if (req.method !== 'GET') return json(405, { error: 'GET_REQUIRED' });
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/grades.user.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(userscript);
    }
    if (url.pathname !== '/overview') return json(404, { error: 'NOT_FOUND' });
    if (url.searchParams.get('user') !== userScope) return json(403, { error: 'USER_SCOPE_MISMATCH' });
    const current = state();
    if (url.searchParams.get('refresh') === '1' || !current.running && (!current.overview
        || Date.now() - Date.parse(current.overview.completedAt) > 60000)) refresh();
    return json(200, state());
  });
}

async function main() {
  const { values } = parseArgs({ options: {
    auth: { type: 'string', default: '.playwright-mcp/reference-auth/cookies.json' },
    origin: { type: 'string', default: 'https://sdo.sibupk.su' },
    db: { type: 'string', default: '.playwright-mcp/batch/answers.sqlite' },
    report: { type: 'string', default: '.playwright-mcp/batch/overview.json' },
    concurrency: { type: 'string', default: '6' }, serve: { type: 'boolean' },
    port: { type: 'string', default: '49804' },
  } });
  const concurrency = Number(values.concurrency);
  const port = Number(values.port);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 12 || !Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('INVALID_OPTIONS');
  const moodle = await openMoodle({ authFile: resolve(values.auth), origin: values.origin });
  const store = openAnswers(resolve(values.db));
  let snapshot = null;
  let previous = null;
  let running = null;
  let error = null;
  let lastLogged = 0;
  const reportPath = resolve(values.report);
  try {
    const cached = JSON.parse(await readFile(reportPath, 'utf8'));
    if (cached.schemaVersion === 1 && cached.origin === moodle.origin && cached.userScope === moodle.userScope) snapshot = cached;
  } catch (failure) { if (failure.code !== 'ENOENT') console.error('OVERVIEW_CACHE_UNAVAILABLE'); }
  const state = () => {
    if (!previous || !running || !snapshot) return { running: Boolean(running), error, overview: snapshot };
    return { running: true, error, overview: { ...snapshot, courses: snapshot.courses.map(course => {
      const cached = previous.courses.find(old => old.courseId === course.courseId);
      return course.status === 'loading' && cached ? { ...cached, cached: true } : course;
    }) } };
  };
  const refresh = () => {
    if (running) return running;
    error = null;
    if (snapshot?.phase === 'complete') previous = snapshot;
    running = scanOverview(moodle, store, { concurrency, onProgress: progress => {
      snapshot = progress;
      if (Date.now() - lastLogged > 15000 || progress.phase === 'complete') {
        lastLogged = Date.now();
        console.log(`Курсы: ${progress.progress.courses}/${progress.progress.totalCourses}; тесты: ${progress.progress.tests}/${progress.progress.totalTests}.`);
      }
    } }).then(async result => {
      await mkdir(dirname(reportPath), { recursive: true });
      const temp = `${reportPath}.tmp`;
      await writeFile(temp, JSON.stringify(result, null, 2), { mode: 0o600 });
      await rename(temp, reportPath);
      console.log(`Анализ завершён за ${(result.elapsedMs / 1000).toFixed(1)} с. Тестов: ${result.summary.total}; ниже 90%: ${result.summary.retry}; ошибок проверки: ${result.summary.errors}.`);
    }).catch(failure => { error = safeCode(failure); process.exitCode = 1; console.error(`Анализ: ${error}`); })
      .finally(() => { running = null; });
    return running;
  };
  let server;
  try {
    if (values.serve) {
      const userscript = (await readFile(new URL('./grades.user.js', import.meta.url), 'utf8'))
        .replace('http://127.0.0.1:49804/overview', `http://127.0.0.1:${port}/overview`);
      server = overviewServer({ origin: moodle.origin, userScope: moodle.userScope, state, refresh, userscript });
      await new Promise((done, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', done); });
      console.log(`Сводка для страницы оценок: http://127.0.0.1:${port}/grades.user.js`);
    }
    await refresh();
    if (server) {
      await new Promise(done => {
        const stop = () => server.close(done);
        process.once('SIGINT', stop); process.once('SIGTERM', stop);
      });
      await running;
    }
  } finally { if (server?.listening) await new Promise(done => server.close(done)); store.close(); await moodle.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`Ошибка: ${safeCode(error)}`); process.exitCode = 1; });
}
