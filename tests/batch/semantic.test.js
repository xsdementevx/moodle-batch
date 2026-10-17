import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifySemantics } from '../../batch/semantic.js';

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
