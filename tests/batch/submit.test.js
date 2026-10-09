import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest, optionId } from '../../batch/answers.js';
import { buildSubmission, submitTest, buildStart, startTest } from '../../batch/submit.js';
import { openParser, collectTest } from '../../batch/moodle.js';

function fixture() {
  const scope = { origin: 'https://moodle.example', userScope: 'u1', courseId: '10', quizId: '20', attemptId: '30' };
  const q = (slot, type) => ({ ...scope, slot, pageKind: 'attempt', text: `Question ${slot}`, type, options: [], rows: [],
    behaviour: 'deferredfeedback', sequenceFieldName: `q100:${slot}_:sequencecheck`, sequenceValue: '2',
    memory: { status: 'unresolved', excludedAnswers: [] } });
  const choice = q('1', 'choice');
  choice.options = ['Alpha', 'Beta'].map((text, i) => ({ id: optionId(text), text, value: String(i), fieldName: 'q100:1_answer' }));
  choice.decision = { status: 'candidate', answer: [choice.options[1].id] };
  const multiple = q('2', 'multiple');
  multiple.options = ['Alpha', 'Beta'].map((text, i) => ({ id: optionId(text), text, value: '1', fieldName: `q100:2_choice${i}` }));
  multiple.decision = { status: 'confirmed', answer: [multiple.options[0].id] };
  const matching = q('3', 'matching');
  const row = { text: 'Row', fieldName: 'q100:3_sub0', options: ['Alpha', 'Beta'].map((text, i) => ({ id: optionId(text), text, value: String(i + 1) })) };
  row.id = digest(['row-v1', row.text, row.options.map(o => o.text).sort()]);
  matching.rows = [row];
  matching.decision = { status: 'candidate', answer: { [row.id]: row.options[1].id } };
  const text = q('4', 'text');
  text.textFieldName = 'q100:4_answer';
  text.decision = { status: 'candidate', answer: 'Term' };
  return { ...scope, kind: 'attempt', complete: true, sourceUrl: `${scope.origin}/mod/quiz/attempt.php?attempt=30&cmid=20`,
    questions: [choice, multiple, matching, text], submissionForms: [{ method: 'post', action: `${scope.origin}/mod/quiz/processattempt.php?cmid=20`, sesskey: 'synthetic', slots: ['1', '2', '3', '4'] }] };
}

test('native start is explicit, reuses active attempt and blocks preflight and repeated uncertain requests', async () => {
  const attempt = fixture();
  const view = { ...attempt, kind: 'view', activeUrl: null, startForm: { method: 'post', action: `${attempt.origin}/mod/quiz/startattempt.php`,
    preflightRequired: false, fields: [['cmid', '20'], ['sesskey', 'synthetic']] } };
  assert.equal(buildStart(view).fields.cmid, '20');
  assert.throws(() => buildStart({ ...view, startForm: { ...view.startForm, preflightRequired: true } }), /PREFLIGHT_REQUIRED/);
  assert.throws(() => buildStart({ ...view, startForm: { ...view.startForm, fields: [...view.startForm.fields, ['forcenew', '1']] } }), /UNSUPPORTED_START_FORM/);
  const dir = await mkdtemp(join(tmpdir(), 'batch-start-'));
  try {
    let calls = 0;
    const moodle = { postStart: async () => { calls++; return { attemptUrl: attempt.sourceUrl }; } };
    const journal = join(dir, 'start.json');
    assert.equal((await startTest(moodle, view, journal)).attemptUrl, attempt.sourceUrl);
    await startTest(moodle, view, journal);
    assert.equal(calls, 1);
    await startTest({ postStart: () => assert.fail('must resume active attempt') }, { ...view, activeUrl: attempt.sourceUrl }, join(dir, 'unused.json'));
    const pending = join(dir, 'pending.json');
    await assert.rejects(startTest({ postStart: async () => { calls++; throw new Error('UNKNOWN_START_OUTCOME'); } }, view, pending), /UNKNOWN_START_OUTCOME/);
    await assert.rejects(startTest(moodle, view, pending), /UNKNOWN_START_OUTCOME/);
    assert.equal(calls, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('one final request maps stable answers to native fields and rejects unresolved, excluded or foreign data', () => {
  const attempt = fixture();
  const plan = buildSubmission(attempt, attempt.questions);
  assert.equal(plan.fields.finishattempt, '1');
  assert.equal(plan.fields.slots, '1,2,3,4');
  assert.equal(plan.fields['q100:1_answer'], '1');
  assert.equal(plan.fields['q100:2_choice0'], '1');
  assert.equal(plan.fields['q100:2_choice1'], '0');
  assert.equal(plan.fields['q100:3_sub0'], '2');
  assert.equal(plan.fields['q100:4_answer'], 'Term');
  assert.equal(plan.fields['q100:4_:sequencecheck'], '2');
  const rowBlocked = structuredClone(attempt);
  const row = rowBlocked.questions[2].rows[0];
  rowBlocked.questions[2].memory.matchingRows = { [row.id]: { answer: null, excludedAnswers: [row.options[1].id] } };
  assert.throws(() => buildSubmission(rowBlocked, rowBlocked.questions), /EXCLUDED_SUBMISSION_ANSWER/);
  rowBlocked.questions[2].memory.matchingRows[row.id] = { answer: row.options[0].id, excludedAnswers: [] };
  assert.throws(() => buildSubmission(rowBlocked, rowBlocked.questions), /EXCLUDED_SUBMISSION_ANSWER/);
  assert.throws(() => buildSubmission({ ...attempt, kind: 'review' }, attempt.questions), /ACTIVE_COMPLETE_ATTEMPT/);
  const bad = structuredClone(attempt);
  bad.questions[0].decision.status = 'needs_review';
  assert.throws(() => buildSubmission(bad, bad.questions), /UNRESOLVED/);
  bad.questions[0].decision.status = 'candidate';
  bad.questions[0].memory.excludedAnswers = [bad.questions[0].decision.answer];
  assert.throws(() => buildSubmission(bad, bad.questions), /EXCLUDED/);
  bad.questions[0].memory.excludedAnswers = [];
  bad.questions[0].options[1].fieldName = 'sesskey';
  assert.throws(() => buildSubmission(bad, bad.questions), /INVALID_RESPONSE_FIELD/);
  bad.submissionForms[0].action = 'https://other.example/mod/quiz/processattempt.php';
  assert.throws(() => buildSubmission(bad, bad.questions), /SUBMISSION_SCOPE/);
});

test('submit refreshes native controls, sends once, reuses completed response and blocks unknown outcome', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'batch-submit-'));
  try {
    const attempt = fixture();
    let posts = 0;
    const moodle = { collect: async () => structuredClone(attempt), postSubmission: async plan => {
      posts++;
      assert.equal(plan.fields.finishattempt, '1');
      return { reviewUrl: 'https://moodle.example/mod/quiz/review.php?attempt=30&cmid=20&showall=1' };
    } };
    const journal = join(dir, 'complete.json');
    const first = await submitTest(moodle, attempt, attempt.questions, journal);
    assert.deepEqual(await submitTest({ collect: () => assert.fail('no refresh'), postSubmission: () => assert.fail('no resend') }, attempt, attempt.questions, journal), first);
    assert.equal(posts, 1);
    await assert.rejects(submitTest({ ...moodle, postSubmission: async () => { posts++; throw new Error('UNKNOWN_SUBMISSION_OUTCOME'); } }, attempt, attempt.questions, join(dir, 'pending.json')), /UNKNOWN_SUBMISSION/);
    await assert.rejects(submitTest(moodle, attempt, attempt.questions, join(dir, 'pending.json')), /UNKNOWN_SUBMISSION/);
    assert.equal(posts, 2);
    const changed = structuredClone(attempt); changed.questions[0].sequenceValue = '3';
    await assert.rejects(submitTest({ ...moodle, collect: async () => changed }, attempt, attempt.questions, join(dir, 'changed.json')), /ATTEMPT_CHANGED/);
    assert.equal(posts, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('offline parser retains response form and deferred feedback for request preparation', async () => {
  const parser = await openParser();
  try {
    const attempt = fixture();
    const html = '<body id="page-mod-quiz-attempt" data-course-id="10" data-quiz-id="20" data-user-scope="u1">'
      + '<form id="responseform" method="post" action="/mod/quiz/processattempt.php?cmid=20"><input name="attempt" value="30"><input name="sesskey" value="synthetic"><input name="slots" value="1">'
      + '<div class="que shortanswer deferredfeedback" id="question-100-1"><div class="formulation"><div class="qtext">Question</div><input type="text" name="q100:1_answer"><input name="q100:1_:sequencecheck" value="2"></div></div></form><a class="qnbutton" id="quiznavbutton1"></a></body>';
    const parsed = await parser.parse(html, attempt.sourceUrl);
    const collected = await collectTest(async () => parsed, attempt.sourceUrl);
    const questions = collected.questions.map(q => ({ ...q, memory: { status: 'unresolved', excludedAnswers: [] }, decision: { status: 'candidate', answer: 'Term' } }));
    assert.equal(buildSubmission(collected, questions).fields['q100:1_answer'], 'Term');
    const viewHtml = '<body id="page-mod-quiz-view" data-course-id="10" data-quiz-id="20" data-user-scope="u1"><form method="post" action="/mod/quiz/startattempt.php"><input type="hidden" name="cmid" value="20"><input type="hidden" name="sesskey" value="synthetic"></form></body>';
    const view = await parser.parse(viewHtml, `${attempt.origin}/mod/quiz/view.php?id=20`);
    assert.equal(buildStart(view).fields.sesskey, 'synthetic');
  } finally { await parser.close(); }
});
