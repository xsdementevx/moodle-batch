import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cookieState, collectTest, openParser } from '../../batch/moodle.js';
import { openAnswers, optionId } from '../../batch/answers.js';

const source = 'https://moodle.example/mod/quiz/review.php?attempt=30&cmid=20';
const html = (content, kind = 'review') => `<!doctype html><body id="page-mod-quiz-${kind}" data-course-id="10" data-quiz-id="20" data-user-scope="u1">${content}</body>`;
const choice = (state = 'incorrect') => `<div class="que multichoice ${state}" id="question-100-1"><div class="formulation"><div class="qtext">Choose<br>a sample.</div><div class="answer"><div class="r0"><input type="radio" name="q100:1_answer" id="a" value="0" checked disabled aria-labelledby="label-a"><div id="label-a"><span class="answernumber">a.</span>Alpha</div></div><div class="r1"><input type="radio" name="q100:1_answer" id="b" value="1" disabled><label for="b"><span class="answernumber">b.</span>Beta</label></div></div><input name="q100:1_:sequencecheck" value="2"></div><input type="checkbox" name="q100:1_:flagged" checked><div class="rightanswer">Правильный ответ: Beta</div></div>`;

test('cookie exports are normalized locally and unrelated host cookies are excluded', () => {
  const cookie = { name: 'MoodleSession', value: 'synthetic', domain: 'moodle.example', sameSite: 'no_restriction', secure: true, expirationDate: 9999999999 };
  const state = cookieState([cookie, { ...cookie, domain: 'other.example' }], 'https://moodle.example');
  assert.equal(state.cookies.length, 1);
  assert.equal(state.cookies[0].sameSite, 'None');
  assert.equal(state.cookies[0].expires, 9999999999);
  assert.throws(() => cookieState({}, 'https://moodle.example'), /INVALID_COOKIE_FILE/);
});

test('offline parser retains feedback and stable choices, excludes flags, and blocks scripts', async () => {
  const parser = await openParser();
  const store = openAnswers(':memory:');
  try {
    const profile = '<body id="page-user-profile"><header class="page-context-header"><a id="message-user-button" data-userid="42"></a></header></body>';
    assert.equal(await parser.identify(profile), '42');
    await assert.rejects(parser.identify('<body id="page-user-profile"></body>'), /USER_SCOPE_UNAVAILABLE/);
    const accountPage = html(choice()).replace(' data-user-scope="u1"', '');
    assert.equal((await parser.parse(accountPage, source, '42')).userScope, '42');
    await assert.rejects(parser.parse(html(choice()), source, '42'), /PAGE_SCOPE_MISMATCH/);
    const result = await parser.parse(html(`<script>document.body.dataset.userScope='stolen'</script>${choice()}<a class="qnbutton" id="quiznavbutton1"></a>`), source);
    const q = result.questions[0];
    assert.equal(result.userScope, 'u1');
    assert.equal(q.text, 'Choose a sample.');
    assert.equal(q.type, 'choice');
    assert.equal(q.options.length, 2);
    assert.deepEqual(q.answer, [optionId('Alpha')]);
    assert.deepEqual(q.revealedAnswer, [optionId('Beta')]);
    store.importReview(result.questions);
    assert.deepEqual(store.lookup(q).answer, [optionId('Beta')]);
    assert.deepEqual(store.lookup(q).excludedAnswers, [[optionId('Alpha')]]);
    await assert.rejects(parser.parse(html(choice()), source.replace('cmid=20', 'cmid=99')), /PAGE_SCOPE_MISMATCH/);
    await assert.rejects(parser.parse('<body><form id="login"></form></body>', source), /LOGIN_REQUIRED/);
    const media = await parser.parse(html(choice('correct').replace('Choose<br>a sample.', '<img src="https://other.example/private.png">Sample')), source);
    assert.equal(store.lookup(media.questions[0]).status, 'unsupported');
    const active = await parser.parse(html(`<form id="responseform"><input name="attempt" value="30">${choice('correct')}</form>`, 'attempt'), source.replace('review.php', 'attempt.php'));
    assert.equal(active.questions[0].pageKind, 'attempt');
    assert.throws(() => store.importReview(active.questions), /REVIEW_PROVENANCE_REQUIRED/);
  } finally { store.close(); await parser.close(); }
});

test('collector follows all pages once and requires complete inventory and unchanged identity', async () => {
  const first = { kind: 'attempt', origin: 'https://moodle.example', userScope: 'u1', courseId: '10', quizId: '20', attemptId: '30',
    sourceUrl: 'https://moodle.example/mod/quiz/attempt.php?attempt=30&page=0', expectedSlots: ['1', '2'], questions: [{ slot: '1' }],
    pageUrls: ['https://moodle.example/mod/quiz/attempt.php?attempt=30&page=1'] };
  const second = { ...first, sourceUrl: first.pageUrls[0], questions: [{ slot: '2' }], pageUrls: [first.sourceUrl] };
  let calls = 0;
  const read = async url => { calls++; return url === first.sourceUrl ? first : second; };
  assert.equal((await collectTest(read, first.sourceUrl)).questions.length, 2);
  assert.equal(calls, 2);
  await assert.rejects(collectTest(async () => ({ ...first, pageUrls: [] }), first.sourceUrl), /INCOMPLETE_TEST/);
  await assert.rejects(collectTest(async url => url === first.sourceUrl ? first : { ...second, userScope: 'u2' }, first.sourceUrl), /PAGE_SCOPE_MISMATCH/);
  await assert.rejects(collectTest(async () => ({ ...first, expectedSlots: [] }), first.sourceUrl), /INCOMPLETE_TEST/);
});

test('revealed matching pairs retain punctuation and shuffled row numbers, reject incomplete or ambiguous feedback', async () => {
  const parser = await openParser();
  const store = openAnswers(':memory:');
  const rows = ['2.', '1.'].map((label, i) => `<tr><td class="text">${label}</td><td><select name="q100:1_sub${i}" disabled><option value="0">Choose</option><option value="1" selected>Alpha, beta</option><option value="2">Gamma → delta</option></select></td></tr>`).join('');
  const document = right => html(`<div class="que match partiallycorrect" id="question-100-1"><div class="qtext">Order events</div><table class="answer">${rows}</table><div class="rightanswer">Правильный ответ: ${right}</div></div>`);
  try {
    const q = (await parser.parse(document('2. → Gamma → delta, 1. → Alpha, beta'), source)).questions[0];
    const expected = { [q.rows[0].id]: optionId('Gamma → delta'), [q.rows[1].id]: optionId('Alpha, beta') };
    assert.deepEqual(q.revealedAnswer, expected);
    store.importReview([q]);
    assert.deepEqual(store.lookup(q).answer, expected);
    for (const right of ['2. → Gamma → delta', '1. → Alpha, beta, 2. → Gamma → delta', '2. → Unknown, 1. → Alpha, beta']) {
      assert.equal((await parser.parse(document(right), source)).questions[0].revealedAnswer, null);
    }
    const duplicate = document('2. → Gamma → delta, 1. → Alpha, beta').replaceAll('<option value="2">Gamma → delta</option>', '<option value="2">Gamma → delta</option><option value="3">Gamma → delta</option>');
    assert.equal((await parser.parse(duplicate, source)).questions[0].revealedAnswer, null);
  } finally { store.close(); await parser.close(); }
});
