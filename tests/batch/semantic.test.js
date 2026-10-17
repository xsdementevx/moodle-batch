import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifySemantics } from '../../batch/semantic.js';
import { pendingModelTests, solveTest } from '../../batch/solve.js';

const quote = 'Only Alpha is included; Beta is explicitly excluded.';
const q = { slot: '1', type: 'multiple', text: 'Which options belong?', options: [{ id: 'a', text: 'Alpha' }, { id: 'b', text: 'Beta' }] };
const answer = { slot: '1', status: 'candidate', evidenceVerified: true, answer: ['a'], confidence: 1,
  optionChecks: q.options.map((o, i) => ({ optionId: o.id, selected: i === 0, reason: 'Prior model explanation.', evidence: { quote } })) };
const reply = (payload, choices = ['supported', 'refuted']) => ({ model: payload.model,
  answers: Object.fromEntries(Object.keys(payload.questions).map((id, i) => [id, { type: 'choice', choice: choices[i], confidence: 0.99,
    probabilities: { supported: +(choices[i] === 'supported'), refuted: +(choices[i] === 'refuted'), insufficient_context: +(choices[i] === 'insufficient_context') } }])) });

test('independent checks hide prior verdicts, verify exclusion, checkpoint once and preserve uncertain answers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'batch-semantic-')); let calls = 0;
  try {
    const judge = async ({ payload }) => { calls++;
      for (const spec of Object.values(payload.questions)) {
        assert.equal(spec.instructions.question, q.text);
        assert.deepEqual(spec.instructions.quotes, [quote]);
        for (const forbidden of ['selected', 'confidence', 'answer', 'reason', 'expected']) assert.equal(Object.hasOwn(spec.instructions, forbidden), false);
      }
      return reply(payload);
    };
    const [checked] = await verifySemantics([answer], [q], join(dir, 'one.json'), { judge });
    assert.equal(checked.semanticVerified, true); assert.equal(checked.status, 'candidate');
    await verifySemantics([answer], [q], join(dir, 'one.json'), { judge }); assert.equal(calls, 1);
    const [rejected] = await verifySemantics([answer], [q], join(dir, 'two.json'), {
      judge: async ({ payload }) => reply(payload, ['supported', 'insufficient_context']) });
    assert.equal(rejected.semanticVerified, false); assert.equal(rejected.status, 'needs_review'); assert.equal(rejected.evidenceVerified, false);
    assert.equal(rejected.reviewReason, 'evidence_not_supportive');
    assert.match(rejected.reviewExplanation, /Beta.*недостаточными или неоднозначными/u);
    assert.doesNotMatch(rejected.reviewExplanation, /Alpha/u);
    assert.deepEqual(rejected.semanticFailures, [{ label: 'Beta', expected: 'refuted', actual: 'insufficient_context',
      confidence: 0.99, probability: 0, reason: 'insufficient_context' }]);
    const unresolved = { ...answer, status: 'needs_review', evidenceVerified: false };
    assert.deepEqual(await verifySemantics([unresolved], [q], join(dir, 'unused'), { judge: () => assert.fail('no verified candidate') }), [unresolved]);
    const known = { ...q, memory: { multipleOptions: { a: true, b: false } } };
    assert.equal((await verifySemantics([answer], [known], join(dir, 'known'), { judge: () => assert.fail('Moodle is authoritative') }))[0].semanticVerified, true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('semantic packets split without truncating quotes and unknown judge outcomes never resend', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'batch-semantic-size-'));
  try {
    const long = 'A full source sentence. '.repeat(1200);
    const large = { ...answer, optionChecks: answer.optionChecks.map(c => ({ ...c, evidence: { quote: long } })) };
    let calls = 0;
    await verifySemantics([large], [q], join(dir, 'large'), { judge: async ({ payload }) => {
      calls++; assert.ok(JSON.stringify(payload).length <= 48000);
      assert.equal(Object.values(payload.questions)[0].instructions.quotes[0], long);
      return reply(payload, [calls === 1 ? 'supported' : 'refuted']);
    } });
    assert.equal(calls, 2);
    const judge = async () => { throw new Error('TIMEOUT'); };
    await assert.rejects(verifySemantics([answer], [q], join(dir, 'pending'), { judge }), /TIMEOUT/);
    await assert.rejects(verifySemantics([answer], [q], join(dir, 'pending'), { judge: () => assert.fail('resend') }), /UNKNOWN_MODEL_OUTCOME/);
    const [oversized] = await verifySemantics([{ ...answer, optionChecks: answer.optionChecks.map(c => ({ ...c, evidence: { quote: long.repeat(3) } })) }],
      [q], join(dir, 'oversized'), { judge: () => assert.fail('oversized claim') });
    assert.equal(oversized.status, 'needs_review');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('multiple claims retain both verified premises without borrowing another question evidence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'batch-semantic-premises-'));
  const premise = 'The following registration rule applies to Alpha and Beta.';
  const otherPremise = 'This is a different rule for a separate question.';
  const second = { ...q, slot: '2', text: 'Which objects belong in another category?' };
  try {
    const checked = await verifySemantics([{ ...answer, evidence: [{ quote: premise }] },
      { ...answer, slot: '2', evidence: [{ quote: otherPremise }] }], [q, second], join(dir, 'proofs'), {
      judge: async ({ payload }) => {
        for (const spec of Object.values(payload.questions)) {
          const local = spec.instructions.question === q.text ? premise : otherPremise;
          const foreign = local === premise ? otherPremise : premise;
          assert.ok(spec.instructions.quotes.includes(quote), 'retain the option-specific premise');
          assert.ok(spec.instructions.quotes.includes(local), 'retain the question-wide premise');
          assert.ok(!spec.instructions.quotes.includes(foreign), 'do not borrow another question proof');
        }
        return reply(payload, ['supported', 'refuted', 'supported', 'refuted']);
      }
    });
    assert.ok(checked.every(a => a.semanticVerified));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('semantic confidence and probabilities must be valid and above the acceptance boundary', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'batch-semantic-boundary-'));
  try {
    for (const [i, confidence, probability, accepted] of [
      [0, 0.9, 0.95, true], [1, 0.95, 0.97, true], [2, 0.89, 0.99, false],
      [3, 0.99, 0.94, false], [4, 1.1, 1, false], [5, '0.99', 1, false],
    ]) {
      const [result] = await verifySemantics([answer], [q], join(dir, String(i)), { judge: async ({ payload }) => {
        const result = reply(payload);
        for (const a of Object.values(result.answers)) {
          a.confidence = confidence;
          a.probabilities = { supported: 0, refuted: 0, insufficient_context: 1 - probability, [a.choice]: probability };
        }
        return result;
      } });
      assert.equal(result.semanticVerified, accepted, `case ${i}`);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('an unknown semantic result blocks its quiz across regrouping without blocking unrelated quizzes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'batch-semantic-pending-'));
  try {
    const question = { ...q, quizId: '20', attemptId: '30', memory: { status: 'unresolved' } };
    const journal = join(dir, 'a'.repeat(64) + '.json');
    await writeFile(journal, JSON.stringify({ state: 'complete', result: { answers: [] } }));
    await assert.rejects(verifySemantics([answer], [question], journal, { judge: async () => { throw new Error('TIMEOUT'); } }), /TIMEOUT/);
    assert.deepEqual([...await pendingModelTests([question, { ...question, quizId: '21' }], dir)], ['20']);
    await assert.rejects(solveTest([question], {}, { journalDir: dir, web: () => assert.fail('regrouped resend') }), /UNKNOWN_MODEL_OUTCOME/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('semantic clarification identifies low certainty separately from a contradictory verdict', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'batch-semantic-diagnostic-'));
  try {
    const judge = async ({ payload }) => {
      const result = reply(payload);
      result.answers.c0.confidence = 0.89;
      return result;
    };
    const [uncertain] = await verifySemantics([answer], [q], join(dir, 'uncertain'), { judge });
    assert.equal(uncertain.status, 'needs_review');
    assert.match(uncertain.reviewExplanation, /Alpha.*согласна с выводом.*0.89/u);
    assert.doesNotMatch(uncertain.reviewExplanation, /противоречит/u);
    assert.equal(uncertain.semanticFailures[0].reason, 'below_threshold');
    assert.deepEqual([uncertain.semanticFailures[0].expected, uncertain.semanticFailures[0].actual,
      uncertain.semanticFailures[0].confidence, uncertain.semanticFailures[0].probability], ['supported', 'supported', 0.89, 1]);
    const [contradictory] = await verifySemantics([answer], [q], join(dir, 'contradictory'), {
      judge: async ({ payload }) => reply(payload, ['supported', 'supported'])
    });
    assert.match(contradictory.reviewExplanation, /Beta.*противоречит исключению/u);
    assert.equal(contradictory.semanticVerified, false);
    const q3 = { ...q, options: [...q.options, { id: 'c', text: 'Gamma' }] };
    const answer3 = { ...answer, optionChecks: [...answer.optionChecks,
      { optionId: 'c', selected: false, evidence: { quote } }] };
    const [allFailures] = await verifySemantics([answer3], [q3], join(dir, 'all-failures'), { judge: async ({ payload }) => {
      const result = reply(payload, ['supported', 'refuted', 'refuted']);
      for (const item of Object.values(result.answers)) item.confidence = 0.89;
      return result;
    } });
    for (const label of ['Alpha', 'Beta', 'Gamma']) assert.match(allFailures.reviewExplanation, new RegExp(label, 'u'));
    await verifySemantics([answer], [q], join(dir, 'uncertain'), { judge: () => assert.fail('diagnostics reuse checkpoint') });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
