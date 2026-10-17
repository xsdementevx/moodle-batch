import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { digest, questionKey, isExcludedAnswer } from './answers.js';
import { checkpointed } from './solve.js';

export function buildStart(view) {
  const form = view.startForm;
  if (view.kind !== 'view' || view.activeUrl || !form || form.method !== 'post') throw new Error('START_UNAVAILABLE');
  if (form.preflightRequired) throw new Error('MOODLE_PREFLIGHT_REQUIRED');
  const url = new URL(form.action);
  if (url.origin !== view.origin || url.pathname !== '/mod/quiz/startattempt.php' || url.username || url.password
      || [...url.searchParams.keys()].some(key => key !== 'cmid')
      || (url.searchParams.has('cmid') && url.searchParams.get('cmid') !== view.quizId)) throw new Error('START_SCOPE_MISMATCH');
  const fields = Object.fromEntries(form.fields);
  if (Object.keys(fields).length !== form.fields.length || !fields.sesskey || fields.cmid !== view.quizId
      || Object.keys(fields).some(key => !['cmid', 'sesskey', 'forcenew'].includes(key))
      || (fields.forcenew && fields.forcenew !== '0')) throw new Error('UNSUPPORTED_START_FORM');
  return { url: url.href, fields };
}

export async function startTest(moodle, view, journalPath) {
  if (view.activeUrl) return { attemptUrl: view.activeUrl };
  const plan = buildStart(view);
  try { return await checkpointed(journalPath, async () => ({ ...await moodle.postStart(plan), startedAt: Date.now(),
    timingSource: view.activeAttempt ? 'first_seen' : 'recorded_start' })); }
  catch (error) {
    if (error.message === 'UNKNOWN_MODEL_OUTCOME') throw new Error('UNKNOWN_START_OUTCOME');
    throw error;
  }
}

export const startId = view => digest(['moodle-start-v1', view.origin, view.userScope, view.quizId, [...view.reviews].sort()]);

export function buildSubmission(test, questions) {
  if (test.kind !== 'attempt' || !test.complete || !questions.length || questions.length !== test.questions.length
      || new Set(questions.map(q => q.slot)).size !== questions.length) throw new Error('ACTIVE_COMPLETE_ATTEMPT_REQUIRED');
  const forms = test.submissionForms || [];
  const sesskey = forms[0]?.sesskey;
  const slots = forms.flatMap(form => form.slots);
  if (!sesskey || forms.some(form => form.method !== 'post' || form.sesskey !== sesskey)
      || slots.length !== questions.length || new Set(slots).size !== slots.length
      || questions.some(q => !slots.includes(q.slot))) throw new Error('SUBMISSION_FORM_INCOMPLETE');
  for (const form of forms) {
    const url = new URL(form.action);
    if (url.origin !== test.origin || url.pathname !== '/mod/quiz/processattempt.php' || url.username || url.password
        || (url.searchParams.has('cmid') && url.searchParams.get('cmid') !== test.quizId)) throw new Error('SUBMISSION_SCOPE_MISMATCH');
  }
  const fields = Object.create(null);
  Object.assign(fields, { attempt: test.attemptId, cmid: test.quizId, sesskey, slots: slots.join(','),
    thispage: '0', nextpage: '-1', finishattempt: '1', timeup: '0', scrollpos: '' });
  const put = (name, value, prefix) => {
    if (!name?.startsWith(prefix) || Object.hasOwn(fields, name) || value === null || value === undefined) throw new Error('INVALID_RESPONSE_FIELD');
    fields[name] = String(value);
  };
  for (const q of questions) {
    const original = test.questions.find(question => question.slot === q.slot);
    if (!original || questionKey(original) !== questionKey(q) || original.bankQuestionId !== q.bankQuestionId
        || q.attemptId !== test.attemptId || q.quizId !== test.quizId
        || q.userScope !== test.userScope || q.courseId !== test.courseId || q.origin !== test.origin) throw new Error('SUBMISSION_SCOPE_MISMATCH');
    if (!['deferredfeedback', 'adaptivenopenalty'].includes(q.behaviour)) throw new Error('UNSUPPORTED_QUESTION_BEHAVIOUR');
    if (['conflict', 'unsupported'].includes(q.memory?.status) || !['confirmed', 'candidate'].includes(q.decision?.status)) {
      const error = new Error('UNRESOLVED_SUBMISSION');
      error.unresolvedQuestions = questions.filter(item => ['conflict', 'unsupported'].includes(item.memory?.status)
        || !['confirmed', 'candidate'].includes(item.decision?.status)).map(item => ({ slot: item.slot,
        reason: item.decision?.reviewReason || item.memory?.status || 'unresolved', provider: item.decision?.provider || null,
        ...(item.decision?.reviewExplanation ? { explanation: item.decision.reviewExplanation } : {}),
        ...(Number.isFinite(item.decision?.confidence) ? { confidence: item.decision.confidence } : {}),
        ...(Array.isArray(item.decision?.semanticFailures) ? { semanticFailures: item.decision.semanticFailures } : {}) }));
      throw error;
    }
    if (q.unsupportedReason && (q.memory?.status !== 'known' || q.decision.status !== 'confirmed'
        || q.decision.provider !== 'memory')) throw new Error('UNRESOLVED_SUBMISSION');
    if (isExcludedAnswer(q, q.decision.answer)) throw new Error('EXCLUDED_SUBMISSION_ANSWER');
    const sequence = /^q(\d+):(\d+)_:sequencecheck$/u.exec(q.sequenceFieldName || '');
    if (!sequence || sequence[2] !== q.slot || !/^\d+$/u.test(q.sequenceValue || '')) throw new Error('INVALID_SEQUENCE_CHECK');
    const prefix = `q${sequence[1]}:${q.slot}_`;
    put(q.sequenceFieldName, q.sequenceValue, prefix);
    if (q.type === 'text') put(q.textFieldName, q.decision.answer, prefix);
    else if (q.type === 'matching') {
      for (const row of q.rows) put(row.fieldName, row.options.find(o => o.id === q.decision.answer[row.id]).value, prefix);
    } else if (q.type === 'choice') {
      const selected = q.options.find(o => o.id === q.decision.answer[0]);
      if (new Set(q.options.map(o => o.fieldName)).size !== 1) throw new Error('INVALID_RESPONSE_FIELD');
      put(selected.fieldName, selected.value, prefix);
    } else if (q.type === 'multiple') {
      for (const option of q.options) put(option.fieldName, q.decision.answer.includes(option.id) ? option.value : '0', prefix);
    } else throw new Error('UNSUPPORTED_QUESTION');
  }
  return { url: `${test.origin}/mod/quiz/processattempt.php?cmid=${test.quizId}`, fields };
}

export async function rememberAttemptStart(test, path, startJournalPath, now = Date.now) {
  const scope = submissionId(test);
  try {
    const saved = JSON.parse(await readFile(path, 'utf8'));
    if (saved.scope !== scope || !Number.isFinite(saved.startedAt) || saved.startedAt <= 0
        || !['recorded_start', 'first_seen'].includes(saved.source)) throw new Error('INVALID_ATTEMPT_TIME');
    return saved;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let startedAt = now(), source = 'first_seen';
  if (startJournalPath) {
    try {
      const journal = JSON.parse(await readFile(startJournalPath, 'utf8'));
      if (journal.state === 'complete' && journal.result?.attemptUrl) {
        const url = new URL(journal.result.attemptUrl);
        if (url.origin === test.origin && url.searchParams.get('attempt') === test.attemptId
            && url.searchParams.get('cmid') === test.quizId) {
          const timestamp = journal.result.startedAt ?? (await stat(startJournalPath)).mtimeMs;
          if (Number.isFinite(timestamp) && timestamp > 0 && timestamp <= startedAt) {
            startedAt = timestamp; source = journal.result.timingSource === 'first_seen' ? 'first_seen' : 'recorded_start';
          }
        }
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const saved = { scope, startedAt, source };
  await mkdir(dirname(path), { recursive: true });
  try { await writeFile(path, JSON.stringify(saved), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; return rememberAttemptStart(test, path, startJournalPath, now); }
  return saved;
}

export async function submitTest(moodle, test, questions, journalPath, { secondsPerQuestion = 0,
  progress = async () => {}, stopped = () => false, now = Date.now,
  sleep = ms => new Promise(done => setTimeout(done, ms)) } = {}) {
  if (!Number.isInteger(secondsPerQuestion) || secondsPerQuestion < 0 || secondsPerQuestion > 600) throw new Error('INVALID_MINIMUM_TIME');
  // A completed POST can be followed by read-only review recovery; never resend a pending POST.
  try {
    const cached = JSON.parse(await readFile(journalPath, 'utf8'));
    if (cached.state === 'pending') throw new Error('UNKNOWN_SUBMISSION_OUTCOME');
    if (cached.state === 'complete') return cached.result;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  buildSubmission(test, questions); // Unresolved answers must fail before any wait.
  const recorded = await rememberAttemptStart(test, `${journalPath}.timing`, undefined, now);
  const minimumSeconds = test.questions.length * secondsPerQuestion;
  const readyAt = recorded.startedAt + minimumSeconds * 1000;
  if (stopped()) throw new Error('STOPPED');
  if (now() < readyAt) await progress('waiting', { attemptId: test.attemptId, total: test.questions.length,
    startedAt: recorded.startedAt, readyAt, minimumSeconds, secondsPerQuestion, timingSource: recorded.source });
  while (now() < readyAt) {
    if (stopped()) throw new Error('STOPPED');
    await sleep(Math.min(1000, readyAt - now()));
  }
  if (stopped()) throw new Error('STOPPED');
  const fresh = await moodle.collect(test.sourceUrl);
  const current = fresh.questions.map(q => {
    const solved = questions.find(old => old.slot === q.slot);
    if (!solved || questionKey(solved) !== questionKey(q) || solved.bankQuestionId !== q.bankQuestionId
        || solved.sequenceValue !== q.sequenceValue) throw new Error('ATTEMPT_CHANGED');
    return { ...q, decision: solved.decision, memory: solved.memory };
  });
  const plan = buildSubmission(fresh, current);
  await progress('submitting');
  if (stopped()) throw new Error('STOPPED');
  try { return await checkpointed(journalPath, async () => {
    const submittedAt = now();
    return { ...await moodle.postSubmission(plan), timing: { ...recorded, minimumSeconds, secondsPerQuestion,
      submittedAt, elapsedSeconds: (submittedAt - recorded.startedAt) / 1000 } };
  }); }
  catch (error) {
    if (error.message === 'UNKNOWN_MODEL_OUTCOME') throw new Error('UNKNOWN_SUBMISSION_OUTCOME');
    throw error;
  }
}

export const submissionId = test => digest(['moodle-submit-v1', test.origin, test.userScope, test.quizId, test.attemptId]);
