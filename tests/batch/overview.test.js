import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { chromium } from 'playwright';
import { mapConcurrent, scanOverview } from '../../batch/overview.js';
import { openParser } from '../../batch/moodle.js';
import { overviewServer } from '../../batch/overview-cli.js';

test('overview bounds global parallelism, keeps course order and isolates failed tests from unattempted ones', async () => {
  let active = 0; let maximum = 0; let imports = 0;
  const wait = async value => {
    active++; maximum = Math.max(maximum, active);
    await new Promise(done => setTimeout(done, 5)); active--; return value;
  };
  const moodle = { origin: 'https://moodle.example', userScope: '42',
    courses: async () => [{ courseId: '10', title: 'First' }, { courseId: '11', title: 'Second' }],
    grades: id => wait([{ quizId: id === '10' ? '20' : '30', title: 'Test', percent: id === '10' ? 80 : null }]),
    quizzes: scope => wait([{ quizId: scope.courseId === '10' ? '20' : '30', title: 'Test', topic: 'Topic' },
      { quizId: scope.courseId === '10' ? '21' : '31', title: 'Other', topic: 'Topic' }]),
    read: async href => {
      const id = new URL(href).searchParams.get('id');
      if (id === '31') throw new Error('HTTP_403');
      return wait({ quizId: id, courseId: Number(id) < 30 ? '10' : '11', userScope: '42',
        activeUrl: id === '20' ? 'active' : null, startForm: {}, attemptSummaries: id === '20' ? [{}] : [], reviews: id === '20' ? ['https://moodle.example/review'] : [] });
    },
    collect: () => wait({ kind: 'review', quizId: '20', courseId: '10', userScope: '42', attemptId: '100', questions: [{}] }),
  };
  const store = { importReview: () => imports++, lookup: () => ({ status: 'known', excludedAnswers: [] }) };
  const snapshot = await scanOverview(moodle, store, { concurrency: 2 });
  assert.equal(maximum, 2);
  assert.deepEqual(snapshot.courses.map(c => c.courseId), ['10', '11']);
  assert.equal(snapshot.summary.total, 4);
  assert.equal(snapshot.summary.retry, 1);
  assert.equal(snapshot.summary.unattempted, 2);
  assert.equal(snapshot.summary.unknown, 1);
  assert.equal(snapshot.summary.errors, 1);
  assert.equal(snapshot.status, 'partial');
  assert.equal(snapshot.courses[0].quizzes[0].analysis.known, 1);
  assert.equal(imports, 1);
  await assert.rejects(mapConcurrent([], 0, () => {}), /INVALID_CONCURRENCY/);
});

test('offline parser serializes simultaneous documents and scopes grade reports to the account', async () => {
  const parser = await openParser();
  try {
    const reports = Array.from({ length: 8 }, (_, i) => ({ id: String(20 + i), html: `<body id="page-mod-quiz-view" data-course-id="10" data-quiz-id="${20 + i}" data-user-scope="42"></body>` }));
    const results = await Promise.all(reports.map(r => parser.parse(r.html, `https://moodle.example/mod/quiz/view.php?id=${r.id}`, '42')));
    assert.deepEqual(results.map(r => r.quizId), reports.map(r => r.id));
    const overview = '<body id="page-grade-report-overview-index"><table><tr><td><a href="/course/user.php?mode=grade&id=10&user=42">Course</a></td></tr></table></body>';
    assert.deepEqual(await parser.grades(overview, 'https://moodle.example', '42'), [{ courseId: '10', title: 'Course' }]);
    await assert.rejects(parser.grades(overview, 'https://moodle.example', '99'), /PAGE_SCOPE_MISMATCH/);
    const grades = '<body id="page-grade-report-user-index" class="course-10"><table><tr><td><a href="/mod/quiz/grade.php?id=20">Test</a></td><td class="column-percentage">95,50 %</td></tr></table></body>';
    assert.equal((await parser.grades(grades, 'https://moodle.example', '42', '10'))[0].percent, 95.5);
  } finally { await parser.close(); }
});

test('loopback bridge enforces host, origin and account and exposes only reads', async () => {
  let refreshes = 0;
  const server = overviewServer({ origin: 'https://moodle.example', userScope: '42',
    state: () => ({ running: true, overview: null }), refresh: () => refreshes++, userscript: 'fixture' });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${server.address().port}/overview?user=42`;
  try {
    assert.equal((await fetch(url)).status, 200);
    assert.equal((await fetch(url.replace('user=42', 'user=99'))).status, 403);
    assert.equal((await fetch(url, { headers: { Origin: 'https://other.example' } })).status, 403);
    const hostileHost = await new Promise((done, reject) => {
      const req = httpRequest(url, { headers: { Host: 'other.example' } }, res => { res.resume(); done(res.statusCode); });
      req.on('error', reject); req.end();
    });
    assert.equal(hostileHost, 403);
    assert.equal((await fetch(url, { method: 'POST' })).status, 405);
    assert.equal((await fetch(`${url}&refresh=1`)).status, 200);
    assert.equal(refreshes, 1);
  } finally { await new Promise(done => server.close(done)); }
});

test('grade-page userscript renders course details as text and supports refreshing the analysis', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route('https://sdo.sibupk.su/**', route => route.fulfill({ contentType: 'text/html', body: '<body><table><tbody><tr><td><a href="/course/user.php?mode=grade&id=10&user=42">Course</a></td><td>8/10</td></tr></tbody></table></body>' }));
    await page.goto('https://sdo.sibupk.su/grade/report/overview/index.php');
    await page.evaluate(() => {
      window.requests = 0;
      window.GM_getValue = () => window.cachedOverview || null;
      window.GM_setValue = (_, value) => { window.cachedOverview = value; };
      window.GM_xmlhttpRequest = request => {
        window.requests++;
        if (window.holdRequest) return;
        request.onload({ status: 200, responseText: JSON.stringify({ running: false, error: null, overview: {
          schemaVersion: 1, origin: location.origin, userScope: '42', phase: 'complete', completedAt: new Date().toISOString(),
          progress: { totalCourses: 1, totalTests: 1, courses: 1, tests: 1 }, courses: [{ courseId: '10', status: 'ready',
            summary: { total: 1, maximum: 0, excellent: 0, retry: 1, unattempted: 0, active: 0, errors: 0, unknown: 0 },
            quizzes: [{ title: '<img src=x onerror=alert(1)>', topic: 'Topic', url: `${location.origin}/mod/quiz/view.php?id=20`, percent: 80,
              status: 'retry', checked: true, analysis: { known: 4, total: 5, withExclusions: 1 } }] }],
        } }) });
      };
    });
    await page.addScriptTag({ content: await readFile(new URL('../../batch/grades.user.js', import.meta.url), 'utf8') });
    assert.match(await page.locator('#moodle-batch-grades').innerText(), /1 курсов и 1 тестов/u);
    await page.locator('.moodle-batch-summary summary').click();
    assert.match(await page.locator('.moodle-batch-tests').innerText(), /Известно 4\/5/u);
    assert.equal(await page.locator('.moodle-batch-tests img').count(), 0);
    await page.getByRole('button', { name: 'Обновить анализ' }).click();
    assert.equal(await page.evaluate(() => window.requests), 2);
    assert.equal(await page.locator('details').evaluate(node => node.open), true);
    await page.evaluate(() => {
      document.querySelector('#moodle-batch-grades').remove();
      document.querySelectorAll('.moodle-batch-summary').forEach(node => node.remove());
      window.holdRequest = true;
    });
    await page.addScriptTag({ content: await readFile(new URL('../../batch/grades.user.js', import.meta.url), 'utf8') });
    assert.match(await page.locator('#moodle-batch-grades').innerText(), /Проверяю обновления/u);
    assert.match(await page.locator('.moodle-batch-summary summary').innerText(), /сохранённые данные/u);
  } finally { await browser.close(); }
});

test('quick grade refresh skips attempt pages and detailed refresh skips imported old reviews', async () => {
  const origin = 'https://moodle.example'; const calls = []; let imports = 0;
  const moodle = { origin, userScope: '42', courses: async () => [{ courseId: '10', title: 'Course' }],
    grades: async () => [{ quizId: '20', title: 'Test', percent: 95 }],
    quizzes: async () => { calls.push('discover'); return [{ quizId: '20', title: 'Test' }]; },
    read: async () => { calls.push('view'); return { quizId: '20', courseId: '10', userScope: '42', startForm: {}, attemptSummaries: [{}, {}], reviews: [`${origin}/mod/quiz/review.php?attempt=1&cmid=20`, `${origin}/mod/quiz/review.php?attempt=2&cmid=20`] }; },
    collect: async url => { calls.push(new URL(url).searchParams.get('attempt')); return { kind: 'review', quizId: '20', courseId: '10', userScope: '42', questions: [{}] }; } };
  const store = { importReview: () => imports++, lookup: () => ({ status: 'known', excludedAnswers: [] }) };
  const first = await scanOverview(moodle, store);
  assert.equal(imports, 2);
  calls.length = 0;
  const quick = await scanOverview(moodle, store, { previous: first, detailed: false });
  assert.deepEqual(calls, []);
  assert.equal(quick.courses[0].quizzes[0].percent, 95);
  assert.equal(quick.courses[0].quizzes[0].analysis.known, 1);
  assert.equal(quick.courses[0].quizzes[0].detailCheckedAt, first.courses[0].quizzes[0].detailCheckedAt);
  calls.length = 0;
  quick.courses[0].quizzes[0].activeAttempt = true;
  quick.courses[0].quizzes[0].attemptUsage = { used: 2, limit: 5, remaining: 3 };
  quick.courses[0].quizzes[0].reviewError = 'HTTP_503';
  let preserved = 0;
  const fresh = await scanOverview(moodle, store, { previous: quick, onProgress: snapshot => {
    const quiz = snapshot.courses[0]?.quizzes[0];
    if (quiz && snapshot.phase === 'courses') {
      assert.equal(quiz.activeAttempt, true, 'old active state stays visible until the attempt is checked');
      assert.equal(quiz.attemptUsage.remaining, 3);
      assert.equal(quiz.detailCheckedAt, quick.courses[0].quizzes[0].detailCheckedAt);
      preserved++;
    }
  } });
  assert.ok(preserved > 0);
  assert.equal(fresh.courses[0].quizzes[0].activeAttempt, false, 'fresh native state replaces the saved state');
  assert.equal(fresh.courses[0].quizzes[0].reviewError, undefined, 'successful retry clears the previous review error');
  assert.deepEqual(calls, ['discover', 'view', '2']);
  assert.equal(imports, 3, 'latest result stays fresh; old imported result is skipped');
  calls.length = 0;
  const limits = await scanOverview(moodle, store, { previous: quick, attemptsOnly: true });
  assert.deepEqual(calls, ['view'], 'attempt counters need no course rediscovery or review downloads');
  assert.equal(imports, 3);
  assert.equal(limits.progress.tests, 1);
  assert.equal(limits.courses[0].quizzes[0].analysis.known, 1, 'saved answer analysis is preserved');
});
