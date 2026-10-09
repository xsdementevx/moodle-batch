import { join } from 'node:path';
import { loadContext } from './context.js';
import { solveTest } from './solve.js';
import { startTest, startId, submitTest, submissionId } from './submit.js';

export async function prepareQuiz(moodle, store, quizId, { root, progress = async () => {}, stopped = () => false,
  contextLoader = loadContext } = {}) {
  const check = () => { if (stopped()) throw new Error('STOPPED'); };
  check();
  await progress('reading');
  const view = await moodle.read(`/mod/quiz/view.php?id=${quizId}`);
  const validate = page => {
    if (page.origin !== moodle.origin || page.userScope !== moodle.userScope || page.quizId !== quizId
        || page.courseId !== view.courseId) throw new Error('PAGE_SCOPE_MISMATCH');
  };
  validate(view);
  for (const href of view.reviews) {
    check();
    const url = new URL(href); url.searchParams.set('showall', '1');
    const review = await moodle.collect(url.href);
    validate(review);
    if (review.kind !== 'review') throw new Error('REVIEW_PROVENANCE_REQUIRED');
    store.importReview(review.questions);
  }
  check();
  await progress('starting');
  const started = await startTest(moodle, view, join(root, 'operations', `${startId(view)}.json`));
  check();
  const test = await moodle.collect(started.attemptUrl);
  validate(test);
  if (test.kind !== 'attempt' || !test.complete) throw new Error('ACTIVE_COMPLETE_ATTEMPT_REQUIRED');
  await progress('context', { attemptId: test.attemptId, total: test.questions.length });
  const context = await contextLoader(moodle, view, join(root, 'materials'));
  check();
  await progress('solving', { context: context.status });
  return { test, view, context, questions: test.questions.map(q => ({ ...q, memory: store.lookup(q) })) };
}

export async function finishQuiz(moodle, store, prepared, questions, { root, progress = async () => {}, stopped = () => false } = {}) {
  const { test, view } = prepared;
  const quizId = test.quizId;
  if (stopped()) throw new Error('STOPPED');
  const validate = page => {
    if (page.origin !== moodle.origin || page.userScope !== moodle.userScope || page.quizId !== quizId
      || page.courseId !== view.courseId) throw new Error('PAGE_SCOPE_MISMATCH');
  };
  await progress('submitting');
  const submission = await submitTest(moodle, test, questions, join(root, 'operations', `${submissionId(test)}.json`));
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
  return { quizId, courseId: view.courseId, attemptId: test.attemptId, reviewUrl: submission.reviewUrl, grade, percent, gradePercent,
    total: review.questions.length, correct: review.questions.filter(q => q.feedback === 'correct').length,
    sources: questions.map(q => ({ slot: q.slot, provider: q.decision?.provider,
      ...(q.decision?.cached ? { cached: true } : {}),
      ...(q.decision?.reasoning ? { reasoning: q.decision.reasoning } : {}),
      feedback: review.questions.find(item => item.slot === q.slot)?.feedback })) };
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
  const progress = (quizId, stage, detail = {}) => options.progress?.(stage, { quizId, ...detail });
  for (const quizId of quizIds) {
    if (options.stopped?.()) break;
    try { prepared.push(await prepareQuiz(moodle, store, quizId, { ...options, progress: (stage, detail) => progress(quizId, stage, detail) })); }
    catch (error) { results.push({ quizId, error }); }
  }
  const documents = Object.fromEntries(prepared.map(p => [p.test.quizId, p.context]));
  const questions = prepared.flatMap(p => p.questions.map(q => ({ ...q, nativeSlot: q.slot,
    slot: `${q.quizId}:${q.attemptId}:${q.slot}`, contextId: p.test.quizId })));
  let solved;
  try {
    if (options.stopped?.()) throw new Error('STOPPED');
    await options.progress?.('solving', { tests: prepared.length, total: questions.length });
    solved = await (options.solve || solveTest)(questions, { documents },
      { journalDir: join(options.root, 'operations'), web: options.web, stopped: options.stopped, progress: options.progress });
  } catch (error) {
    console.error('Moodle Batch solver:', error.name, String(error.message).split('\n')[0].slice(0, 180));
    return [...results, ...prepared.map(p => ({ quizId: p.test.quizId, error }))];
  }
  for (const p of prepared) {
    const quizId = p.test.quizId;
    if (options.stopped?.()) { results.push({ quizId, error: new Error('STOPPED') }); continue; }
    try {
      const native = solved.filter(q => q.quizId === quizId).map(({ nativeSlot, contextId, ...q }) => ({ ...q, slot: nativeSlot }));
      const result = await finishQuiz(moodle, store, p, native, { ...options, progress: (stage, detail) => progress(quizId, stage, detail) });
      results.push({ quizId, result });
      await options.onResult?.(result);
    } catch (error) { results.push({ quizId, error }); }
  }
  return results;
}
