import { join } from 'node:path';
import { loadContext } from './context.js';
import { solveTest, pendingModelTests } from './solve.js';
import { startTest, startId, submitTest, submissionId, rememberAttemptStart } from './submit.js';

export async function prepareQuiz(moodle, store, quizId, { root, progress = async () => {}, stopped = () => false,
  contextLoader = loadContext, now = Date.now, importedReviews = {} } = {}) {
  const check = () => { if (stopped()) throw new Error('STOPPED'); };
  check();
  await progress('reading');
  const view = await moodle.read(`/mod/quiz/view.php?id=${quizId}`);
  const validate = page => {
    if (page.origin !== moodle.origin || page.userScope !== moodle.userScope || page.quizId !== quizId
        || page.courseId !== view.courseId) throw new Error('PAGE_SCOPE_MISMATCH');
  };
  validate(view);
  await progress('reading', { attemptUsage: view.attemptUsage, activeAttempt: Boolean(view.activeUrl || view.activeAttempt) });
  const imported = new Set(importedReviews[quizId] || []);
  for (const href of view.reviews) {
    check();
    if (imported.has(href) && href !== view.reviews.at(-1)) continue;
    const url = new URL(href); url.searchParams.set('showall', '1');
    const review = await moodle.collect(url.href);
    validate(review);
    if (review.kind !== 'review') throw new Error('REVIEW_PROVENANCE_REQUIRED');
    store.importReview(review.questions);
  }
  check();
  await progress('starting');
  const started = await startTest(moodle, view, join(root, 'operations', `${startId(view)}.json`));
  if (view.attemptUsage) {
    const used = view.attemptUsage.used == null ? null : view.attemptUsage.used + (view.activeUrl || view.activeAttempt ? 0 : 1);
    await progress('starting', { activeAttempt: true, attemptUsage: { ...view.attemptUsage, used,
      remaining: view.attemptUsage.allowed !== null && used !== null ? Math.max(0, view.attemptUsage.allowed - used) : null } });
  }
  check();
  const test = await moodle.collect(started.attemptUrl);
  validate(test);
  if (test.kind !== 'attempt' || !test.complete) throw new Error('ACTIVE_COMPLETE_ATTEMPT_REQUIRED');
  test.attemptTiming = await rememberAttemptStart(test, join(root, 'operations', `${submissionId(test)}.json.timing`),
    join(root, 'operations', `${startId(view)}.json`), now);
  await progress('context', { attemptId: test.attemptId, total: test.questions.length });
  const questions = test.questions.map(q => ({ ...q, memory: store.lookup(q) }));
  const context = questions.some(q => q.memory.status === 'unresolved')
    ? await contextLoader(moodle, view, join(root, 'materials'))
    : { status: 'skipped', reason: 'NO_UNRESOLVED_QUESTIONS', materials: [], text: '', contextHash: null };
  check();
  await progress('solving', { context: context.status });
  return { test, view, context, questions };
}

export async function finishQuiz(moodle, store, prepared, questions, { root, secondsPerQuestion = 0,
  progress = async () => {}, stopped = () => false, now, sleep } = {}) {
  const { test, view } = prepared;
  const quizId = test.quizId;
  if (stopped()) throw new Error('STOPPED');
  const validate = page => {
    if (page.origin !== moodle.origin || page.userScope !== moodle.userScope || page.quizId !== quizId
      || page.courseId !== view.courseId) throw new Error('PAGE_SCOPE_MISMATCH');
  };
  const submission = await submitTest(moodle, test, questions, join(root, 'operations', `${submissionId(test)}.json`),
    { secondsPerQuestion, progress, stopped, now, sleep });
  // Once submitted, always recover the review even when Stop arrives.
  await progress('verifying');
  const review = await moodle.collect(submission.reviewUrl);
  validate(review);
  if (review.kind !== 'review' || review.attemptId !== test.attemptId) throw new Error('PAGE_SCOPE_MISMATCH');
  store.importReview(review.questions);
  const grade = review.resultSummary.find(row => /^(?:Оценка|Grade)$/iu.test(row.label))?.value || null;
  const match = grade?.match(/(\d+(?:[.,]\d+)?)\s*%/u);
  const percent = match ? Number(match[1].replace(',', '.')) : null;
  let gradePercent = null;
  try { gradePercent = (await moodle.grades(view.courseId)).find(q => q.quizId === quizId)?.percent ?? null; }
  catch { /* preserve the attempt result when gradebook access is unavailable */ }
  const usage = view.attemptUsage;
  const used = usage?.used == null ? null : usage.used + (view.activeUrl || view.activeAttempt ? 0 : 1);
  const attemptUsage = usage ? { ...usage, used, remaining: usage.allowed !== null && used !== null ? Math.max(0, usage.allowed - used) : null } : null;
  return { quizId, courseId: view.courseId, attemptId: test.attemptId, reviewUrl: submission.reviewUrl, grade, percent, gradePercent, attemptUsage,
    total: review.questions.length, correct: review.questions.filter(q => q.feedback === 'correct').length,
    ...(submission.timing ? { timing: submission.timing } : {}),
    sources: questions.map(q => ({ slot: q.slot, provider: q.decision?.provider,
      ...(q.decision?.cached ? { cached: true } : {}),
      ...(q.decision?.reasoning ? { reasoning: q.decision.reasoning } : {}),
      feedback: review.questions.find(item => item.slot === q.slot)?.feedback,
      ...(q.type === 'multiple' ? { options: review.questions.find(item => item.slot === q.slot)?.options.filter(o => o.selected).map(o => ({ text: o.text, feedback: o.feedback })) || [] } : {}) })) };
}

export async function runQuiz(moodle, store, quizId, options = {}) {
  const prepared = await prepareQuiz(moodle, store, quizId, options);
  const questions = await (options.solve || solveTest)(prepared.questions, prepared.context,
    { journalDir: join(options.root, 'operations'), web: options.web, stopped: options.stopped, progress: options.progress });
  return finishQuiz(moodle, store, prepared, questions, options);
}

// One preparation/solve round across all selected tests; native submissions stay separate.
export async function runQuizzes(moodle, store, quizIds, options = {}) {
  const prepared = [], results = [];
  const finished = new Set();
  let finishing = Promise.resolve();
  const failed = async (quizId, error) => { results.push({ quizId, error }); await options.onError?.(quizId, error); };
  const progress = (quizId, stage, detail = {}) => options.progress?.(stage, { quizId, ...detail });
  const finish = (p, questions) => {
    const quizId = p.test.quizId;
    if (finished.has(quizId)) return Promise.resolve();
    finished.add(quizId);
    const task = finishing.then(async () => {
    if (options.stopped?.()) { await failed(quizId, new Error('STOPPED')); return; }
    try {
      const result = await finishQuiz(moodle, store, p, questions, { ...options, progress: (stage, detail) => progress(quizId, stage, detail) });
      results.push({ quizId, result });
      await options.onResult?.(result);
    } catch (error) { await failed(quizId, error); }
    });
    finishing = task.catch(() => {});
    return task;
  };
  for (const quizId of quizIds) {
    if (options.stopped?.()) break;
    try {
      const p = await prepareQuiz(moodle, store, quizId, { ...options, progress: (stage, detail) => progress(quizId, stage, detail) });
      const readyAt = p.test.attemptTiming.startedAt + (options.secondsPerQuestion || 0) * p.questions.length * 1000;
      if (p.questions.every(q => q.memory.status === 'known') && readyAt <= (options.now || Date.now)()) {
        await finish(p, await solveTest(p.questions, p.context, { stopped: options.stopped }));
      } else prepared.push(p);
    }
    catch (error) { await failed(quizId, error); }
  }
  // A pending request stops its own test, while other tests retain shared batching.
  const blocked = await pendingModelTests(prepared.flatMap(p => p.questions), join(options.root, 'operations'));
  for (const quizId of blocked) await failed(quizId, new Error('UNKNOWN_MODEL_OUTCOME'));
  const eligible = prepared.filter(p => !blocked.has(p.test.quizId));
  if (!eligible.length) return results;
  const byReadyTime = p => p.test.attemptTiming.startedAt + (options.secondsPerQuestion || 0) * p.questions.length * 1000;
  if (options.secondsPerQuestion) eligible.sort((a, b) => byReadyTime(a) - byReadyTime(b));
  const known = eligible.filter(p => p.questions.every(q => q.memory.status === 'known'));
  const unresolved = eligible.filter(p => !known.includes(p));
  const documents = Object.fromEntries(unresolved.map(p => [p.test.quizId, p.context]));
  const questions = unresolved.flatMap(p => p.questions.map(q => ({ ...q, nativeSlot: q.slot,
    slot: `${q.quizId}:${q.attemptId}:${q.slot}`, contextId: p.test.quizId })));
  // Model work and independent memory-only submissions overlap; every native POST stays serial.
  const pendingSolve = (async () => { try {
    if (!questions.length) return { solved: [] };
    if (options.stopped?.()) throw new Error('STOPPED');
    await options.progress?.('solving', { tests: unresolved.length, total: questions.length });
    return { solved: await (options.solve || solveTest)(questions, { documents },
      { journalDir: join(options.root, 'operations'), web: options.web, stopped: options.stopped, progress: options.progress,
        onAnswers: async answers => {
          for (const p of unresolved) {
            const native = answers.filter(q => q.quizId === p.test.quizId).map(({ nativeSlot, contextId, ...q }) => ({ ...q, slot: nativeSlot }));
            if (native.length === p.questions.length && native.every(q => ['candidate', 'confirmed'].includes(q.decision?.status))) await finish(p, native);
          }
        } }) };
  } catch (error) { return { error }; } })();
  for (const p of known) {
    try { await finish(p, await solveTest(p.questions, p.context, { stopped: options.stopped })); }
    catch (error) { await failed(p.test.quizId, error); }
  }
  const { solved, error } = await pendingSolve;
  if (error) {
    console.error('Moodle Batch solver:', error.name, String(error.message).split('\n')[0].slice(0, 180));
    for (const p of unresolved) if (!finished.has(p.test.quizId)) await failed(p.test.quizId, error);
    return results;
  }
  for (const p of unresolved) {
    const quizId = p.test.quizId;
    const native = solved.filter(q => q.quizId === quizId).map(({ nativeSlot, contextId, ...q }) => ({ ...q, slot: nativeSlot }));
    await finish(p, native);
  }
  return results;
}
