import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest, openAnswers, optionId, questionKey, answerSignature, isExcludedAnswer } from '../../batch/answers.js';

const options = ['Alpha', 'Beta', 'Gamma'].map(text => ({ text, id: optionId(text) }));
const question = (extra = {}) => ({ origin: 'https://moodle.example', userScope: 'u1', courseId: '10', quizId: '20',
  attemptId: '30', slot: '1', pageKind: 'review', sourceUrl: 'https://moodle.example/mod/quiz/review.php?attempt=30&cmid=20',
  type: 'choice', text: 'Choose a sample answer.', options, rows: [], answer: [options[0].id], feedback: 'correct', ...extra });

test('full Moodle marks do not override explicit wrong options or classify untouched options', () => {
  const store = openAnswers(':memory:');
  const q = question({ type: 'multiple', answer: [options[0].id, options[1].id],
    options: options.map((o, i) => ({ ...o, selected: i < 2, feedback: i === 0 ? 'correct' : i === 1 ? 'incorrect' : 'unconfirmed' })) });
  try {
    store.importReview([q]);
    const memory = store.lookup(q);
    assert.equal(memory.status, 'unresolved');
    assert.deepEqual(memory.multipleOptions, { [options[0].id]: true, [options[1].id]: false });
    assert.equal(Object.hasOwn(memory.multipleOptions, options[2].id), false);
    assert.equal(isExcludedAnswer({ ...q, memory }, q.answer), true);
    const accepted = { ...q, attemptId: '31', sourceUrl: q.sourceUrl.replace('attempt=30', 'attempt=31'),
      answer: [options[0].id], options: q.options.map((o, i) => ({ ...o, selected: i === 0, feedback: i === 0 ? 'correct' : 'unconfirmed' })) };
    store.importReview([accepted]);
    assert.equal(store.lookup(q).status, 'known');
    assert.deepEqual(store.lookup(q).answer, accepted.answer);
    assert.equal(Object.hasOwn(store.lookup(q).multipleOptions, options[2].id), false);
  } finally { store.close(); }
});

test('different fully accepted multiple sets reuse an observed set without inferring option exclusions', () => {
  const store = openAnswers(':memory:');
  const q = question({ type: 'multiple', answer: [options[0].id, options[1].id] });
  try {
    store.importReview([q, { ...q, attemptId: '31', sourceUrl: q.sourceUrl.replace('attempt=30', 'attempt=31'), answer: [options[0].id] }]);
    const memory = store.lookup(q);
    assert.equal(memory.status, 'known');
    assert.deepEqual(memory.answer, [options[0].id]);
    assert.equal(memory.multipleOptions, undefined);
    assert.equal(isExcludedAnswer({ ...q, memory }, q.answer), false);
    store.importReview([{ ...q, attemptId: '32', sourceUrl: q.sourceUrl.replace('attempt=30', 'attempt=32'), feedback: 'incorrect' }]);
    assert.equal(store.lookup(q).status, 'conflict');
  } finally { store.close(); }
});

test('multiple option memory excludes explicit wrong choices, preserves required choices and detects conflicts', () => {
  const store = openAnswers(':memory:');
  const q = question({ type: 'multiple', feedback: 'partiallycorrect', answer: [options[0].id, options[1].id],
    options: options.map((o, i) => ({ ...o, selected: i < 2, feedback: i === 0 ? 'correct' : i === 1 ? 'incorrect' : 'unconfirmed' })) });
  try {
    store.importReview([q]);
    const memory = store.lookup(q);
    assert.equal(memory.status, 'unresolved');
    assert.equal(isExcludedAnswer({ ...q, memory }, [options[0].id]), false);
    assert.equal(isExcludedAnswer({ ...q, memory }, [options[0].id, options[2].id]), false);
    assert.equal(isExcludedAnswer({ ...q, memory }, [options[2].id]), true);
    assert.equal(isExcludedAnswer({ ...q, memory }, [options[0].id, options[1].id, options[2].id]), true);
    const next = { ...q, attemptId: '31', sourceUrl: q.sourceUrl.replace('attempt=30', 'attempt=31'), answer: [options[2].id],
      options: q.options.map((o, i) => ({ ...o, selected: i === 2, feedback: i === 2 ? 'incorrect' : 'unconfirmed' })) };
    store.importReview([next]);
    const known = store.lookup({ ...q, options: [...q.options].reverse() });
    assert.equal(known.status, 'known');
    assert.deepEqual(known.answer, [options[0].id]);
    store.importReview([{ ...next, attemptId: '32', sourceUrl: q.sourceUrl.replace('attempt=30', 'attempt=32'), answer: [options[1].id],
      options: q.options.map((o, i) => ({ ...o, selected: i === 1, feedback: i === 1 ? 'correct' : 'unconfirmed' })) }]);
    assert.equal(store.lookup(q).status, 'conflict');
  } finally { store.close(); }
});

test('matching row observations survive hidden feedback, aggregate across attempts and reject conflicts', () => {
  const store = openAnswers(':memory:');
  const rowOptions = options.map((o, i) => ({ ...o, value: String(i + 1) }));
  const rows = ['First', 'Second'].map((text, i) => ({ text, id: digest(['row-v1', text, options.map(o => o.text).sort()]),
    options: rowOptions, selectedValue: '1', feedback: i ? 'incorrect' : 'correct' }));
  const answer = Object.fromEntries(rows.map(row => [row.id, options[0].id]));
  const q = question({ type: 'matching', options: [], rows, answer, feedback: 'partiallycorrect' });
  try {
    store.importReview([q]);
    const memory = store.lookup(q);
    assert.equal(memory.status, 'unresolved');
    assert.equal(memory.matchingRows[rows[0].id].answer, options[0].id);
    assert.deepEqual(memory.matchingRows[rows[1].id].excludedAnswers, [options[0].id]);
    const blocked = { ...answer, [rows[0].id]: options[1].id, [rows[1].id]: options[2].id };
    assert.equal(isExcludedAnswer({ ...q, memory }, blocked), true);
    assert.equal(isExcludedAnswer({ ...q, memory }, { ...answer, [rows[1].id]: options[1].id }), false);
    store.importReview([{ ...q, feedback: 'unconfirmed', rows: rows.map(r => ({ ...r, feedback: 'unconfirmed' })) }]);
    assert.deepEqual(store.lookup(q).matchingRows, memory.matchingRows);
    const next = { ...q, attemptId: '31', sourceUrl: q.sourceUrl.replace('attempt=30', 'attempt=31'),
      rows: rows.map((r, i) => ({ ...r, selectedValue: i ? '2' : '1', feedback: i ? 'correct' : 'unconfirmed' })),
      answer: { ...answer, [rows[1].id]: options[1].id }, feedback: 'unconfirmed' };
    store.importReview([next]);
    assert.equal(store.lookup({ ...q, rows: [...rows].reverse() }).status, 'known');
    assert.deepEqual(store.lookup(q).answer, next.answer);
    store.importReview([{ ...next, attemptId: '32', sourceUrl: q.sourceUrl.replace('attempt=30', 'attempt=32'),
      rows: next.rows.map(r => ({ ...r, feedback: 'incorrect' })) }]);
    assert.equal(store.lookup(q).status, 'conflict');
    assert.equal(store.lookup(q).answer, null);
  } finally { store.close(); }
});

test('duplicate wrong choice labels allow a unique answer; selecting an ambiguous label is rejected', () => {
  const store = openAnswers(':memory:');
  try {
    const q = question({ options: [options[0], options[0], options[1]], answer: [options[1].id] });
    store.importReview([q]);
    assert.equal(store.lookup(q).status, 'known');
    assert.deepEqual(store.lookup(q).answer, [options[1].id]);
    assert.equal(questionKey(q), questionKey({ ...q, options: [...q.options].reverse() }));
    assert.throws(() => answerSignature(q, [options[0].id]), /INVALID_ANSWER/);
    assert.equal(store.importReview([{ ...q, answer: [options[0].id] }]).skipped, 1);
    assert.equal(store.lookup({ ...q, type: 'multiple' }).status, 'unsupported');
  } finally { store.close(); }
});

test('persistent cache reuses answers after option reorder and reimport, with scope isolation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'batch-answers-'));
  let store;
  try {
    store = openAnswers(join(dir, 'answers.sqlite'));
    assert.equal(store.importReview([question()]).total, 1);
    assert.equal(store.importReview([question()]).total, 1);
    store.close(); store = openAnswers(join(dir, 'answers.sqlite'));
    const reordered = question({ options: [...options].reverse(), attemptId: '999' });
    assert.equal(questionKey(reordered), questionKey(question()));
    assert.deepEqual(store.lookup(reordered).answer, [optionId('Alpha')]);
    for (const change of [{ text: 'Different?' }, { userScope: 'u2' }, { courseId: '11' }, { contextHash: 'new-material' },
      { options: options.map(o => o.text === 'Gamma' ? { text: 'Delta', id: optionId('Delta') } : o) }]) {
      assert.equal(store.lookup(question(change)).status, 'unresolved');
    }
  } finally { store?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('wrong and partial multiple answers exclude whole combinations; revealed answer can be retained', () => {
  const store = openAnswers(':memory:');
  try {
    const q = question({ type: 'multiple', answer: [options[0].id, options[1].id], feedback: 'partiallycorrect', revealedAnswer: [options[0].id, options[2].id] });
    store.importReview([q]);
    const result = store.lookup(q);
    assert.equal(result.status, 'known');
    assert.deepEqual(result.answer, [...q.revealedAnswer].sort());
    assert.deepEqual(result.excludedAnswers, [[...q.answer].sort()]);
    assert.equal(result.excludedAnswers.length, 1);
    const wrong = question({ answer: [options[1].id], feedback: 'incorrect' });
    store.importReview([wrong]);
    assert.deepEqual(store.lookup(wrong).excludedAnswers, [[options[1].id]]);
    assert.equal(store.lookup(wrong).status, 'unresolved');
  } finally { store.close(); }
});

test('contradictory feedback and unconfirmed candidates never become known answers', () => {
  const store = openAnswers(':memory:');
  try {
    store.importReview([question({ feedback: 'unconfirmed' })]);
    assert.equal(store.lookup(question()).status, 'unresolved');
    store.importReview([question()]);
    const otherAttempt = extra => question({ attemptId: '31', sourceUrl: 'https://moodle.example/mod/quiz/review.php?attempt=31&cmid=20', ...extra });
    store.importReview([otherAttempt({ answer: [options[1].id] })]);
    assert.equal(store.lookup(question()).status, 'conflict');
    assert.equal(store.lookup(question()).answer, null);
    store.importReview([otherAttempt({ answer: [options[0].id], feedback: 'incorrect' })]);
    assert.equal(store.lookup(question()).status, 'conflict');
    assert.deepEqual(store.lookup(question()).excludedAnswers, []);
  } finally { store.close(); }
});

test('a later hidden review cannot erase confirmed answers or excluded wrong combinations', () => {
  const store = openAnswers(':memory:');
  try {
    const correct = question();
    store.importReview([correct]);
    store.importReview([{ ...correct, feedback: 'unconfirmed', answer: [options[1].id] }]);
    assert.deepEqual(store.lookup(correct).answer, correct.answer);
    const wrong = question({ attemptId: '31', sourceUrl: 'https://moodle.example/mod/quiz/review.php?attempt=31&cmid=20',
      answer: [options[1].id], feedback: 'incorrect' });
    store.importReview([wrong]);
    store.importReview([{ ...wrong, feedback: 'unconfirmed' }]);
    assert.deepEqual(store.lookup(wrong).excludedAnswers, [wrong.answer]);
    const partial = question({ type: 'multiple', answer: [options[0].id, options[1].id], feedback: 'partiallycorrect' });
    store.importReview([partial]);
    store.importReview([{ ...partial, feedback: 'unconfirmed' }]);
    assert.deepEqual(store.lookup(partial).excludedAnswers, [[...partial.answer].sort()]);
  } finally { store.close(); }
});

test('import requires exact review provenance and rolls back on a mismatched page', () => {
  const store = openAnswers(':memory:');
  try {
    assert.throws(() => store.importReview([question(), question({ slot: '2', sourceUrl: 'https://moodle.example/mod/quiz/review.php?attempt=999&cmid=20' })]), /REVIEW_PROVENANCE_REQUIRED/);
    assert.equal(store.lookup(question()).observations, 0);
    assert.throws(() => store.importReview([question({ pageKind: 'attempt' })]), /REVIEW_PROVENANCE_REQUIRED/);
    assert.equal(store.lookup(question({ options: [options[0], options[0]] })).status, 'unsupported');
    assert.equal(store.lookup(question({ unsupportedReason: 'MEDIA' })).status, 'unsupported');
    assert.equal(store.importReview([question({ answer: ['invented'] })]).total, 0);
  } finally { store.close(); }
});

test('matching answers remain complete mappings and text answers retain their content', () => {
  const store = openAnswers(':memory:');
  try {
    const rows = ['First', 'Second'].map(text => ({ text, id: digest(['row-v1', text, options.map(o => o.text).sort()]), options }));
    const answer = Object.fromEntries(rows.map(row => [row.id, options[0].id]));
    const q = question({ type: 'matching', options: [], rows, answer });
    store.importReview([q]);
    assert.deepEqual(store.lookup({ ...q, rows: [...rows].reverse() }).answer, answer);
    const text = question({ type: 'text', text: 'Name the term.', options: [], answer: '  Exact  term  ' });
    store.importReview([text]);
    assert.equal(store.lookup(text).answer, 'Exact term');
  } finally { store.close(); }
});
