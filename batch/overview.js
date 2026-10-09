export const safeCode = error => /^[A-Z][A-Z_0-9]+$/u.test(error?.message || '') ? error.message
  : /^[A-Z][A-Z_0-9]+$/u.test(error?.code || '') ? error.code : 'LOCAL_OR_NETWORK_ERROR';

export async function mapConcurrent(items, limit, task) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 12) throw new Error('INVALID_CONCURRENCY');
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index], index);
    }
  }));
  return results;
}

export function gradeStatus(percent) {
  if (percent === null || !Number.isFinite(percent) || percent < 0 || percent > 100) return 'unknown';
  return percent >= 100 ? 'maximum' : percent >= 90 ? 'excellent' : 'retry';
}

export function courseSummary(quizzes) {
  const count = status => quizzes.filter(q => q.status === status).length;
  return { total: quizzes.length, maximum: count('maximum'), excellent: count('excellent'),
    retry: count('retry'), unattempted: count('unattempted'), unknown: count('unknown'),
    active: quizzes.filter(q => q.activeAttempt).length,
    checked: quizzes.filter(q => q.checked).length, errors: quizzes.filter(q => q.error || q.reviewError).length };
}

export async function scanOverview(moodle, store, { concurrency = 6, onProgress = () => {}, detailed = true, attemptsOnly = false, previous = null } = {}) {
  if (attemptsOnly) detailed = true;
  if (previous?.origin !== moodle.origin || previous?.userScope !== moodle.userScope) previous = null;
  const started = Date.now();
  const courses = await moodle.courses();
  const snapshot = { schemaVersion: 1, origin: moodle.origin, userScope: moodle.userScope,
    startedAt: new Date(started).toISOString(), status: 'loading', phase: 'courses', detailed, attemptsOnly,
    progress: { courses: 0, totalCourses: courses.length, tests: 0, totalTests: 0 }, courses: [] };
  onProgress(snapshot);
  snapshot.courses = courses.map(course => ({ ...course, quizzes: [], status: 'loading', summary: courseSummary([]) }));
  await mapConcurrent(snapshot.courses, concurrency, async course => {
    let grades = [];
    let refs = [];
    const old = previous?.courses.find(c => c.courseId === course.courseId);
    try { grades = await moodle.grades(course.courseId); }
    catch (error) { course.gradeError = safeCode(error); }
    // Show gradebook results before course discovery and detailed attempt checks finish.
    course.quizzes = grades.map(q => ({ ...q, topic: '', courseId: course.courseId,
      url: `${moodle.origin}/mod/quiz/view.php?id=${q.quizId}`, status: gradeStatus(q.percent), checked: false }));
    course.status = 'discovering'; course.summary = courseSummary(course.quizzes);
    onProgress(snapshot);
    try { refs = (!detailed || attemptsOnly) && old ? old.quizzes : await moodle.quizzes({ origin: moodle.origin, userScope: moodle.userScope, courseId: course.courseId }); }
    catch (error) { course.discoveryError = safeCode(error); }
    const combined = new Map(grades.map(q => [q.quizId, { ...q, topic: '' }]));
    for (const ref of refs) combined.set(ref.quizId, { ...ref, percent: combined.get(ref.quizId)?.percent ?? null });
    course.quizzes = [...combined.values()].map(q => ({ ...(!detailed || attemptsOnly ? old?.quizzes.find(prior => prior.quizId === q.quizId) : null), ...q, courseId: course.courseId,
      url: `${moodle.origin}/mod/quiz/view.php?id=${q.quizId}`, status: gradeStatus(q.percent), checked: false }));
    course.status = course.gradeError || course.discoveryError ? 'partial' : 'ready';
    course.summary = courseSummary(course.quizzes);
    snapshot.progress.courses++;
    snapshot.progress.totalTests += course.quizzes.length;
    onProgress(snapshot);
  });
  if (!detailed) {
    snapshot.phase = 'complete'; snapshot.completedAt = new Date().toISOString(); snapshot.elapsedMs = Date.now() - started;
    snapshot.status = snapshot.courses.some(c => c.status === 'partial') ? 'partial' : 'ready';
    snapshot.summary = courseSummary(snapshot.courses.flatMap(c => c.quizzes));
    onProgress(snapshot); return snapshot;
  }
  snapshot.phase = 'tests';
  onProgress(snapshot);
  const jobs = snapshot.courses.flatMap(course => course.quizzes.map(quiz => ({ course, quiz })));
  const latestReviews = new Map();
  await mapConcurrent(jobs, concurrency, async ({ course, quiz }) => {
    try {
      const view = await moodle.read(quiz.url);
      if (view.quizId !== quiz.quizId || view.courseId !== course.courseId || view.userScope !== moodle.userScope) throw new Error('PAGE_SCOPE_MISMATCH');
      quiz.activeAttempt = Boolean(view.activeUrl);
      quiz.canStart = Boolean(view.startForm);
      quiz.preflightRequired = Boolean(view.startForm?.preflightRequired);
      quiz.attempts = view.attemptSummaries.length;
      quiz.attemptUsage = view.attemptUsage || null;
      quiz.latestAttempt = view.attemptSummaries.at(-1) || null;
      quiz.detailCheckedAt = new Date().toISOString();
      if (quiz.percent === null && !quiz.attempts && !view.reviews.length && !quiz.activeAttempt) quiz.status = 'unattempted';
      if (!attemptsOnly) {
        let latest;
        const imported = new Set(previous?.courses.find(c => c.courseId === course.courseId)?.quizzes.find(q => q.quizId === quiz.quizId)?.importedReviews || []);
        quiz.importedReviews = [...imported];
        for (const href of [...new Set(view.reviews)]) {
          if (imported.has(href) && href !== view.reviews.at(-1)) continue;
          try {
            const url = new URL(href); url.searchParams.set('showall', '1');
            const review = await moodle.collect(url.href);
            if (review.kind !== 'review' || review.quizId !== quiz.quizId || review.courseId !== course.courseId
                || review.userScope !== moodle.userScope) throw new Error('PAGE_SCOPE_MISMATCH');
            store.importReview(review.questions);
            imported.add(href); quiz.importedReviews = [...imported];
            latest = review;
          } catch (error) { quiz.reviewError = safeCode(error); }
        }
        if (latest) latestReviews.set(quiz, latest);
      }
      quiz.checked = true;
    } catch (error) { quiz.error = safeCode(error); }
    snapshot.progress.tests++;
    course.summary = courseSummary(course.quizzes);
    onProgress(snapshot);
  });
  // Imports from another test in the same course may confirm shared question-bank answers.
  for (const [quiz, review] of latestReviews) {
    const states = review.questions.map(q => store.lookup(q));
    quiz.analysis = { total: states.length, attemptId: review.attemptId, known: states.filter(s => s.status === 'known').length,
      unresolved: states.filter(s => s.status === 'unresolved').length, conflict: states.filter(s => s.status === 'conflict').length,
      unsupported: states.filter(s => s.status === 'unsupported').length, withExclusions: states.filter(s => s.excludedAnswers.length).length };
  }
  snapshot.status = snapshot.courses.some(c => c.status === 'partial' || c.summary.errors) ? 'partial' : 'ready';
  snapshot.phase = 'complete';
  snapshot.completedAt = new Date().toISOString();
  snapshot.elapsedMs = Date.now() - started;
  snapshot.summary = courseSummary(snapshot.courses.flatMap(course => course.quizzes));
  snapshot.summary.courseErrors = snapshot.courses.filter(course => course.gradeError || course.discoveryError).length;
  onProgress(snapshot);
  return snapshot;
}
