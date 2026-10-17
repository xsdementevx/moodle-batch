import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest, optionId } from '../../batch/answers.js';
import { questionFingerprint, solveTest, pendingModelTests } from '../../batch/solve.js';
import { webPrompt, recoverWeb, webSolver } from '../../batch/web.js';

const id = digest('recovery');
const quote = 'The original course explicitly identifies Alpha as the correct category.';
const option = { id: optionId('Alpha'), text: 'Alpha' };
const qs = ['20', '21'].map(quizId => ({ origin: 'https://moodle.example', userScope: 'u1', courseId: '10',
  quizId, attemptId: '30', nativeSlot: '1', slot: `${quizId}:30:1`, contextId: quizId,
  type: 'choice', text: 'Which category?', options: [option, { id: optionId('Beta'), text: 'Beta' }], rows: [], memory: { status: 'unresolved', excludedAnswers: [] } }));
const context = { documents: Object.fromEntries(qs.map(q => [q.quizId, { status: 'ready', contextHash: digest(q.quizId), text: quote }])) };
const answers = qs.map(q => ({ slot: q.slot, answer: [option.id], confidence: 0.99, needsReview: false,
  evidence: { kind: 'context', contextId: q.quizId, quote }, sourceUrls: [] }));
async function fixture({ snapshot = false, uncertain = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'batch-web-recovery-'));
  const path = join(dir, id + '.json');
  const prompt = webPrompt(qs, context, id);
  const final = answers.map((a, i) => uncertain && i === 0 ? { ...a, answer: null, needsReview: true, reviewExplanation: 'Two alternatives remain ambiguous.' } : a);
  const messages = [{ role: 'user', text: prompt }, { role: 'assistant', endTurn: true, text: JSON.stringify({ requestId: id, answers: final }) }];
  const saved = { state: 'pending', requestId: id, questionIds: qs.map(q => q.slot),
    bindings: qs.map(q => ({ slot: q.slot, fingerprint: questionFingerprint(q, context) })), conversationUrl: 'https://chatgpt.com/c/original' };
  if (snapshot) {
    const { parseConversation } = await import('../../batch/web.js');
    saved.request = { prompt, parentRequestId: [], reasoning: 'Medium' };
    saved.response = { answers: parseConversation(messages, qs, id), conversationUrl: saved.conversationUrl };
  }
  await writeFile(path, JSON.stringify(saved));
  return { dir, path, saved, messages };
}
const verified = async answers => answers.map(a => a.status === 'candidate' && a.evidenceVerified ? { ...a, semanticVerified: true } : a);

test('a selected quiz recovers the whole original packet without connecting or resending ChatGPT', async () => {
  const f = await fixture({ snapshot: true }); let checked = 0;
  const web = webSolver({ extension: true, connect: () => assert.fail('parsed reply must not open a browser'),
    verifySemantics: async (answers, questions) => { checked++; assert.deepEqual(questions.map(q => q.slot), qs.map(q => q.slot)); return verified(answers); } });
  try {
    const result = await solveTest([qs[1]], context, { journalDir: f.dir, web, jev: () => assert.fail('no new Jev solve') });
    assert.equal(checked, 1); assert.equal(result.length, 1); assert.equal(result[0].decision.semanticVerified, true);
    assert.equal(result[0].decision.cached, true);
    const saved = JSON.parse(await readFile(f.path)); assert.equal(saved.state, 'complete'); assert.equal(saved.result.answers.length, 2);
    assert.deepEqual(saved.bindings, f.saved.bindings);
  } finally { await web.close(); await rm(f.dir, { recursive: true, force: true }); }
});

test('a recovered uncertain answer is retained across regrouping instead of another Instant request', async () => {
  const f = await fixture({ snapshot: true, uncertain: true });
  const web = webSolver({ extension: true, connect: () => assert.fail('must not resend'), verifySemantics: verified });
  try {
    for (let n = 0; n < 2; n++) {
      const result = await solveTest([qs[0]], context, { journalDir: f.dir, web, jev: () => assert.fail('must not solve again') });
      assert.equal(result[0].decision.status, 'needs_review'); assert.equal(result[0].decision.reviewReason, 'model_uncertain');
    }
  } finally { await web.close(); await rm(f.dir, { recursive: true, force: true }); }
});

test('legacy recovery reads and validates the original full response', async () => {
  const f = await fixture(); let reads = 0;
  try {
    const result = await recoverWeb(f.path, { readMessages: async (url, requestId) => {
      reads++; assert.equal(url, f.saved.conversationUrl); assert.equal(requestId, id); return f.messages;
    }, verifySemantics: verified });
    assert.equal(reads, 1); assert.equal(result.answers.length, 2); assert.ok(result.answers.every(a => a.semanticVerified));
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('unknown semantic outcome cannot be bypassed by a recovered subset or different proof payload', async () => {
  const f = await fixture({ snapshot: true });
  try {
    const semanticPath = join(f.dir, digest('older') + '.json.semantic-' + digest('old proof') + '.json');
    const unknown = { state: 'pending', questionIds: [qs[1].slot] };
    await writeFile(semanticPath, JSON.stringify(unknown));
    await assert.rejects(recoverWeb(f.path, { verifySemantics: () => assert.fail('unknown Jev outcome must block') }), /UNKNOWN_MODEL_OUTCOME/);
    assert.deepEqual(JSON.parse(await readFile(f.path)), f.saved);
    assert.deepEqual(JSON.parse(await readFile(semanticPath)), unknown);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('legacy recovery rejects foreign chain, duplicate slots and malformed IDs without changing journals', async () => {
  for (const corrupt of [
    f => { const p = JSON.parse(f.messages[0].text.split('\n').at(-1)); p.requestId = digest('foreign'); f.messages[0].text = JSON.stringify(p); },
    f => { const p = JSON.parse(f.messages[0].text.split('\n').at(-1)); p.questions[1].slot = p.questions[0].slot; f.messages[0].text = JSON.stringify(p); },
    f => { f.saved.requestId = '../foreign'; },
    f => { f.messages.unshift({ role: 'user', text: JSON.stringify({ requestId: '../foreign' }) }); },
  ]) {
    const f = await fixture();
    try {
      corrupt(f); await writeFile(f.path, JSON.stringify(f.saved));
      await assert.rejects(recoverWeb(f.path, { readMessages: async () => f.messages, verifySemantics: () => assert.fail('no Jev') }), /GPT_WEB_RECOVERY_SCOPE_MISMATCH/);
      assert.deepEqual(JSON.parse(await readFile(f.path)), f.saved);
    } finally { await rm(f.dir, { recursive: true, force: true }); }
  }
});

test('failed recovery keeps pending intact, is attempted once, and blocks only its affected quiz', async () => {
  const f = await fixture(); let reads = 0; const errors = [];
  try {
    const blocked = await pendingModelTests([qs[0], { ...qs[1], quizId: '22' }], f.dir, {
      recover: path => recoverWeb(path, { readMessages: async () => { reads++; throw Object.assign(Error('GPT_WEB_CONVERSATION_UNAVAILABLE'), { httpStatus: 404 }); } }),
      onError: (quizId, error) => errors.push([quizId, error.message]),
    });
    assert.equal(reads, 1); assert.deepEqual([...blocked], ['20']);
    assert.deepEqual(errors, [['20', 'GPT_WEB_CONVERSATION_UNAVAILABLE']]);
    assert.deepEqual(JSON.parse(await readFile(f.path)), f.saved);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('editing a legacy question while keeping request ID and bindings cannot promote the answer', async () => {
  const f = await fixture();
  try {
    const packet = JSON.parse(f.messages[0].text.split('\n').at(-1));
    packet.questions[0].text = 'A different question with the same slot';
    f.messages[0].text = JSON.stringify(packet);
    await assert.rejects(recoverWeb(f.path, { questions: [qs[0]], context,
      readMessages: async () => f.messages, verifySemantics: () => assert.fail('no new proof for foreign question') }), /GPT_WEB_RECOVERY_SCOPE_MISMATCH/);
    assert.deepEqual(JSON.parse(await readFile(f.path)), f.saved);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('legacy recovery cannot forge confirmed option or row memory while retaining native bindings', async () => {
  for (const field of ['multipleMemory', 'matchingMemory', 'excludedAnswers']) {
    const f = await fixture();
    try {
      const packet = JSON.parse(f.messages[0].text.split('\n').at(-1));
      packet.questions[0][field] = field === 'excludedAnswers' ? [['forged-answer']] : { forged: true };
      f.messages[0].text = JSON.stringify(packet);
      await assert.rejects(recoverWeb(f.path, { questions: [qs[0]], context, readMessages: async () => f.messages,
        verifySemantics: () => assert.fail('forged memory must not bypass the proof checker') }), /GPT_WEB_RECOVERY_SCOPE_MISMATCH/);
      assert.deepEqual(JSON.parse(await readFile(f.path)), f.saved);
    } finally { await rm(f.dir, { recursive: true, force: true }); }
  }
});

test('recovered Instant candidates requiring review never fall through to fresh solver packets', async () => {
  for (const multiple of [false, true]) {
    const previous = { text: qs[0].text, type: qs[0].type };
    qs[0].text = multiple ? 'Which categories apply?' : 'Which category is not included?';
    qs[0].type = multiple ? 'multiple' : 'choice';
    const f = await fixture();
    try {
      const decision = { slot: qs[0].slot, provider: 'gpt_web', status: 'candidate', answer: [option.id], confidence: 0.99,
        evidenceVerified: true, semanticVerified: true, sourceUrls: [], evidence: { kind: 'context', contextId: '20', quote },
        ...(multiple ? { optionChecks: qs[0].options.map(o => ({ optionId: o.id, selected: o.id === option.id, reason: 'Verified separately',
          evidence: { kind: 'context', contextId: '20', quote } })) } : {}) };
      await writeFile(f.path, JSON.stringify({ state: 'complete', bindings: f.saved.bindings,
        result: { recovered: true, reasoning: 'Instant', recoveryQuestions: JSON.parse(f.messages[0].text.split('\n').at(-1)).questions, answers: [decision] } }));
      const result = await solveTest([qs[0]], context, { journalDir: f.dir,
        web: () => assert.fail('no new Instant'), jev: () => assert.fail('no new Jev solve') });
      assert.equal(result[0].decision.status, 'needs_review');
      assert.equal(result[0].decision.reviewReason, multiple ? 'multiple_completeness' : 'negative_question');
    } finally { Object.assign(qs[0], previous); await rm(f.dir, { recursive: true, force: true }); }
  }
});
