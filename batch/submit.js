import { readFile } from 'node:fs/promises';
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
  try { return await checkpointed(journalPath, () => moodle.postStart(plan)); }
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
    if (!original || questionKey(original) !== questionKey(q) || q.attemptId !== test.attemptId || q.quizId !== test.quizId
        || q.userScope !== test.userScope || q.courseId !== test.courseId || q.origin !== test.origin) throw new Error('SUBMISSION_SCOPE_MISMATCH');
    if (q.behaviour !== 'deferredfeedback') throw new Error('UNSUPPORTED_QUESTION_BEHAVIOUR');
    if (['conflict', 'unsupported'].includes(q.memory?.status) || !['confirmed', 'candidate'].includes(q.decision?.status)) throw new Error('UNRESOLVED_SUBMISSION');
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

export async function submitTest(moodle, test, questions, journalPath) {
  // A completed POST can be followed by read-only review recovery; never resend a pending POST.
  try {
    const cached = JSON.parse(await readFile(journalPath, 'utf8'));
    if (cached.state === 'pending') throw new Error('UNKNOWN_SUBMISSION_OUTCOME');
    if (cached.state === 'complete') return cached.result;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const fresh = await moodle.collect(test.sourceUrl);
  const current = fresh.questions.map(q => {
    const solved = questions.find(old => old.slot === q.slot);
    if (!solved || questionKey(solved) !== questionKey(q) || solved.sequenceValue !== q.sequenceValue) throw new Error('ATTEMPT_CHANGED');
    return { ...q, decision: solved.decision, memory: solved.memory };
  });
  const plan = buildSubmission(fresh, current);
  try { return await checkpointed(journalPath, () => moodle.postSubmission(plan)); }
  catch (error) {
    if (error.message === 'UNKNOWN_MODEL_OUTCOME') throw new Error('UNKNOWN_SUBMISSION_OUTCOME');
    throw error;
  }
}

export const submissionId = test => digest(['moodle-submit-v1', test.origin, test.userScope, test.quizId, test.attemptId]);
