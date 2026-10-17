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
      assert.deepEqual(options.importedReviews['20'], [`${scope.origin}/mod/quiz/review.php?attempt=1&cmid=20`]);
      calls++; await options.progress('solving', { quizId, provider: 'Jev', questions: 1, tests: 1, total: 12, context: 'private synthetic context' });
      await options.progress('solving', { quizId, provider: 'Jev', questions: 1, tests: 1, total: 12, context: 'updated private context' });
      await gate; return { quizId: '20', courseId: '10', percent: calls === 1 ? 80 : 100, gradePercent: calls === 1 ? 80 : 100 };
    } });
    await service.refresh();
    service.state().overview.courses[0].quizzes[0].importedReviews = [`${scope.origin}/mod/quiz/review.php?attempt=1&cmid=20`];
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
    assert.deepEqual(events.filter(e => e.stage === 'solving').map(e => e.round), [1, 2], 'duplicate stages collapse but a new round remains visible');
    assert.equal(events.find(e => e.stage === 'solving').tests, 1);
    assert.equal(events.find(e => e.stage === 'solving').total, 12);
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

test('next job waits for owned Web tab cleanup after the previous result is complete', async () => {
  const root = await mkdtemp(join(tmpdir(), 'batch-tab-cleanup-'));
  let service, release, cleaning;
  const cleanup = new Promise(done => { release = done; });
  const entered = new Promise(done => { cleaning = done; });
  try {
    service = await openService({ ...deps(root), runner: async () => ({ percent: 100 }),
      web: { release: async () => { cleaning(); await cleanup; } } });
    await service.start({ ...input, maxAttempts: 1 }); await entered;
    assert.equal(service.state().jobs[0].status, 'complete');
    let accepted = false;
    const next = service.start({ ...input, maxAttempts: 1, requestId: 'after-cleanup-request-1234' }).then(job => { accepted = true; return job; });
    await new Promise(done => setImmediate(done)); assert.equal(accepted, false);
    release(); await next;
    await service.close(); assert.equal(service.state().jobs.length, 2);
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
  const root = await mkdtemp(join(tmpdir(), 'batch-prepare-'));
  const view = { ...scope, reviews: [], activeUrl: `${scope.origin}/mod/quiz/attempt.php?attempt=30&cmid=20` };
  const moodle = { ...scope, read: async () => view, collect: async () => ({ ...scope, kind: 'attempt', complete: true, questions: [{ ...scope, slot: '1' }] }) };
  const store = { lookup: () => ({ status: 'known', answer: ['synthetic'] }) };
  try {
    const prepared = await prepareQuiz(moodle, store, '20', { root, contextLoader: () => assert.fail('confirmed answers must not download materials') });
    assert.equal(prepared.context.reason, 'NO_UNRESOLVED_QUESTIONS');
    assert.equal(prepared.questions[0].memory.status, 'known');
    view.reviews = ['1', '2', '3'].map(attempt => `${scope.origin}/mod/quiz/review.php?attempt=${attempt}&cmid=20`);
    const reads = [], imports = [];
    moodle.collect = async url => {
      if (url.includes('review.php')) { const attempt = new URL(url).searchParams.get('attempt'); reads.push(attempt);
        return { ...scope, attemptId: attempt, kind: 'review', questions: [attempt] }; }
      return { ...scope, kind: 'attempt', complete: true, questions: [{ ...scope, slot: '1' }] };
    };
    store.importReview = questions => imports.push(...questions);
    await prepareQuiz(moodle, store, '20', { root, importedReviews: { '20': [view.reviews[0], view.reviews[2]] },
      contextLoader: () => assert.fail('confirmed answers must not download materials') });
    assert.deepEqual(reads, ['2', '3'], 'unknown history and latest review must be read, even when latest is cached');
    assert.deepEqual(imports, ['2', '3']);
    reads.length = 0;
    await prepareQuiz(moodle, store, '20', { root, importedReviews: { '21': view.reviews },
      contextLoader: () => assert.fail('confirmed answers must not download materials') });
    assert.deepEqual(reads, ['1', '2', '3'], 'a different quiz cache cannot skip any review');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('service persists minimum time and protects the original setting across request retries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'batch-time-setting-'));
  let service, release;
  const gate = new Promise(done => { release = done; });
  const timedInput = { ...input, maxAttempts: 1, secondsPerQuestion: 10 };
  try {
    service = await openService({ ...deps(root), runner: async (m, s, id, options) => {
      assert.equal(options.secondsPerQuestion, 10);
      await options.progress('waiting', { quizId: id, startedAt: 1_000_000, readyAt: 1_200_000, minimumSeconds: 200 });
      await gate; return { quizId: id, percent: 100 };
    } });
    for (const value of [-1, 601, 1.5, '10', null]) {
      await assert.rejects(service.start({ ...timedInput, secondsPerQuestion: value }), /INVALID_JOB/);
    }
    const job = await service.start(timedInput);
    assert.equal(job.secondsPerQuestion, 10);
    assert.equal((await service.start(timedInput)).requestId, job.requestId);
    await assert.rejects(service.start({ ...timedInput, secondsPerQuestion: 20 }), /REQUEST_ID_CONFLICT/);
    release(); await waitDone(service);
    await service.close(); // Await the final durable rename before reading the file on Windows.
    assert.equal(JSON.parse(await readFile(join(root, 'jobs.json'), 'utf8')).jobs[0].secondsPerQuestion, 10);
    assert.equal(service.state().jobs[0].events.find(e => e.stage === 'waiting').minimumSeconds, 200);
  } finally { release(); await service?.close(); await rm(root, { recursive: true, force: true }); }
});

test('batch opens all known attempts before waiting and isolates ready memory from a pending or failed model', { timeout: 5000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'batch-timed-packet-'));
  let clock = 1_000_000;
  const read = [], submitted = [];
  const attempts = ['20', '21'].map((quizId, i) => {
    const attemptId = String(30 + i);
    const questions = Array.from({ length: i ? 1 : 2 }, (_, j) => ({ ...scope, quizId, attemptId, slot: String(j + 1),
      type: 'choice', text: `Question ${j + 1}`, rows: [], behaviour: 'deferredfeedback',
      sequenceFieldName: `q100:${j + 1}_:sequencecheck`, sequenceValue: '1',
      options: ['A', 'B'].map((text, k) => ({ id: optionId(text), text, fieldName: `q100:${j + 1}_answer`, value: String(k) })) }));
    return { ...scope, quizId, attemptId, kind: 'attempt', complete: true, questions,
      sourceUrl: `${scope.origin}/mod/quiz/attempt.php?attempt=${attemptId}&cmid=${quizId}`,
      submissionForms: [{ method: 'post', action: `${scope.origin}/mod/quiz/processattempt.php`, sesskey: 'synthetic', slots: questions.map(q => q.slot) }] };
  });
  const moodle = { ...scope,
    read: async url => { const q = attempts.find(q => url.endsWith(`id=${q.quizId}`)); read.push(q.quizId); return { ...q, kind: 'view', reviews: [], activeUrl: q.sourceUrl }; },
    collect: async url => {
      const q = attempts.find(q => new URL(url).searchParams.get('attempt') === q.attemptId);
      return url.includes('review.php') ? { ...q, kind: 'review', resultSummary: [{ label: 'Оценка', value: '100%' }], questions: q.questions.map(q => ({ ...q, feedback: 'correct' })) } : q;
    },
    grades: async () => attempts.map(q => ({ quizId: q.quizId, percent: 100 })),
    postSubmission: async plan => { submitted.push({ quiz: plan.fields.cmid, at: clock }); return { reviewUrl: `${scope.origin}/mod/quiz/review.php?attempt=${plan.fields.attempt}&cmid=${plan.fields.cmid}` }; },
  };
  const store = { lookup: () => ({ status: 'known', answer: [optionId('A')], excludedAnswers: [] }), importReview() {} };
  try {
    const results = await runQuizzes(moodle, store, ['20', '21'], { root, secondsPerQuestion: 10, now: () => clock,
      contextLoader: () => assert.fail('known questions require no context'),
      sleep: async ms => { assert.deepEqual(read, ['20', '21'], 'one wait must not delay opening the next attempt'); clock += ms; },
    });
    assert.deepEqual(submitted, [{ quiz: '21', at: 1_010_000 }, { quiz: '20', at: 1_020_000 }]);
    assert.ok(results.every(q => q.result.percent === 100));
    assert.deepEqual(results.map(q => q.result.timing.elapsedSeconds), [10, 20]);
    clock = 1_000_000; let modelStarted = false;
    let release; const gate = new Promise(done => { release = done; });
    try {
      const mixed = await runQuizzes({ ...moodle, postSubmission: async plan => {
        assert.equal(plan.fields.cmid, '21', 'unknown model answer must never be submitted');
        assert.equal(modelStarted, true, 'model work starts before the known test finishes waiting');
        assert.equal(clock, 1_010_000);
        release();
        return { reviewUrl: `${scope.origin}/mod/quiz/review.php?attempt=${plan.fields.attempt}&cmid=${plan.fields.cmid}` };
      } }, { ...store, lookup: q => q.quizId === '21' ? store.lookup(q) : { status: 'unresolved', excludedAnswers: [] } }, ['20', '21'], {
        root: join(root, 'mixed'), secondsPerQuestion: 10, now: () => clock,
        contextLoader: async () => ({ status: 'missing', text: '' }), sleep: async ms => { clock += ms; },
        solve: async questions => { assert.ok(questions.every(q => q.quizId === '20')); modelStarted = true; await gate; throw new Error('MODEL_FAILED'); },
      });
      assert.equal(mixed.find(r => r.quizId === '21').result.percent, 100);
      assert.equal(mixed.find(r => r.quizId === '20').error.message, 'MODEL_FAILED');
    } finally { release(); }
  } finally { await rm(root, { recursive: true, force: true }); }
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
  const review = { ...scope, kind: 'review', questions: [{ ...question, options: question.options.map((o, i) => ({ ...o, selected: i === 0 })), feedback: 'correct' }], resultSummary: [{ label: 'Оценка', value: '10 из 10 (100,00%)' }] };
  const moodle = { ...scope, grades: async id => { assert.equal(id, '10'); return [{ quizId: '20', percent: 100 }]; }, read: async () => view, collect: async url => url.includes('review.php') ? review : attempt,
    postSubmission: async () => { submitted++; return { reviewUrl: `${scope.origin}/mod/quiz/review.php?attempt=30&cmid=20` }; } };
  const store = { importReview: () => imported++, lookup: () => ({ status: 'known', answer: [optionId('A')], excludedAnswers: [] }) };
  const options = { root, stopped: () => stopped, contextLoader: async () => ({ status: 'missing', text: '' }) };
  try {
    const result = await runQuiz(moodle, store, '20', options);
    assert.equal(result.percent, 100); assert.equal(result.gradePercent, 100); assert.equal(submitted, 1); assert.equal(imported, 1);
    assert.deepEqual(result.sources, [{ slot: '1', question: 'Synthetic question', questionType: 'choice', answer: ['A'], provider: 'memory', feedback: 'correct' }]);
    stopped = true;
    await assert.rejects(runQuiz(moodle, store, '20', options), /STOPPED/);
    assert.equal(submitted, 1);
    stopped = false;
    await assert.rejects(runQuiz({ ...moodle, read: async () => ({ ...view, userScope: '43' }) }, store, '20', options), /SCOPE_MISMATCH/);
    const evidence = { kind: 'web', url: 'https://example.org/reference', quote: 'The documented answer is A.', optionIds: ['private-option-id'] };
    const attributed = await runQuiz(moodle, store, '20', { ...options, root: join(root, 'model'),
      solve: async questions => questions.map(q => ({ ...q, decision: { status: 'candidate', provider: 'gpt-web', confidence: 0.92,
        answer: [optionId('A')], jevAgreement: false, evidenceVerified: true, evidence: [evidence] } })) });
    assert.equal(attributed.sources[0].confidence, 0.92);
    assert.equal(attributed.sources[0].jevAgreement, false);
    assert.deepEqual(attributed.sources[0].answer, ['A']);
    assert.deepEqual(attributed.sources[0].evidence, [{ kind: 'web', url: evidence.url, quote: evidence.quote }]);
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
    const completed = [];
    const memoryFirst = await runQuizzes(moodle, { ...store, lookup: q => q.quizId === '20'
      ? { status: 'known', answer: [optionId('A')], excludedAnswers: [] } : store.lookup(q) }, ['20', '21'], {
      root, contextLoader: async () => ({ status: 'missing', text: '' }),
      onResult: result => completed.push(result.quizId),
      solve: async questions => {
        assert.deepEqual(completed, ['20'], 'known attempt must finish before any model work');
        assert.deepEqual(questions.map(q => q.quizId), ['21']);
        return questions.map(q => ({ ...q, decision: { status: 'needs_review', answer: null } }));
      } });
    assert.equal(memoryFirst[0].result.percent, 100);
    assert.equal(memoryFirst[0].result.sources[0].provider, 'memory');
    assert.equal(submitted.length, 1, 'completed native submission must not be sent again');
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
    const earlyCompleted = [];
    const early = await runQuizzes(moodle, store, ['20', '21'], { root: join(root, 'early'),
      contextLoader: async () => ({ status: 'missing', text: '' }), onResult: result => earlyCompleted.push(result.quizId),
      solve: async (questions, context, options) => {
        const answers = questions.map(q => ({ ...q, decision: q.quizId === '20'
          ? { provider: 'gpt_web', status: 'candidate', answer: [optionId('A')] } : { status: 'needs_review', answer: null } }));
        await options.onAnswers(answers);
        assert.deepEqual(earlyCompleted, ['20'], 'a complete verified test finishes before clarification of another test');
        await options.onAnswers(answers);
        assert.equal(submitted.length, 2, 'repeated answer snapshots never resubmit a test');
        throw new Error('MODEL_SECOND_FAILED');
      } });
    assert.equal(early.find(q => q.quizId === '20').result.percent, 100);
    assert.equal(early.find(q => q.quizId === '21').error.message, 'MODEL_SECOND_FAILED');
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

test('HTTP bridge requires secret, exact loopback host, extension origin, explicit POST and authenticated session updates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'batch-http-'));
  const service = await openService({ ...deps(root), runner: () => assert.fail('unauthorized dispatch') });
  const token = 'synthetic-token';
  const server = serviceServer(service, token, 49815);
  await new Promise(done => server.listen(49815, '127.0.0.1', done));
  const url = 'http://127.0.0.1:49815';
  try {
    assert.equal((await fetch(`${url}/state?user=42`)).status, 403);
    const headers = { Authorization: `Bearer ${token}` };
    assert.equal((await fetch(`${url}/state?user=43`, { headers })).status, 200);
    assert.equal((await fetch(`${url}/state?user=42`, { headers: { ...headers, Origin: scope.origin } })).status, 403);
    assert.equal((await fetch(`${url}/jobs`, { headers })).status, 405);
    assert.equal((await fetch(`${url}/jobs`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{' })).status, 400);
    assert.equal((await fetch(`${url}/state?user=42`, { headers })).status, 200);
    assert.equal(service.state().overview, null, 'status polling must not start a whole-course scan');
    let received;
    service.session = async cookies => { received = cookies; return { userScope: '43' }; };
    const sessionRequest = { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ cookies: [{ name: 'MoodleSession', value: 'synthetic' }] }) };
    assert.equal((await fetch(`${url}/session`, { ...sessionRequest, headers: { 'Content-Type': 'application/json' } })).status, 403);
    assert.equal(received, undefined);
    assert.equal((await fetch(`${url}/session`, sessionRequest)).status, 200);
    assert.equal(received[0].value, 'synthetic');

  } finally { await new Promise(done => server.close(done)); await service.close(); await rm(root, { recursive: true, force: true }); }
});

test('installed extension accepts a different browser account and recovers a lost start reply after reopening without changing intent or dispatching twice', async () => {
  const root = await mkdtemp(join(tmpdir(), 'batch-extension-'));
  let context, service, server, calls = 0;
  try {
    service = await openService({ ...deps(root), runner: async () => { calls++; return { percent: 100, gradePercent: 90, grade: '10 из 10 (100%)', correct: 1, total: 1,
      sources: [{ slot: '1', provider: 'memory', cached: true, feedback: 'correct', question: 'Synthetic question', answer: ['<img src=x onerror=alert(1)>'], confidence: 0.92, semanticVerified: true,
        evidence: [{ kind: 'web', quote: 'The documented answer is A.', url: 'https://example.org/reference' }] }], reviewUrl: `${scope.origin}/mod/quiz/review.php?attempt=30&cmid=20` }; } });
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
    let sessionUpdates = 0;
    const moodleSession = async cookies => {
      sessionUpdates++;
      assert.deepEqual(cookies.map(c => c.name), ['MoodleSession']);
      assert.equal(cookies[0].value, 'synthetic-session');
    };
    service.session = async cookies => { await moodleSession(cookies); return { userScope: '42' }; };
    const dir = join(root, 'extension');
    await cp(new URL('../../batch-extension/', import.meta.url), dir, { recursive: true });
    await writeFile(join(dir, 'config.js'), `globalThis.batchConfig=${JSON.stringify({ token: 'synthetic-token', endpoint: 'http://127.0.0.1:49816', ...scope })};`);
    context = await chromium.launchPersistentContext(join(root, 'profile'), { channel: 'chromium', headless: true,
      args: [`--disable-extensions-except=${dir}`, `--load-extension=${dir}`] });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    await context.route(`${scope.origin}/**`, route => route.fulfill({ contentType: 'text/html', body: new URL(route.request().url()).pathname === '/user/profile.php'
      ? '<body id="page-user-profile"><main id="region-main"><div data-userid="43"></div></main></body>'
      : '<body><div class="usermenu"><a href="/user/profile.php">Profile</a></div><main id="region-main"><form id="responseform"><input value="unchanged"></form></main></body>' }));
    await context.addCookies([{ name: 'MoodleSession', value: 'synthetic-session', url: scope.origin, httpOnly: true, secure: true },
      { name: 'unrelated', value: 'must-not-transfer', url: 'https://example.org' }]);
    const page = await context.newPage(); await page.goto(`${scope.origin}/mod/quiz/view.php?id=20`);
    const opened = context.waitForEvent('page');
    await page.locator('#moodle-batch-open').click();
    const dashboard = await opened;
    assert.equal(await page.locator('#moodle-batch-open').textContent(), 'Moodle Batch открыт в новой вкладке');
    assert.equal(await page.locator('#moodle-batch-open').isDisabled(), true);
    await dashboard.locator('.quiz').waitFor();
    assert.equal(await dashboard.locator('.quiz input').isChecked(), true);
    assert.equal(sessionUpdates, 1, 'browser session is synchronized automatically');
    assert.equal(await dashboard.locator('img').count(), 0);
    assert.equal(await dashboard.locator('#seconds-per-question').inputValue(), '10');
    await dashboard.locator('#seconds-per-question').fill('12');
    await dashboard.locator('#seconds-per-question').dispatchEvent('change');
    await dashboard.locator('#run').click();
    await dashboard.getByRole('button', { name: 'Проверить сохранённый запуск (1)', exact: true }).waitFor();
    assert.equal(await dashboard.locator('#rounds').isDisabled(), true);
    assert.equal(await dashboard.locator('#seconds-per-question').isDisabled(), true);
    assert.equal(await dashboard.locator('.quiz input').isDisabled(), true);
    const saved = await worker.evaluate(async () => (await chrome.storage.local.get('pendingJob:42'))['pendingJob:42']);
    assert.deepEqual(saved.quizIds, ['20']);
    assert.equal(saved.requestId, service.state().jobs[0].requestId);
    assert.equal(saved.secondsPerQuestion, 12);
    assert.equal(saved.userScope, '42', 'jobs use the service account rather than the browser account');
    assert.equal(lostReply, true);
    dropReplies = false;
    await waitDone(service);
    assert.equal(calls, 1);
    await dashboard.close();
    service.state().jobs[0].events.push({ at: new Date().toISOString(), kind: 'stage', stage: 'solving', tests: 11, total: 55,
      contextStatus: 'partial', contextTextChars: 900, contextMaterials: 2, contextReadyMaterials: 1, contextCacheHits: 1 });
    const reopened = await context.newPage();
    await reopened.goto(`chrome-extension://${new URL(worker.url()).hostname}/dashboard.html?user=43`);
    await reopened.locator('#job-title').filter({ hasText: 'Запуск завершён' }).waitFor();
    assert.equal(await reopened.locator('#seconds-per-question').inputValue(), '12');
    await reopened.locator('#nav-logs').click();
    assert.equal(await reopened.locator('#logs-view').isVisible(), true);
    assert.equal(await reopened.locator('.events li').count(), 4);
    await reopened.getByText('Решаю вопросы · 11 тестов · 55 всего вопросов · контекст partial: 1/2 материалов, 900 знаков, кэш 1', { exact: true }).waitFor();
    await reopened.evaluate(() => { navigator.clipboard.writeText = async text => { globalThis.copiedReport = text; }; });
    await reopened.locator('#copy-report').click();
    assert.match(await reopened.evaluate(() => globalThis.copiedReport), /Moodle Batch — отчёт запуска/);
    assert.match(await reopened.evaluate(() => globalThis.copiedReport), /Тест 20/);
    assert.match(await reopened.evaluate(() => globalThis.copiedReport), /контекст partial: 1\/2 материалов, 900 знаков, кэш 1/);
    assert.match(await reopened.evaluate(() => globalThis.copiedReport), /Минимальное время на вопрос: 12 сек\./);
    assert.match(await reopened.evaluate(() => globalThis.copiedReport), /Итоговая оценка в журнале Moodle: 90%/);
    assert.equal(await reopened.getByText('В журнале Moodle: 90%', { exact: true }).isVisible(), true);
    assert.match(await reopened.evaluate(() => globalThis.copiedReport), /Вопрос 1: memory; сохранённый ответ; Moodle: Верно/);
    assert.match(await reopened.evaluate(() => globalThis.copiedReport), /Отправлено: <img src=x onerror=alert\(1\)>/);
    assert.match(await reopened.evaluate(() => globalThis.copiedReport), /Уверенность модели: 92%/);
    assert.match(await reopened.evaluate(() => globalThis.copiedReport), /Связь цитат с ответом: проверена отдельно через Jev/);
    assert.match(await reopened.evaluate(() => globalThis.copiedReport), /Цитата: «The documented answer is A\.» · https:\/\/example.org\/reference/);
    await reopened.getByText('Проверка каждого вопроса Moodle', { exact: true }).click();
    assert.equal(await reopened.getByText('Вопрос 1: Верно · memory', { exact: true }).isVisible(), true);
    assert.equal(await reopened.getByText('Отправлено: <img src=x onerror=alert(1)>', { exact: true }).isVisible(), true);
    assert.equal(await reopened.locator('#jobs img').count(), 0, 'answers are rendered as text');
    service.state().jobs[0].results[0].unresolvedQuestions = [{ slot: '2', reason: 'model_uncertain', explanation: 'Источники подтверждают несколько вариантов.' }];
    await reopened.getByText('Вопрос 2: Модель не уверена в ответе · Источники подтверждают несколько вариантов.', { exact: true }).waitFor();
    await reopened.locator('#copy-report').click();
    assert.match(await reopened.evaluate(() => globalThis.copiedReport), /Источники подтверждают несколько вариантов\./);
    service.state().jobs[0].results[0].unresolvedQuestions = [];
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
    assert.equal(await worker.evaluate(async () => (await chrome.storage.local.get('pendingJob:42'))['pendingJob:42']), undefined);
    const start = service.start.bind(service);
    service.start = async () => { throw new Error('JOB_ALREADY_RUNNING'); };
    await reopened.locator('#run').click();
    await reopened.getByText('Другой запуск уже выполняется.', { exact: true }).waitFor();
    assert.equal(await worker.evaluate(async () => (await chrome.storage.local.get('pendingJob:42'))['pendingJob:42']), undefined,
      'a definitive rejection must not become a stale retry intent');
    assert.equal(await reopened.locator('#rounds').isDisabled(), false);
    service.start = start;
    const readState = service.state.bind(service);
    service.state = () => {
      const state = structuredClone(readState());
      const course = state.overview.courses[0];
      const quiz = course.quizzes[0];
      course.quizzes = [{ ...quiz, percent: 100, status: 'maximum' },
        { ...quiz, quizId: '21', percent: 95, status: 'excellent', activeAttempt: true, analysis: { conflict: 1 }, attemptUsage: { used: 2, allowed: 2, remaining: 0 } },
        { ...quiz, quizId: '22', percent: null, status: 'unattempted', error: 'START_UNAVAILABLE', attemptUsage: { used: 2, allowed: 2, remaining: 0 } }];
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
    await reopened.locator('#nav-issues').click();
    assert.equal(await reopened.locator('#page-title').textContent(), 'Требуют внимания');
    assert.equal(await reopened.locator('.quiz').count(), 2);
    const activeRow = reopened.locator('.quiz').filter({ has: reopened.locator('input[data-quiz="21"]') });
    const exhaustedRow = reopened.locator('.quiz').filter({ has: reopened.locator('input[data-quiz="22"]') });
    const coursePanel = activeRow.locator('xpath=ancestor::details');
    if (await coursePanel.getAttribute('open') !== '') await coursePanel.locator('summary').click();
    assert.match(await activeRow.textContent(), /Конфликтов в памяти: 1/);
    assert.equal(await activeRow.locator('.quiz-action').textContent(), 'Завершить попытку');
    assert.equal(await activeRow.locator('.quiz-action').isDisabled(), false, 'active attempt can finish with no new attempts left');
    assert.equal(await exhaustedRow.locator('.quiz-action').isDisabled(), true);
    await reopened.locator('#select').click();
    let directIntent;
    service.start = async intent => { directIntent = intent; throw new Error('JOB_ALREADY_RUNNING'); };
    await activeRow.locator('.quiz-action').click();
    await reopened.getByText('Другой запуск уже выполняется.', { exact: true }).waitFor();
    assert.deepEqual(directIntent.quizIds, ['21'], 'row action must ignore all other selected tests');
    assert.equal(directIntent.maxAttempts, 1);
    assert.equal(directIntent.secondsPerQuestion, 12);
    assert.equal(calls, 1);
    service.start = start;
    await reopened.locator('#nav-tests').click();
    assert.equal(await reopened.locator('.quiz').count(), 3);
    assert.equal(await page.locator('#responseform input').inputValue(), 'unchanged');
    service.state = () => {
      const state = structuredClone(readState());
      state.jobs[0].status = 'running';
      state.jobs[0].current = { stage: 'waiting', quizId: '20', round: 1, total: 20, minimumSeconds: 200,
        startedAt: Date.now() - 100000, readyAt: Date.now() + 100000, timingSource: 'first_seen' };
      return state;
    };
    await reopened.reload();
    await reopened.getByRole('heading', { name: 'Жду минимальное время попытки', exact: true }).waitFor();
    assert.match(await reopened.locator('#job-detail').textContent(), /минимум 3 мин\. 20 сек\..*прошло.*осталось.*первого обнаружения/u);
    assert.equal(await reopened.locator('#seconds-per-question').isDisabled(), true);
    service.state = () => {
      const state = structuredClone(readState());
      const detail = { stage: 'web_wait', provider: 'Web', reasoning: 'Medium', questions: 2, tests: 1,
        httpStatus: 429, retryAt: Date.now() + 60000 };
      state.jobs[0].status = 'running'; state.jobs[0].current = detail;
      state.jobs[0].events.push({ ...detail, kind: 'stage', at: new Date().toISOString() });
      return state;
    };
    await reopened.reload();
    await reopened.getByRole('heading', { name: 'Ожидаю доступ к ответу ChatGPT', exact: true }).waitFor();
    assert.match(await reopened.locator('#job-detail').textContent(), /ограничил частоту чтения.*HTTP 429.*следующая проверка через.*без повторной отправки/u);
    await reopened.locator('#nav-logs').click();
    await reopened.locator('#copy-report').click();
    assert.match(await reopened.locator('#log-export').inputValue(), /HTTP 429.*следующая проверка/u);
    await reopened.locator('#nav-tests').click();
    service.state = readState;
    assert.equal(sessionUpdates, 1, 'unchanged browser cookies are not reimported on every poll');
    service.session = async cookies => {
      assert.equal(cookies[0].value, 'synthetic-session-43');
      service.state = () => ({ ...readState(), userScope: '43', overview: { ...overview(), userScope: '43' }, jobs: [] });
      return { userScope: '43' };
    };
    await context.addCookies([{ name: 'MoodleSession', value: 'synthetic-session-43', url: scope.origin, httpOnly: true, secure: true }]);
    await reopened.reload();
    await reopened.locator('.quiz').waitFor({ state: 'attached' });
    await reopened.waitForFunction(() => document.getElementById('seconds-per-question').value === '10');
    assert.equal(await reopened.locator('#seconds-per-question').inputValue(), '10', 'timing settings belong to the selected account');
    assert.equal(await reopened.locator('#job-title').textContent(), 'Готов к запуску');
    await reopened.locator('#select').click();
    service.start = async intent => { directIntent = intent; throw new Error('JOB_ALREADY_RUNNING'); };
    await reopened.locator('#run').click();
    await reopened.getByText('Другой запуск уже выполняется.', { exact: true }).waitFor();
    assert.equal(directIntent.userScope, '43');
    service.state = readState; service.start = start;
  } finally { await context?.close(); if (server) await new Promise(done => server.close(done)); await service?.close(); await rm(root, { recursive: true, force: true }); }
});

test('batch errors become visible immediately with question reasons and are not logged twice', async () => {
  const root = await mkdtemp(join(tmpdir(), 'batch-errors-'));
  let service, release; const gate = new Promise(done => { release = done; });
  try {
    service = await openService({ ...deps(root), batchRunner: async (moodle, store, ids, options) => {
      const explanation = 'Недостаточно точная цитата. '.repeat(20);
      const error = new Error('UNRESOLVED_SUBMISSION'); error.unresolvedQuestions = [{ slot: '2', reason: 'source_quote_not_found', provider: 'gpt_web', explanation }];
      await options.onError('20', error); await gate;
      return [{ quizId: '20', error }];
    } });
    await service.start(input);
    while (!service.state().jobs[0].results[0]?.error) await new Promise(done => setTimeout(done, 5));
    assert.equal(service.state().jobs[0].status, 'running');
    assert.equal(service.state().jobs[0].results[0].unresolvedQuestions[0].reason, 'source_quote_not_found');
    assert.equal(service.state().jobs[0].results[0].unresolvedQuestions[0].explanation, 'Недостаточно точная цитата. '.repeat(20));
    release(); await waitDone(service);
    assert.equal(service.state().jobs[0].events.filter(e => e.kind === 'error').length, 1);
  } finally { release(); await service?.close(); await rm(root, { recursive: true, force: true }); }
});
