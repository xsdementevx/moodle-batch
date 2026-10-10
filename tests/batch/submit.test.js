import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest, optionId } from '../../batch/answers.js';
import { buildSubmission, submitTest, buildStart, startTest, rememberAttemptStart } from '../../batch/submit.js';
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

test('minimum attempt time uses question count, recorded start, durable resume and cancellable wait', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'batch-time-'));
  const attempt = fixture();
  let clock = 1_000_000, posts = 0, stopped = false;
  const now = () => clock;
  const events = [];
  const moodle = { collect: async () => attempt, postSubmission: async () => {
    posts++; assert.equal(clock, 1_040_000); return { reviewUrl: 'native-review' };
  } };
  const journal = join(dir, 'submit.json');
  try {
    const startJournal = join(dir, 'start.json');
    await writeFile(startJournal, JSON.stringify({ state: 'complete', result: { attemptUrl: attempt.sourceUrl, startedAt: clock } }));
    const recorded = await rememberAttemptStart(attempt, `${journal}.timing`, startJournal, now);
    clock += 5000; // Solving time is already part of the minimum, not added afterwards.
    assert.deepEqual(await rememberAttemptStart(attempt, `${journal}.timing`, undefined, now), recorded);
    const result = await submitTest(moodle, attempt, attempt.questions, journal, {
      secondsPerQuestion: 10, now, progress: (stage, detail) => events.push({ stage, ...detail }),
      sleep: async ms => { assert.equal(posts, 0); clock += ms; },
    });
    assert.equal(events[0].readyAt, 1_040_000);
    assert.equal(result.timing.minimumSeconds, 40);
    assert.equal(result.timing.elapsedSeconds, 40);
    assert.equal(posts, 1);
    await submitTest(moodle, attempt, attempt.questions, journal, { secondsPerQuestion: 10, sleep: () => assert.fail('completed POST must not wait or repeat') });
    assert.equal(posts, 1);
    // An older attempt requires no new delay; a different attempt gets its own first observation.
    const older = join(dir, 'older.json');
    await rememberAttemptStart(attempt, `${older}.timing`, startJournal, now);
    await submitTest(moodle, attempt, attempt.questions, older, { secondsPerQuestion: 10, now, sleep: () => assert.fail('old attempt is already due') });
    assert.equal(posts, 2);
    const resumeJournal = join(dir, 'resume.json');
    await writeFile(resumeJournal, JSON.stringify({ state: 'complete', result: {
      attemptUrl: attempt.sourceUrl, startedAt: 1_000_000, timingSource: 'first_seen',
    } }));
    assert.equal((await rememberAttemptStart(attempt, join(dir, 'resume.timing'), resumeJournal, now)).source, 'first_seen');
    const legacyJournal = join(dir, 'legacy.json');
    await writeFile(legacyJournal, JSON.stringify({ state: 'complete', result: { attemptUrl: attempt.sourceUrl } }));
    const legacy = await rememberAttemptStart(attempt, join(dir, 'legacy.timing'), legacyJournal, () => Date.now() + 10000);
    assert.equal(legacy.source, 'recorded_start');
    assert.ok(legacy.startedAt <= Date.now());
    const cancelled = join(dir, 'cancelled.json');
    await assert.rejects(submitTest({ collect: () => assert.fail('cancelled wait must not refresh or POST') }, attempt, attempt.questions, cancelled, {
      secondsPerQuestion: 10, now, stopped: () => stopped, sleep: async ms => { clock += ms; stopped = true; },
    }), /STOPPED/);
    await assert.rejects(submitTest(moodle, attempt, attempt.questions, join(dir, 'invalid.json'), { secondsPerQuestion: -1 }), /INVALID_MINIMUM_TIME/);
    await assert.rejects(rememberAttemptStart({ ...attempt, attemptId: '31' }, `${journal}.timing`, undefined, now), /INVALID_ATTEMPT_TIME/);
    const unresolved = structuredClone(attempt); unresolved.questions[0].decision = { status: 'needs_review' };
    await assert.rejects(submitTest(moodle, unresolved, unresolved.questions, join(dir, 'unresolved.json'), {
      secondsPerQuestion: 10, now, sleep: () => assert.fail('unresolved answer must fail without waiting'),
    }), /UNRESOLVED_SUBMISSION/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

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
  try { buildSubmission(bad, bad.questions); assert.fail('must stop unresolved answer'); }
  catch (error) { assert.equal(error.unresolvedQuestions[0].slot, '1'); assert.ok(error.unresolvedQuestions[0].reason); }
  bad.questions[0].decision.status = 'candidate';
  bad.questions[0].memory.excludedAnswers = [bad.questions[0].decision.answer];
  assert.throws(() => buildSubmission(bad, bad.questions), /EXCLUDED/);
  bad.questions[0].memory.excludedAnswers = [];
  bad.questions[0].options[1].fieldName = 'sesskey';
  assert.throws(() => buildSubmission(bad, bad.questions), /INVALID_RESPONSE_FIELD/);
  bad.submissionForms[0].action = 'https://other.example/mod/quiz/processattempt.php';
  assert.throws(() => buildSubmission(bad, bad.questions), /SUBMISSION_SCOPE/);
});

test('media submissions require confirmed memory and unchanged native bank identity', () => {
  const attempt = fixture();
  const q = attempt.questions[0];
  q.unsupportedReason = 'MEDIA_REQUIRES_EXTRACTION'; q.bankQuestionId = '101';
  q.memory = { status: 'known', answer: q.decision.answer, excludedAnswers: [] };
  assert.throws(() => buildSubmission(attempt, attempt.questions), /UNRESOLVED_SUBMISSION/);
  q.decision = { ...q.decision, status: 'confirmed', provider: 'memory' };
  assert.equal(buildSubmission(attempt, attempt.questions).fields['q100:1_answer'], '1');
  const foreign = structuredClone(attempt.questions); foreign[0].bankQuestionId = '102';
  assert.throws(() => buildSubmission(attempt, foreign), /SUBMISSION_SCOPE_MISMATCH/);
});

test('adaptive without penalties finishes with responses and no per-question check actions', () => {
  const attempt = fixture();
  for (const q of attempt.questions) q.behaviour = 'adaptivenopenalty';
  const plan = buildSubmission(attempt, attempt.questions);
  assert.equal(plan.fields.finishattempt, '1');
  assert.equal(plan.fields['q100:1_answer'], '1');
  assert.equal(plan.fields['q100:3_sub0'], '2');
  assert.ok(!Object.keys(plan.fields).some(name => name.endsWith('-submit')));
  attempt.questions[0].behaviour = 'interactive';
  assert.throws(() => buildSubmission(attempt, attempt.questions), /UNSUPPORTED_QUESTION_BEHAVIOUR/);
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
    const identified = structuredClone(attempt); identified.questions[0].bankQuestionId = '101';
    const swapped = structuredClone(identified); swapped.questions[0].bankQuestionId = '102';
    await assert.rejects(submitTest({ ...moodle, collect: async () => swapped }, identified, identified.questions,
      join(dir, 'changed-native.json')), /ATTEMPT_CHANGED/);
    assert.equal(posts, 2, 'a changed native question ID must block even with identical text and sequence');
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
    const adaptive = await parser.parse(html.replace('shortanswer deferredfeedback', 'shortanswer adaptivenopenalty'), attempt.sourceUrl);
    assert.equal(adaptive.questions[0].behaviour, 'adaptivenopenalty');
    const viewHtml = '<body id="page-mod-quiz-view" data-course-id="10" data-quiz-id="20" data-user-scope="u1"><form method="post" action="/mod/quiz/startattempt.php"><input type="hidden" name="cmid" value="20"><input type="hidden" name="sesskey" value="synthetic"></form></body>';
    const view = await parser.parse(viewHtml, `${attempt.origin}/mod/quiz/view.php?id=20`);
    assert.equal(buildStart(view).fields.sesskey, 'synthetic');
    const preflight = viewHtml.replace('</body>', '<form method="post" action="/mod/quiz/startattempt.php"><input type="hidden" name="cmid" value="20"><input type="hidden" name="sesskey" value="synthetic"><input type="hidden" name="_qf__mod_quiz_preflight_check_form" value="1"></form></body>');
    const gated = await parser.parse(preflight, `${attempt.origin}/mod/quiz/view.php?id=20`);
    assert.equal(gated.startForm.fields.length, 2);
    assert.throws(() => buildStart(gated), /MOODLE_PREFLIGHT_REQUIRED/);
    const resume = await parser.parse(preflight.replace('</body>', '<form method="get" action="/mod/quiz/attempt.php"><input type="hidden" name="attempt" value="30"></form></body>'), `${attempt.origin}/mod/quiz/view.php?id=20`);
    assert.equal(new URL(resume.activeUrl).searchParams.get('attempt'), '30');
  } finally { await parser.close(); }
});
