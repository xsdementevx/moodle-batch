import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { openService, serviceServer } from '../../batch/service.js';
import { prepareQuiz, runQuiz, runQuizzes } from '../../batch/run.js';
import { optionId } from '../../batch/answers.js';

const scope = { origin: 'https://sdo.sibupk.su', userScope: '42', courseId: '10', quizId: '20', attemptId: '30' };
const input = { userScope: '42', requestId: 'synthetic-request-1234', quizIds: ['20'], maxAttempts: 3 };
const overview = () => ({ schemaVersion: 1, ...scope, phase: 'complete', completedAt: new Date().toISOString(),
  progress: { courses: 1, totalCourses: 1, tests: 1, totalTests: 1 },
  courses: [{ courseId: '10', title: 'Course <img>', summary: { total: 1, retry: 1 }, quizzes: [{ quizId: '20', title: 'Quiz', topic: '', percent: 80, status: 'retry' }] }] });
const deps = root => ({ root, moodle: { origin: scope.origin, userScope: scope.userScope }, store: {}, web: {},
  scan: async () => overview() });
const waitDone = async service => {
  for (let i = 0; i < 200; i++) {
    if (service.state().jobs.every(j => ['complete', 'stopped', 'interrupted'].includes(j.status))) return;
    await new Promise(done => setTimeout(done, 5));
  }
  assert.fail('job did not settle');
};

test('service runs one durable job, rejects another and stops retries after verified 100%', async () => {
  const root = await mkdtemp(join(tmpdir(), 'batch-service-'));
  let service;
  let calls = 0;
  let release; const gate = new Promise(done => { release = done; });
  try {
    service = await openService({ ...deps(root), runner: async (moodle, store, quizId, options) => {
      calls++; await options.progress('solving', { quizId, provider: 'Jev', questions: 1, context: 'private synthetic context' });
      await gate; return { quizId: '20', courseId: '10', percent: calls === 1 ? 80 : 100, gradePercent: calls === 1 ? 80 : 100 };
    } });
    await service.refresh();
    await service.start(input);
    assert.equal((await service.start(input)).requestId, input.requestId);
    await assert.rejects(service.start({ ...input, requestId: 'synthetic-request-5678' }), /ALREADY_RUNNING/);
    await assert.rejects(service.start({ ...input, quizIds: ['21'] }), /REQUEST_ID_CONFLICT/);
    release(); await waitDone(service);
    assert.equal(calls, 2);
    assert.equal(service.state().jobs[0].results[0].status, 'maximum');
    const events = service.state().jobs[0].events;
    assert.equal(events[0].kind, 'start');
    assert.equal(events.filter(e => e.kind === 'result').length, 2);
    assert.equal(events.at(-1).kind, 'complete');
    assert.equal(JSON.stringify(events).includes('private synthetic context'), false);
    assert.equal(service.state().overview.courses[0].quizzes[0].percent, 100);
    assert.equal(service.state().overview.courses[0].summary.maximum, 1);
    await service.close();
    service = await openService({ ...deps(root), runner: () => assert.fail('must not replay a completed job') });
    assert.equal((await service.start(input)).status, 'complete');
    assert.deepEqual(service.state().jobs[0].events, events, 'log survives restart without replaying the job');
    assert.equal(service.state().overview.courses[0].quizzes[0].percent, 100);
    await assert.rejects(service.start({ ...input, userScope: '43' }), /INVALID_JOB/);
  } finally { release(); await service?.close(); await rm(root, { recursive: true, force: true }); }
});

test('Stop prevents later retries; restart marks running jobs interrupted without launching new attempts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'batch-stop-'));
  let service, calls = 0;
  let release; const gate = new Promise(done => { release = done; });
  try {
    service = await openService({ ...deps(root), runner: async () => { calls++; await gate; return { percent: 80 }; } });
    await service.start(input);
    while (!calls) await new Promise(done => setTimeout(done, 5));
    await service.stop(input.requestId); release(); await waitDone(service);
    assert.equal(calls, 1); assert.equal(service.state().jobs[0].status, 'stopped');
    await service.close();
    await writeFile(join(root, 'jobs.json'), JSON.stringify({ origin: scope.origin, userScope: '42', jobs: [{ ...input, status: 'running', results: [] }] }));
    service = await openService({ ...deps(root), runner: () => assert.fail('restart must not dispatch') });
    assert.equal(service.state().jobs[0].status, 'interrupted');
  } finally { release(); await service?.close(); await rm(root, { recursive: true, force: true }); }
});

test('preparation skips material requests when all questions are confirmed in memory', async () => {
  const view = { ...scope, reviews: [], activeUrl: `${scope.origin}/mod/quiz/attempt.php?attempt=30&cmid=20` };
  const moodle = { ...scope, read: async () => view, collect: async () => ({ ...scope, kind: 'attempt', complete: true, questions: [{ ...scope, slot: '1' }] }) };
  const store = { lookup: () => ({ status: 'known', answer: ['synthetic'] }) };
  const prepared = await prepareQuiz(moodle, store, '20', { root: '.', contextLoader: () => assert.fail('confirmed answers must not download materials') });
  assert.equal(prepared.context.reason, 'NO_UNRESOLVED_QUESTIONS');
  assert.equal(prepared.questions[0].memory.status, 'known');
});

test('real runner keeps native submission, checks Stop and records model attribution with Moodle feedback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'batch-run-'));
  let submitted = 0, imported = 0, stopped = false;
  const question = { ...scope, slot: '1', type: 'choice', text: 'Synthetic question', rows: [], behaviour: 'deferredfeedback',
    sequenceFieldName: 'q100:1_:sequencecheck', sequenceValue: '1',
    options: ['A', 'B'].map((text, i) => ({ id: optionId(text), text, fieldName: 'q100:1_answer', value: String(i) })) };
  const attempt = { ...scope, kind: 'attempt', complete: true, questions: [question], sourceUrl: `${scope.origin}/mod/quiz/attempt.php?attempt=30&cmid=20`,
    submissionForms: [{ method: 'post', action: `${scope.origin}/mod/quiz/processattempt.php`, sesskey: 'synthetic', slots: ['1'] }] };
  const view = { ...scope, kind: 'view', reviews: [], activeUrl: attempt.sourceUrl };
  const review = { ...scope, kind: 'review', questions: [{ ...question, feedback: 'correct' }], resultSummary: [{ label: 'Оценка', value: '10 из 10 (100,00%)' }] };
  const moodle = { ...scope, grades: async id => { assert.equal(id, '10'); return [{ quizId: '20', percent: 100 }]; }, read: async () => view, collect: async url => url.includes('review.php') ? review : attempt,
    postSubmission: async () => { submitted++; return { reviewUrl: `${scope.origin}/mod/quiz/review.php?attempt=30&cmid=20` }; } };
  const store = { importReview: () => imported++, lookup: () => ({ status: 'known', answer: [optionId('A')], excludedAnswers: [] }) };
  const options = { root, stopped: () => stopped, contextLoader: async () => ({ status: 'missing', text: '' }) };
  try {
    const result = await runQuiz(moodle, store, '20', options);
    assert.equal(result.percent, 100); assert.equal(result.gradePercent, 100); assert.equal(submitted, 1); assert.equal(imported, 1);
    assert.deepEqual(result.sources, [{ slot: '1', provider: 'memory', feedback: 'correct' }]);
    stopped = true;
    await assert.rejects(runQuiz(moodle, store, '20', options), /STOPPED/);
    assert.equal(submitted, 1);
    stopped = false;
    await assert.rejects(runQuiz({ ...moodle, read: async () => ({ ...view, userScope: '43' }) }, store, '20', options), /SCOPE_MISMATCH/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('shared runner submits native slots to each test and isolates an unresolved test', async () => {
  const root = await mkdtemp(join(tmpdir(), 'batch-native-shared-'));
  const make = quizId => {
    const attemptId = quizId === '20' ? '30' : '31';
    const s = { ...scope, quizId, attemptId };
    const question = { ...s, slot: '1', type: 'choice', text: 'Synthetic question', rows: [], behaviour: 'deferredfeedback',
      sequenceFieldName: `q100:1_:sequencecheck`, sequenceValue: '1',
      options: ['A', 'B'].map((text, i) => ({ id: optionId(text), text, fieldName: 'q100:1_answer', value: String(i) })) };
    const attempt = { ...s, kind: 'attempt', complete: true, questions: [question], sourceUrl: `${s.origin}/mod/quiz/attempt.php?attempt=${attemptId}&cmid=${quizId}`,
      submissionForms: [{ method: 'post', action: `${s.origin}/mod/quiz/processattempt.php`, sesskey: 'synthetic', slots: ['1'] }] };
    return { view: { ...s, reviews: [], activeUrl: attempt.sourceUrl }, attempt,
      review: { ...s, kind: 'review', questions: [{ ...question, feedback: 'correct' }], resultSummary: [{ label: 'Grade', value: '100%' }] } };
  };
  const tests = { '20': make('20'), '21': make('21') }, submitted = [];
  const moodle = { ...scope,
    read: async url => tests[new URL(url, scope.origin).searchParams.get('id')].view,
    collect: async url => { const u = new URL(url), t = tests[u.searchParams.get('cmid')]; return u.pathname.includes('review') ? t.review : t.attempt; },
    grades: async () => [{ quizId: '20', percent: 100 }],
    postSubmission: async request => { submitted.push(request); return { reviewUrl: `${scope.origin}/mod/quiz/review.php?attempt=30&cmid=20` }; } };
  const store = { importReview() {}, lookup: () => ({ status: 'unresolved', excludedAnswers: [] }) };
  try {
    const results = await runQuizzes(moodle, store, ['20', '21'], { root, contextLoader: async () => ({ status: 'missing', text: '' }),
      solve: async questions => {
        assert.deepEqual(questions.map(q => q.slot), ['20:30:1', '21:31:1']);
        return questions.map(q => ({ ...q, decision: q.quizId === '20'
          ? { provider: 'gpt_web', status: 'candidate', answer: [optionId('A')] } : { status: 'needs_review', answer: null } }));
      } });
    assert.equal(results[0].result.percent, 100);
    assert.ok(results[1].error);
    assert.equal(submitted.length, 1);
    assert.equal(results[0].result.sources[0].slot, '1');
    const journal = join(root, 'operations', `${'a'.repeat(64)}.json`);
    await mkdir(join(root, 'operations'), { recursive: true });
    const pending = { state: 'pending', questionIds: ['20:30:1'] };
    await writeFile(journal, JSON.stringify(pending));
    let batches = 0;
    const isolated = await runQuizzes(moodle, store, ['20', '21'], { root, contextLoader: async () => ({ status: 'missing', text: '' }),
      solve: async questions => {
        batches++; assert.deepEqual(questions.map(q => q.slot), ['21:31:1']);
        return questions.map(q => ({ ...q, decision: { status: 'needs_review', answer: null } }));
      } });
    assert.equal(batches, 1);
    assert.equal(isolated.find(q => q.quizId === '20').error.message, 'UNKNOWN_MODEL_OUTCOME');
    assert.notEqual(isolated.find(q => q.quizId === '21').error.message, 'UNKNOWN_MODEL_OUTCOME');
    assert.equal(submitted.length, 1, 'pending test must never be submitted');
    assert.deepEqual(JSON.parse(await readFile(journal, 'utf8')), pending, 'pending request remains intact');
    await writeFile(journal, JSON.stringify({ state: 'pending' }));
    const legacy = await runQuizzes(moodle, store, ['20', '21'], { root, contextLoader: async () => ({ status: 'missing', text: '' }),
      solve: () => assert.fail('unscoped legacy pending request must block all unresolved tests') });
    assert.equal(legacy.length, 2);
    assert.ok(legacy.every(q => q.error.message === 'UNKNOWN_MODEL_OUTCOME'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('service batches each round and retries only tests below maximum', async () => {
  const root = await mkdtemp(join(tmpdir(), 'batch-rounds-'));
  const rounds = []; let service;
  try {
    service = await openService({ ...deps(root), batchRunner: async (moodle, store, ids, options) => {
      rounds.push(ids);
      const results = ids.map(quizId => ({ quizId, percent: quizId === '20' || rounds.length === 2 ? 100 : 80 }));
      for (const result of results) await options.onResult(result);
      return results.map(result => ({ quizId: result.quizId, result }));
    } });
    await service.start({ ...input, quizIds: ['20', '21'] }); await waitDone(service);
    assert.deepEqual(rounds, [['20', '21'], ['21']]);
    assert.deepEqual(service.state().jobs[0].results.map(q => q.attempts.length), [1, 2]);
  } finally { await service?.close(); await rm(root, { recursive: true, force: true }); }
});

test('HTTP bridge requires secret, exact loopback host, extension origin, account and explicit POST', async () => {
  const root = await mkdtemp(join(tmpdir(), 'batch-http-'));
  const service = await openService({ ...deps(root), runner: () => assert.fail('unauthorized dispatch') });
  const token = 'synthetic-token';
  const server = serviceServer(service, token, 49815);
  await new Promise(done => server.listen(49815, '127.0.0.1', done));
  const url = 'http://127.0.0.1:49815';
  try {
    assert.equal((await fetch(`${url}/state?user=42`)).status, 403);
    const headers = { Authorization: `Bearer ${token}` };
    assert.equal((await fetch(`${url}/state?user=43`, { headers })).status, 403);
    assert.equal((await fetch(`${url}/state?user=42`, { headers: { ...headers, Origin: scope.origin } })).status, 403);
    assert.equal((await fetch(`${url}/jobs`, { headers })).status, 405);
    assert.equal((await fetch(`${url}/jobs`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{' })).status, 400);
    assert.equal((await fetch(`${url}/state?user=42`, { headers })).status, 200);
    assert.equal(service.state().overview, null, 'status polling must not start a whole-course scan');
  } finally { await new Promise(done => server.close(done)); await service.close(); await rm(root, { recursive: true, force: true }); }
});

test('installed extension recovers a lost start reply after reopening without changing intent or dispatching twice', async () => {
  const root = await mkdtemp(join(tmpdir(), 'batch-extension-'));
  let context, service, server, calls = 0;
  try {
    service = await openService({ ...deps(root), runner: async () => { calls++; return { percent: 100, grade: '10 из 10 (100%)', correct: 1, total: 1,
      sources: [{ slot: '1', provider: 'memory', cached: true, feedback: 'correct' }], reviewUrl: `${scope.origin}/mod/quiz/review.php?attempt=30&cmid=20` }; } });
    server = serviceServer(service, 'synthetic-token', 49816);
    let lostReply = false, dropReplies = true;
    server.prependListener('request', (req, res) => {
      if (req.method === 'POST' && req.url === '/jobs' && dropReplies) {
        lostReply = true;
        res.end = function () { this.destroy(); return this; };
      }
    });
    await new Promise(done => server.listen(49816, '127.0.0.1', done));
    await service.refresh();
    const dir = join(root, 'extension');
    await cp(new URL('../../batch-extension/', import.meta.url), dir, { recursive: true });
    await writeFile(join(dir, 'config.js'), `globalThis.batchConfig=${JSON.stringify({ token: 'synthetic-token', endpoint: 'http://127.0.0.1:49816', ...scope })};`);
    context = await chromium.launchPersistentContext(join(root, 'profile'), { channel: 'chromium', headless: true,
      args: [`--disable-extensions-except=${dir}`, `--load-extension=${dir}`] });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    await context.route(`${scope.origin}/**`, route => route.fulfill({ contentType: 'text/html', body: new URL(route.request().url()).pathname === '/user/profile.php'
      ? '<body id="page-user-profile"><main id="region-main"><div data-userid="42"></div></main></body>'
      : '<body><div class="usermenu"><a href="/user/profile.php">Profile</a></div><main id="region-main"><form id="responseform"><input value="unchanged"></form></main></body>' }));
    const page = await context.newPage(); await page.goto(`${scope.origin}/mod/quiz/view.php?id=20`);
    const opened = context.waitForEvent('page');
    await page.locator('#moodle-batch-open').click();
    const dashboard = await opened;
    await dashboard.locator('.quiz').waitFor();
    assert.equal(await dashboard.locator('.quiz input').isChecked(), true);
    assert.equal(await dashboard.locator('img').count(), 0);
    await dashboard.locator('#run').click();
    await dashboard.getByRole('button', { name: 'Проверить сохранённый запуск (1)', exact: true }).waitFor();
    assert.equal(await dashboard.locator('#rounds').isDisabled(), true);
    assert.equal(await dashboard.locator('.quiz input').isDisabled(), true);
    const saved = await worker.evaluate(async () => (await chrome.storage.local.get('pendingJob')).pendingJob);
    assert.deepEqual(saved.quizIds, ['20']);
    assert.equal(saved.requestId, service.state().jobs[0].requestId);
    assert.equal(lostReply, true);
    dropReplies = false;
    await waitDone(service);
    assert.equal(calls, 1);
    await dashboard.close();
    const reopened = await context.newPage();
    await reopened.goto(`chrome-extension://${new URL(worker.url()).hostname}/dashboard.html?user=42`);
    await reopened.locator('#job-title').filter({ hasText: 'Запуск завершён' }).waitFor();
    await reopened.locator('#nav-logs').click();
    assert.equal(await reopened.locator('#logs-view').isVisible(), true);
    assert.equal(await reopened.locator('.events li').count(), 3);
    await reopened.evaluate(() => { navigator.clipboard.writeText = async text => { globalThis.copiedReport = text; }; });
    await reopened.locator('#copy-report').click();
    assert.match(await reopened.evaluate(() => globalThis.copiedReport), /Moodle Batch — отчёт запуска/);
    assert.match(await reopened.evaluate(() => globalThis.copiedReport), /Тест 20/);
    assert.match(await reopened.evaluate(() => globalThis.copiedReport), /Вопрос 1: memory; сохранённый ответ; Moodle: correct/);
    await reopened.evaluate(() => { navigator.clipboard.writeText = async () => { throw new Error('denied'); }; });
    await reopened.locator('#copy-report').click();
    assert.equal(await reopened.locator('#log-export').isVisible(), true);
    assert.match(await reopened.locator('#log-export').inputValue(), /ЭТАПЫ/);
    await reopened.setViewportSize({ width: 1440, height: 720 });
    assert.equal(await reopened.locator('.run-column').evaluate(el => { el.scrollTop = el.scrollHeight; return el.scrollTop > 0 && el.scrollTop + el.clientHeight >= el.scrollHeight - 1; }), true);
    await reopened.locator('#errors-only').check();
    assert.match(await reopened.locator('#jobs').textContent(), /Запусков с ошибками нет/);
    await reopened.locator('#errors-only').uncheck();
    await reopened.locator('#nav-tests').click();
    assert.equal(calls, 1);
    assert.equal(await reopened.locator('.quiz input').isChecked(), true);
    assert.equal(await worker.evaluate(async () => (await chrome.storage.local.get('pendingJob')).pendingJob), undefined);
    const start = service.start.bind(service);
    service.start = async () => { throw new Error('JOB_ALREADY_RUNNING'); };
    await reopened.locator('#run').click();
    await reopened.getByText('Другой запуск уже выполняется.', { exact: true }).waitFor();
    assert.equal(await worker.evaluate(async () => (await chrome.storage.local.get('pendingJob')).pendingJob), undefined,
      'a definitive rejection must not become a stale retry intent');
    assert.equal(await reopened.locator('#rounds').isDisabled(), false);
    service.start = start;
    const readState = service.state.bind(service);
    service.state = () => {
      const state = structuredClone(readState());
      const course = state.overview.courses[0];
      const quiz = course.quizzes[0];
      course.quizzes = [{ ...quiz, percent: 100, status: 'maximum' },
        { ...quiz, quizId: '21', percent: 95, status: 'excellent' },
        { ...quiz, quizId: '22', percent: null, status: 'unattempted' }];
      return state;
    };
    await reopened.reload();
    await reopened.locator('.quiz').nth(2).waitFor({ state: 'attached' });
    await reopened.locator('#low').check();
    assert.equal(await reopened.locator('.quiz').count(), 1);
    assert.equal(await reopened.locator('.quiz span').textContent(), '95%');
    await reopened.locator('#select').click();
    assert.equal(await reopened.locator('.quiz input:checked').count(), 1);
    assert.equal(await reopened.locator('#run').isDisabled(), false);
    await reopened.locator('#search').fill('not-found');
    assert.equal(await reopened.locator('.quiz').count(), 0);
    assert.equal(await reopened.locator('#empty').isVisible(), true);
    assert.match(await reopened.locator('#hidden-selected').textContent(), /1 скрыто/);
    await reopened.locator('#search').fill('21');
    assert.equal(await reopened.locator('.quiz').count(), 1);
    await reopened.locator('#clear').click();
    assert.equal(await reopened.locator('#run').isDisabled(), true);
    await reopened.locator('.course-select').click();
    assert.equal(await reopened.locator('.quiz input:checked').count(), 1);
    await reopened.locator('#grade-filter').selectOption('selected');
    assert.equal(await reopened.locator('.quiz').count(), 1);
    assert.equal(calls, 1, 'filtering and selecting must not send an attempt');
    assert.equal(await page.locator('#responseform input').inputValue(), 'unchanged');
  } finally { await context?.close(); if (server) await new Promise(done => server.close(done)); await service?.close(); await rm(root, { recursive: true, force: true }); }
});

test('batch errors become visible immediately with question reasons and are not logged twice', async () => {
  const root = await mkdtemp(join(tmpdir(), 'batch-errors-'));
  let service, release; const gate = new Promise(done => { release = done; });
  try {
    service = await openService({ ...deps(root), batchRunner: async (moodle, store, ids, options) => {
      const error = new Error('UNRESOLVED_SUBMISSION'); error.unresolvedQuestions = [{ slot: '2', reason: 'source_quote_not_found', provider: 'gpt_web' }];
      await options.onError('20', error); await gate;
      return [{ quizId: '20', error }];
    } });
    await service.start(input);
    while (!service.state().jobs[0].results[0]?.error) await new Promise(done => setTimeout(done, 5));
    assert.equal(service.state().jobs[0].status, 'running');
    assert.equal(service.state().jobs[0].results[0].unresolvedQuestions[0].reason, 'source_quote_not_found');
    release(); await waitDone(service);
    assert.equal(service.state().jobs[0].events.filter(e => e.kind === 'error').length, 1);
  } finally { release(); await service?.close(); await rm(root, { recursive: true, force: true }); }
});
