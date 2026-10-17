import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { optionId, digest, questionKey } from '../../batch/answers.js';
import { normalizeShortAnswerForQuestion } from '../../batch/text.js';
import { checkpointed, jevPacket, parseJev, questionFingerprint, questionPackets, selectContext, solveTest } from '../../batch/solve.js';
import { parseWeb, parseConversation, webPrompt, readyWeb, openWebPage, selectWebReasoning, dispatchWeb, readWebResult, verifyWebParents, webSolver } from '../../batch/web.js';
import { verifyEvidence } from '../../batch/evidence.js';

test('confirmed memory requires neither journal access nor models and leaves conflicts unresolved', async () => {
  const root = await mkdtemp(join(tmpdir(), 'batch-memory-only-'));
  const journalDir = join(root, 'unavailable-journals');
  try {
    await writeFile(journalDir, 'This is not a journal directory.');
    const questions = [q('1', { memory: { status: 'known', answer: [options[0].id] } }),
      q('2', { memory: { status: 'conflict' } }), q('3', { memory: { status: 'unsupported' } })];
    const result = await solveTest(questions, {}, { journalDir,
      jev: () => assert.fail('confirmed memory must not call Jev'), web: () => assert.fail('confirmed memory must not call Web') });
    assert.deepEqual(result[0].decision, { provider: 'memory', answer: [options[0].id], status: 'confirmed', verifiedByMoodle: true });
    assert.equal(result[1].decision, null);
    assert.equal(result[2].decision, null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('person blanks use a surname while explicit full-name requests and non-person terms stay intact', () => {
  const fullName = 'Георгий Константинович Жуков';
  assert.equal(normalizeShortAnswerForQuestion('Маршал, принимавший Парад Победы — ….', fullName, 6), 'Жуков');
  assert.equal(normalizeShortAnswerForQuestion('Маршал, принимавший Парад Победы — ….', fullName), fullName);
  assert.equal(normalizeShortAnswerForQuestion('Маршал, принимавший Парад Победы — ….', fullName, 80), fullName);
  assert.equal(normalizeShortAnswerForQuestion('Полное имя маршала: ….', fullName, 6), fullName);
  assert.equal(normalizeShortAnswerForQuestion('Укажите Ф.И.О.: ….', fullName, 6), fullName);
  assert.equal(normalizeShortAnswerForQuestion('Война называлась ….', 'Великая Отечественная война'), 'Великая Отечественная война');
  assert.equal(normalizeShortAnswerForQuestion('Кто принимал парад?', fullName), fullName);
  const person = q('1', { type: 'text', options: [], text: 'Маршал, принимавший Парад Победы — ….', textFormat: 'shortanswer', textFieldSize: 6, memory: { excludedAnswers: [fullName] } });
  const parsed = parseWeb(JSON.stringify({ requestId: 'nonce', answers: [{ slot: '1', answer: fullName, needsReview: false,
    sourceUrls: ['https://source.example/'] }] }), [person], 'nonce', ['https://source.example/'])[0];
  assert.equal(parsed.answer, 'Жуков');
  assert.equal(parsed.rawAnswer, fullName);
});

test('uncertain Web responses preserve diagnostics but remain unverified', async () => {
  const question = q('1');
  const evidence = { kind: 'web', url: 'https://source.example/', quote: 'A factual quote retained for later analysis.' };
  const decisions = parseWeb(JSON.stringify({ requestId: 'nonce', answers: [{ slot: '1', answer: [options[0].id], confidence: 0.8,
    needsReview: false, sourceUrls: [evidence.url], evidence }] }), [question], 'nonce', [evidence.url]);
  assert.equal(decisions[0].confidence, 0.8);
  assert.deepEqual(decisions[0].evidence, evidence);
  assert.equal(decisions[0].status, 'needs_review');
  const verified = await verifyEvidence(decisions, [question], { text: '' }, { readSource: async () => assert.fail('uncertainty must not be promoted by a matching quote') });
  assert.equal(verified[0].status, 'needs_review');
  assert.equal(verified[0].evidenceVerified, false);
  assert.equal(verified[0].reviewReason, 'model_uncertain');
  for (const [confidence, status] of [[0.86, 'needs_review'], [0.899, 'needs_review'], [0.90, 'candidate']]) {
    assert.equal(parseWeb(JSON.stringify({ requestId: 'nonce', answers: [{ slot: '1', answer: [options[0].id], confidence,
      needsReview: false, sourceUrls: [evidence.url], evidence }] }), [question], 'nonce', [evidence.url])[0].status, status);
  }
});
import { closeExtensionTabs } from '../../batch/extension.js';
import { chromium } from 'playwright';
import { extractMaterial, loadContext } from '../../batch/context.js';
import { openParser } from '../../batch/moodle.js';

const options = ['Alpha', 'Beta'].map(text => ({ id: optionId(text), text }));
const q = (slot, extra = {}) => ({ origin: 'https://moodle.example', userScope: 'u1', courseId: '10', quizId: '20', attemptId: '30', slot,
  type: 'choice', text: 'Which sample?', options, rows: [], memory: { status: 'unresolved', excludedAnswers: [] }, ...extra });
const response = (packet, choice = 'o0') => ({ model: 'jev-1.13.0', answers: Object.fromEntries(Object.entries(packet.payload.questions).map(([id, spec]) => [id,
  { type: 'choice', choice, confidence: 1, probabilities: Object.fromEntries(Object.keys(spec.criteria).map(key => [key, key === choice ? 1 : 0])) }])) });

test('both providers receive matching row memory and reject a different whole mapping with a known wrong pair', () => {
  const rows = ['First', 'Second'].map(text => ({ text, id: digest(['row-v1', text, options.map(o => o.text).sort()]), options }));
  const question = q('1', { type: 'matching', options: [], rows, memory: { status: 'unresolved', excludedAnswers: [],
    matchingRows: { [rows[0].id]: { answer: null, excludedAnswers: [options[0].id] } } } });
  const packet = jevPacket([question], 'Course context');
  assert.equal(packet.payload.questions.q1_r0.instructions.excludedMatchingRows[0].answers[0], 'Alpha');
  assert.equal(parseJev(packet, response(packet)).size, 0);
  const input = JSON.parse(webPrompt([question], { text: 'Course context' }, 'nonce').split('\n').at(-1));
  assert.deepEqual(input.questions[0].matchingMemory, question.memory.matchingRows);
  const answer = Object.fromEntries(rows.map(row => [row.id, options[0].id]));
  const parsed = parseWeb(JSON.stringify({ requestId: 'nonce', answers: [{ slot: '1', answer, needsReview: false, sourceUrls: [] }] }), [question], 'nonce', []);
  assert.equal(parsed[0].status, 'needs_review');
  assert.equal(parsed[0].reviewReason, 'excluded_answer');
  assert.notEqual(questionFingerprint(question, {}), questionFingerprint({ ...question, memory: { ...question.memory, matchingRows: undefined } }, {}));
});

test('legacy short-answer wording rules preserve source words, strip repeated units, and enforce exclusions after normalization', () => {
  const question = q('1', { type: 'text', textFormat: 'shortanswer', text: 'Длительные свидания продолжительностью … суток', options: [] });
  assert.equal(normalizeShortAnswerForQuestion(question.text, 'трое суток'), 'трое');
  assert.equal(normalizeShortAnswerForQuestion(question.text, '3'), '3');
  assert.equal(normalizeShortAnswerForQuestion('Может ли работник отказаться?', 'Да, может'), 'да');
  assert.equal(normalizeShortAnswerForQuestion('Срок от … до … лет', 'от 2 до 5 лет'), '2 до 5');
  assert.equal(normalizeShortAnswerForQuestion('В течение …', '1 года'), 'одного года');
  const payload = answer => JSON.stringify({ requestId: 'nonce', answers: [{ slot: '1', answer, needsReview: false, sourceUrls: ['https://source.example/one'] }] });
  const answer = parseWeb(payload('трое суток'), [question], 'nonce', ['https://source.example/one'])[0];
  assert.equal(answer.answer, 'трое');
  assert.equal(answer.rawAnswer, 'трое суток');
  assert.equal(parseWeb(payload('3'), [{ ...question, textFormat: 'numerical' }], 'nonce', ['https://source.example/one'])[0].answer, '3');
  const excluded = parseWeb(payload('трое суток'), [{ ...question, memory: { excludedAnswers: ['трое'] } }], 'nonce', ['https://source.example/one'])[0];
  assert.equal(excluded.answer, null); assert.equal(excluded.reviewReason, 'excluded_answer');
  assert.ok(webPrompt([question], { text: '' }, 'nonce').includes('не заменяй словесное число цифрой'));
});

test('updated wording policy does not resend pending legacy web packets or alter confirmed memory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'batch-wording-'));
  try {
    const question = q('1', { type: 'text', text: 'Продолжительностью … суток', options: [] });
    const context = { text: '', status: 'missing', contextHash: null };
    const legacyId = digest(['web-packet-v1', [[question.attemptId, question.slot, questionKey(question)]], null]);
    await writeFile(join(dir, `${legacyId}.json`), JSON.stringify({ state: 'pending' }));
    await assert.rejects(solveTest([question], context, { journalDir: dir, web: () => assert.fail('must not resend') }), /UNKNOWN_MODEL_OUTCOME/);
    const known = { ...question, memory: { status: 'known', answer: 'трое суток', excludedAnswers: [] } };
    const result = await solveTest([known], context, { journalDir: dir, web: () => assert.fail('known answer') });
    assert.equal(result[0].decision.answer, 'трое суток');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('status cleanup closes only Moodle Batch extension pages', async () => {
  const base = 'chrome-extension://mmlmfjhmonkocbjadbfplnigmagldckm/connect.html';
  const tabs = ['Moodle Batch', 'Other client'].map((name, i) => ({ id: i + 1, url: `${base}?client=${encodeURIComponent(JSON.stringify({ name }))}` }));
  tabs.push({ id: 3, url: `${base}?client=invalid` });
  let removed;
  const page = { url: () => tabs[0].url, evaluate: fn => runInNewContext(`(${fn.toString()})()`, {
    URL, chrome: { tabs: { query: async () => tabs, remove: async ids => { removed = Array.from(ids); } } },
  }) };
  await closeExtensionTabs({ contexts: () => [{ pages: () => [page] }] });
  assert.deepEqual(removed, [1]);
});

test('conversation parser validates identity, final answer and actual web tool evidence; completed journal opens no browser', async () => {
  const result = { requestId: 'nonce', answers: [{ slot: '1', answer: [options[0].id], needsReview: false, sourceUrls: ['https://source.example/one'] }] };
  const messages = [{ role: 'user', text: 'requestId nonce' }, { role: 'assistant', endTurn: false },
    { role: 'tool', toolName: 'web.run', sources: result.answers[0].sourceUrls },
    { role: 'assistant', endTurn: true, text: `<escape>${JSON.stringify(result)}</escape>` }];
  const answers = parseConversation(messages, [q('1')], 'nonce');
  assert.equal(answers[0].status, 'candidate');
  assert.equal(answers[0].searchObserved, true);
  assert.deepEqual(parseConversation([...messages, { role: 'assistant', endTurn: true, text: '  ' }], [q('1')], 'nonce'), answers);
  assert.equal(parseConversation(messages.filter(m => m.role !== 'tool'), [q('1')], 'nonce')[0].status, 'needs_review');
  assert.throws(() => parseConversation(messages, [q('1')], 'foreign'), /FOREIGN_CONVERSATION/);
  assert.throws(() => parseConversation([...messages, messages[3]], [q('1')], 'nonce'), /FOREIGN_CONVERSATION/);
  assert.throws(() => parseConversation([...messages.slice(0, 3), { role: 'assistant', endTurn: true }], [q('1')], 'nonce'), /RESPONSE_NOT_READY/);
  const clarified = [{ role: 'user', text: 'requestId earlier' }, { role: 'assistant', endTurn: true, contentType: 'reasoning_recap' }, ...messages];
  assert.deepEqual(parseConversation(clarified, [q('1')], 'nonce', ['earlier']), answers);
  assert.throws(() => parseConversation(clarified, [q('1')], 'nonce', ['wrong-parent']), /FOREIGN_CONVERSATION/);
  assert.throws(() => parseConversation([...messages, { role: 'user', text: 'requestId later' }], [q('1')], 'later', ['nonce']), /RESPONSE_NOT_READY/);
  const dir = await mkdtemp(join(tmpdir(), 'batch-completed-web-'));
  try {
    const journalPath = join(dir, 'web.json');
    await writeFile(journalPath, JSON.stringify({ state: 'complete', result: { answers } }));
    const solve = webSolver({ extension: true, connect: () => assert.fail('completed request must not connect') });
    assert.deepEqual(await solve([q('1')], {}, { journalPath }), answers);
    await solve.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('completed answers gain independent semantic checks without resending to ChatGPT', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'batch-semantic-cache-'));
  try {
    const question = q('1'), journalPath = join(dir, 'web.json');
    const answer = { slot: '1', provider: 'gpt_web', status: 'candidate', answer: [options[0].id],
      evidenceVerified: true, confidence: 0.99, evidence: { kind: 'context', quote: 'The material explicitly supports Alpha.' } };
    await writeFile(journalPath, JSON.stringify({ state: 'complete', result: { sourcePolicy: 9, answers: [answer] } }));
    let checks = 0;
    const solve = webSolver({ extension: true, connect: () => assert.fail('no new browser or ChatGPT send'),
      verifySemantics: async (answers, questions, path) => {
        checks++; assert.equal(path, journalPath); assert.deepEqual(questions, [question]);
        return answers.map(a => ({ ...a, semanticVerified: true }));
      } });
    assert.equal((await solve([question], {}, { journalPath }))[0].semanticVerified, true);
    assert.equal((await solve([question], {}, { journalPath }))[0].semanticVerified, true);
    assert.equal(checks, 1);
    assert.equal(JSON.parse(await readFile(journalPath, 'utf8')).result.answers[0].semanticVerified, true);
    await solve.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('extension reuses one attachment, closes its own pages and detaches without closing the personal context', async () => {
  const events = [];
  const solve = webSolver({ extension: true, connect: async () => {
    events.push('connect');
    return { contexts: () => [{ newPage: async () => ({
      goto: async () => { throw new Error('FIXTURE_NAVIGATION_FAILURE'); },
      close: async () => events.push('own-page-close'),
    }), close: async () => assert.fail('personal context must remain open') }], close: async () => events.push('detach') };
  } });
  const journal = join(tmpdir(), `batch-extension-${crypto.randomUUID()}.json`);
  for (let i = 0; i < 2; i++) await assert.rejects(solve([], {}, { journalPath: journal }), /FIXTURE_NAVIGATION_FAILURE/u);
  await solve.close();
  assert.deepEqual(events, ['connect', 'own-page-close', 'own-page-close', 'detach']);
});

test('completed evidence arrays are rechecked after a reader upgrade but model uncertainty stays unresolved', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'batch-recheck-'));
  const journalPath = join(dir, 'complete.json');
  const quote = 'The exact verified course statement provides the answer.';
  const evidence = [{ kind: 'context', quote, optionIds: ['one'] }];
  const answers = [
    { slot: '1', type: 'multiple', answer: ['one'], status: 'needs_review', reviewReason: 'source_quote_not_found', sourceUrls: [], evidence,
      optionChecks: ['one', 'two'].map(id => ({ optionId: id, selected: id === 'one', reason: 'Verified against the course statement.', evidence: evidence[0] })) },
    { slot: '2', answer: ['one'], status: 'needs_review', reviewReason: 'model_uncertain', sourceUrls: [], evidence },
  ];
  try {
    await writeFile(journalPath, JSON.stringify({ state: 'complete', result: { sourcePolicy: 3, answers } }));
    const solve = webSolver({ extension: true, verifySemantics: async answers => answers,
      connect: () => assert.fail('rechecking evidence must not dispatch to ChatGPT') });
    const result = await solve([{ slot: '1', type: 'multiple', options: [{ id: 'one' }, { id: 'two' }] }, { slot: '2' }], { text: quote }, { journalPath });
    assert.equal(result[0].evidenceVerified, true);
    assert.equal(result[0].status, 'candidate');
    assert.equal(result[0].reviewReason, undefined);
    assert.equal(result[1].status, 'needs_review');
    assert.equal(result[1].reviewReason, 'model_uncertain');
    assert.equal(JSON.parse(await readFile(journalPath, 'utf8')).result.sourcePolicy, 9);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a completed conversation is read without waiting on DOM, while a foreign response still fails', async () => {
  const payload = { requestId: 'nonce', answers: [{ slot: '1', answer: [options[0].id], needsReview: false, sourceUrls: ['https://source.example/'] }] };
  const messages = [{ role: 'user', text: 'nonce' }, { role: 'tool', toolName: 'web.run', sources: ['https://source.example/'] },
    { role: 'assistant', endTurn: true, text: JSON.stringify(payload) }];
  let reads = 0;
  const page = { url: () => 'https://chatgpt.com/c/owned-conversation',
    waitForFunction: () => assert.fail('known conversation must not wait on message DOM'),
    evaluate: async () => { reads++; return messages; },
    locator: () => assert.fail('no draft or send control should be touched') };
  assert.equal((await readWebResult(page, [q('1')], 'nonce')).answers[0].status, 'candidate');
  assert.equal(reads, 1);
  await assert.rejects(readWebResult(page, [q('1')], 'foreign'), /FOREIGN_CONVERSATION/);
  assert.equal(reads, 2);
});

test('new chat switches to conversation reads when its URL appears after the user turn', async () => {
  const payload = { requestId: 'nonce', answers: [{ slot: '1', answer: [options[0].id], needsReview: false, sourceUrls: ['https://source.example/'] }] };
  const messages = [{ role: 'user', text: 'nonce' }, { role: 'tool', toolName: 'web.run', sources: ['https://source.example/'] },
    { role: 'assistant', endTurn: true, text: JSON.stringify(payload) }];
  let url = 'https://chatgpt.com/', waits = 0, reads = 0;
  const page = { url: () => url,
    waitForFunction: async (fn, arg) => {
      waits++;
      if (waits === 1) return; // The user turn mounts before navigation.
      url = 'https://chatgpt.com/c/owned-conversation';
      assert.equal(runInNewContext(`(${fn.toString()})(turns)`, {
        turns: arg, location: { pathname: '/c/owned-conversation' },
        document: { querySelectorAll: () => assert.fail('virtualized answer must not be inspected once URL is known') },
      }), true);
    },
    evaluate: async () => { reads++; return messages; },
    locator: () => assert.fail('reading a completed conversation must not require scrolling or copy controls') };
  assert.equal((await readWebResult(page, [q('1')], 'nonce')).answers[0].status, 'candidate');
  assert.equal(waits, 2); assert.equal(reads, 1);
});

test('legacy completed transcript can be read without scrolling', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const payload = { requestId: 'nonce', answers: [{ slot: '1', answer: [options[0].id], needsReview: false, sourceUrls: ['https://source.example/'] }] };
    await page.route('https://chatgpt.com/', route => route.fulfill({ contentType: 'text/html', body: `<main>
      <div id="transcript" style="height:200px;overflow-y:auto"><div data-message-author-role="user">nonce</div><div style="height:1500px"></div>
      <div data-message-author-role="assistant"><pre><code>${JSON.stringify(payload)}</code></pre><a href="https://source.example/">source</a></div></div></main>
      <script>
        const button = document.createElement('button'); button.setAttribute('aria-label', 'Copy');
        document.querySelector('[data-message-author-role=assistant]').append(button);
      </script>` }));
    await page.goto('https://chatgpt.com/');
    assert.equal((await readWebResult(page, [q('1')], 'nonce')).answers[0].status, 'candidate');
    assert.equal(await page.locator('#transcript').evaluate(el => el.scrollTop), 0);
  } finally { await browser.close(); }
});

test('pending conversation backs off before reading the final response without scrolling or another send', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const url = 'https://chatgpt.com/c/owned-conversation';
  const payload = { requestId: 'nonce', answers: [{ slot: '1', answer: [options[0].id], needsReview: false, sourceUrls: ['https://source.example/'] }] };
  let reads = 0;
  const page = { url: () => url,
    evaluate: async (_fn, arg) => {
      assert.equal(arg, '/c/owned-conversation', 'only the pinned API request is allowed');
      reads++;
      return [{ role: 'user', text: 'nonce' }, { role: 'tool', toolName: 'web.run', sources: ['https://source.example/'] },
        { role: 'assistant', endTurn: reads === 2, text: JSON.stringify(payload) }];
    }, locator: () => assert.fail('pending response must not touch the transcript or draft') };
  const pending = readWebResult(page, [q('1')], 'nonce');
  await new Promise(done => setImmediate(done));
  t.mock.timers.tick(29999); await new Promise(done => setImmediate(done));
  assert.equal(reads, 1, 'no five-second polling during a delayed save');
  t.mock.timers.tick(1);
  assert.equal((await pending).answers[0].status, 'candidate');
  assert.equal(reads, 2);
});

test('unavailable conversation and access errors stop the pinned read without retry or sending', async () => {
  for (const code of ['GPT_WEB_CONVERSATION_UNAVAILABLE', 'GPT_WEB_CONVERSATION_ACCESS_DENIED', 'GPT_WEB_SESSION_TOKEN_UNAVAILABLE']) {
    let reads = 0;
    const page = { url: () => 'https://chatgpt.com/c/owned-conversation',
      evaluate: async () => { reads++; return { error: code }; },
      locator: () => assert.fail('a read error must not touch draft or send controls'),
      waitForFunction: () => assert.fail('unavailable conversation must not wait for DOM') };
    await assert.rejects(readWebResult(page, [q('1')], 'nonce'), error => error.message === code);
    assert.equal(reads, 1);
  }
});

test('pinned reads honor rate limit backoff and retry temporary server failures without resending', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const url = 'https://chatgpt.com/c/owned-conversation';
  const payload = { requestId: 'nonce', answers: [{ slot: '1', answer: [options[0].id], needsReview: false, sourceUrls: ['https://source.example/'] }] };
  let reads = 0;
  const page = { url: () => url, locator: () => assert.fail('no draft or send interaction'),
    evaluate: async (_fn, pathname) => {
      assert.equal(pathname, '/c/owned-conversation');
      reads++;
      if (reads === 1) return { error: 'GPT_WEB_RATE_LIMITED', httpStatus: 429, retryMs: 120000 };
      if (reads === 2) return { error: 'GPT_WEB_CONVERSATION_READ_FAILED', httpStatus: 503 };
      return [{ role: 'user', text: 'nonce' }, { role: 'tool', toolName: 'web.run', sources: ['https://source.example/'] }, { role: 'assistant', endTurn: true, text: JSON.stringify(payload) }];
    } };
  const waits = [];
  const pending = readWebResult(page, [q('1')], 'nonce', undefined, undefined, detail => waits.push(detail));
  const settle = () => new Promise(done => setImmediate(done));
  await settle();
  t.mock.timers.tick(119999); await settle(); assert.equal(reads, 1);
  t.mock.timers.tick(1); await settle(); assert.equal(reads, 2);
  t.mock.timers.tick(5000);
  assert.equal((await pending).answers[0].status, 'candidate');
  assert.equal(reads, 3);
  assert.deepEqual(waits.map(w => w?.httpStatus ?? null), [429, 503, null]);
  assert.ok(waits[0].retryAt > waits[1].retryAt);
  const limited = { ...page, evaluate: async () => ({ error: 'GPT_WEB_RATE_LIMITED', httpStatus: 429, retryMs: 600000 }) };
  await assert.rejects(readWebResult(limited, [q('1')], 'nonce'), /GPT_WEB_RATE_LIMITED/);
});

test('original chat waits for delayed hydration without reloading or reading history', async () => {
  const target = 'https://chatgpt.com/c/pinned-history', waits = [];
  let loads = 0, finishLoading;
  const hydrated = new Promise(resolve => { finishLoading = resolve; });
  const page = { url: () => target, title: async () => 'ChatGPT', bringToFront: async () => {},
    goto: async url => { assert.equal(url, target); loads++; },
    locator: selector => selector.startsWith('iframe') ? { count: async () => 0 }
      : { first: () => ({ waitFor: async options => {
        assert.equal(options.timeout, 300000); await hydrated;
      } }) },
    evaluate: () => assert.fail('loading must not issue history requests') };
  const pending = openWebPage(page, target, detail => waits.push(detail));
  await new Promise(done => setImmediate(done));
  assert.equal(loads, 1); assert.equal(waits.length, 1);
  finishLoading(); await pending;
  assert.equal(loads, 1); assert.equal(waits.at(-1), null);
  await assert.rejects(openWebPage({ ...page, url: () => 'https://chatgpt.com/c/foreign' }, target), /GPT_WEB_SCOPE_MISMATCH/);
});

test('extension reconnects a missing or detached context before dispatch and never retries a pending packet', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'batch-reconnect-'));
  let connects = 0, disconnected = false;
  const detached = [];
  const solve = webSolver({ extension: true, connect: async () => {
    const id = ++connects;
    return { isConnected: () => id !== 2 || !disconnected,
      contexts: () => id === 1 ? [] : [{ newPage: async () => ({
        goto: async () => { throw new Error('FIXTURE_BEFORE_DISPATCH'); }, close: async () => {},
      }), close: () => assert.fail('must not close the personal context') }],
      close: async () => detached.push(id) };
  } });
  try {
    const journalPath = join(dir, 'web.json');
    await assert.rejects(solve([], {}, { journalPath }), /FIXTURE_BEFORE_DISPATCH/);
    assert.equal(connects, 2); // The first connection supplied no context.
    disconnected = true;
    await assert.rejects(solve([], {}, { journalPath }), /FIXTURE_BEFORE_DISPATCH/);
    assert.equal(connects, 3);
    await writeFile(journalPath, JSON.stringify({ state: 'pending' }));
    await assert.rejects(solve([], {}, { journalPath }), /UNKNOWN_MODEL_OUTCOME/);
    assert.equal(connects, 3);
  } finally { await solve.close(); await rm(dir, { recursive: true, force: true }); }
  assert.deepEqual(detached, [1, 2, 3]);
});

test('continuation result reads the confirmed conversation when the visible tab navigates elsewhere', async () => {
  const payload = { requestId: 'nonce', answers: [{ slot: '1', answer: [options[0].id], needsReview: false, sourceUrls: [] }] };
  const messages = [{ role: 'user', text: 'requestId parent' }, { role: 'assistant', endTurn: true, text: 'previous response' },
    { role: 'user', text: 'requestId nonce' }, { role: 'assistant', endTurn: true, text: JSON.stringify(payload) }];
  const page = { url: () => 'https://chatgpt.com/c/foreign-chat',
    waitForFunction: () => assert.fail('foreign DOM must not be inspected'),
    evaluate: async (_fn, pathname) => { assert.equal(pathname, '/c/owned-chat'); return messages; },
    locator: () => assert.fail('foreign composer must not be touched') };
  const result = await readWebResult(page, [q('1')], 'nonce', ['parent'], 'https://chatgpt.com/c/owned-chat');
  assert.equal(result.conversationUrl, 'https://chatgpt.com/c/owned-chat');
  await assert.rejects(readWebResult(page, [q('1')], 'nonce', ['wrong-parent'], 'https://chatgpt.com/c/owned-chat'), /FOREIGN_CONVERSATION/);
  await assert.rejects(readWebResult(page, [q('1')], 'nonce', ['parent'], 'https://other.example/c/owned-chat'), /SCOPE_MISMATCH/);
});

test('clarification validates the full pinned history without inspecting virtualized user turns', async () => {
  const messages = [{ role: 'user', text: 'requestId first' }, { role: 'assistant', endTurn: true, text: 'answer' },
    { role: 'user', text: 'requestId second' }];
  const page = { url: () => 'https://chatgpt.com/c/owned-chat',
    evaluate: async (_fn, path) => { assert.equal(path, '/c/owned-chat'); return messages; },
    locator: () => assert.fail('virtualized history must not be read from DOM') };
  await verifyWebParents(page, ['first', 'second']);
  for (const parents of [[], ['first'], ['second', 'first'], ['first', 'foreign']]) {
    await assert.rejects(verifyWebParents(page, parents), /GPT_WEB_FOREIGN_CONVERSATION/);
  }
  await assert.rejects(verifyWebParents({ ...page, url: () => 'https://other.example/c/owned-chat' }, ['first', 'second']), /SCOPE_MISMATCH/);
  await assert.rejects(verifyWebParents({ ...page, evaluate: async () => ({ error: 'GPT_WEB_CONVERSATION_UNAVAILABLE' }) }, ['first']), /CONVERSATION_UNAVAILABLE/);
});

test('Jev rejects incomplete probabilities, insufficient context, partial multiple and excluded answers', () => {
  const question = q('1');
  const packet = jevPacket([question], 'Context');
  assert.deepEqual(parseJev(packet, response(packet)).get('1').answer, [options[0].id]);
  assert.equal(parseJev(packet, response(packet, 'insufficient_context')).size, 0);
  const bad = response(packet); bad.answers.q1.probabilities = { o0: 1 };
  assert.equal(parseJev(packet, bad).size, 0);
  const excluded = jevPacket([q('1', { memory: { status: 'unresolved', excludedAnswers: [[options[0].id]] } })], 'Context');
  assert.equal(parseJev(excluded, response(excluded)).size, 0);
  const multi = jevPacket([q('1', { type: 'multiple' })], 'Context');
  const raw = { model: 'jev-1.13.0', answers: { q1_o0: { type: 'noul', noul: 0.99 }, q1_o1: { type: 'noul', noul: 0.5 } } };
  assert.equal(parseJev(multi, raw).size, 0);
  raw.answers.q1_o1.noul = 0.01;
  assert.deepEqual(parseJev(multi, raw).get('1').answer, [options[0].id]);
  const duplicate = jevPacket([q('1', { options: [options[0], options[0], options[1]] })], 'Context');
  assert.equal(parseJev(duplicate, response(duplicate, 'o0')).size, 0);
  assert.deepEqual(parseJev(duplicate, response(duplicate, 'o2')).get('1').answer, [options[1].id]);
});

test('cascade skips known answers, forwards only unresolved and reuses dispatch checkpoint', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'batch-cascade-'));
  try {
    const questions = [q('1', { memory: { status: 'known', answer: [options[1].id], excludedAnswers: [] } }), q('2'), q('3', { type: 'text', options: [] })];
    let jevCalls = 0;
    const jev = async packet => { jevCalls++; assert.equal(packet.bindings.length, 1); return response(packet); };
    const web = async batch => { assert.deepEqual(batch.map(q => q.slot), ['2', '3']);
      return batch.map(q => ({ slot: q.slot, provider: 'gpt_web', answer: q.type === 'text' ? 'term' : [options[0].id], status: 'candidate' })); };
    const context = { status: 'ready', text: 'Sample context. '.repeat(20), contextHash: 'test-context' };
    const result = await solveTest(questions, context, { journalDir: dir, jev, web });
    assert.deepEqual(result.map(q => q.decision.provider), ['memory', 'jev', 'gpt_web']);
    await solveTest(questions, context, { journalDir: dir, jev, web });
    assert.equal(jevCalls, 1);
    await solveTest([q('4')], { status: 'missing', text: '', contextHash: null }, { journalDir: dir, jev: () => assert.fail('no context'), web: async batch => [{ slot: batch[0].slot, answer: null, status: 'needs_review' }] });
    let dispatches = 0;
    const path = join(dir, 'unknown.json');
    await assert.rejects(checkpointed(path, async () => { dispatches++; throw new Error('timeout'); }), /timeout/);
    await assert.rejects(checkpointed(path, async () => { dispatches++; }), /UNKNOWN_MODEL_OUTCOME/);
    assert.equal(dispatches, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Web validates request identity, coverage, answers and observed source links', async () => {
  const question = q('1');
  const result = { requestId: 'nonce', answers: [{ slot: '1', answer: [options[1].id], needsReview: false, sourceUrls: ['https://source.example/one'] }] };
  assert.equal(parseWeb(JSON.stringify(result), [question], 'nonce', result.answers[0].sourceUrls)[0].status, 'candidate');
  assert.equal(parseWeb(JSON.stringify(result), [question], 'nonce', [])[0].status, 'needs_review');
  for (const wrapped of [`<CodeBlock language="json" editable={true}>\n${JSON.stringify(result)}\n</CodeBlock>`,
    `<escape>${JSON.stringify(result)}</escape>`]) {
    assert.equal(parseWeb(wrapped, [question], 'nonce', result.answers[0].sourceUrls)[0].status, 'candidate');
  }
  assert.throws(() => parseWeb(`<CodeBlock>${JSON.stringify(result)}</CodeBlock> trailing prose`, [question], 'nonce', []), /INVALID_WEB_JSON/);
  const unicode = 'https://source.example/Документ_(тест)';
  const encoded = 'https://source.example/%D0%94%D0%BE%D0%BA%D1%83%D0%BC%D0%B5%D0%BD%D1%82_%28%D1%82%D0%B5%D1%81%D1%82%29';
  const linked = url => JSON.stringify({ ...result, answers: [{ ...result.answers[0], sourceUrls: [url] }] });
  assert.equal(parseWeb(linked(unicode), [question], 'nonce', [encoded])[0].status, 'candidate');
  assert.equal(parseWeb(linked('https://source.example/a/b'), [question], 'nonce', ['https://source.example/a%2Fb'])[0].status, 'needs_review');
  assert.equal(parseWeb(linked('https://source.example/a?x=1'), [question], 'nonce', ['https://source.example/a?x=2'])[0].status, 'needs_review');
  assert.throws(() => parseWeb(JSON.stringify(result), [question], 'different', []), /INCOMPLETE_WEB_RESPONSE/);
  const excluded = parseWeb(JSON.stringify(result), [q('1', { memory: { excludedAnswers: [[options[1].id]] } })], 'nonce', [])[0];
  assert.equal(excluded.status, 'needs_review'); assert.equal(excluded.answer, null);
  assert.equal(excluded.reviewReason, 'excluded_answer');
  assert.ok(!webPrompt([question], { text: '' }, 'nonce').includes('sequencecheck'));
  const explanation = 'Источники подтверждают несколько вариантов, но разрешён только один ответ.';
  const uncertain = { ...result, answers: [{ ...result.answers[0], needsReview: true, confidence: 0.99, reviewExplanation: explanation }] };
  const reviewed = parseWeb(JSON.stringify(uncertain), [question], 'nonce', result.answers[0].sourceUrls)[0];
  assert.equal(reviewed.status, 'needs_review', 'an explanation and high confidence cannot authorize an uncertain answer');
  assert.equal(reviewed.reviewExplanation, explanation);
  assert.equal(parseWeb(JSON.stringify({ ...uncertain, answers: [{ ...uncertain.answers[0], reviewExplanation: 'x'.repeat(500) }] }), [question], 'nonce', [])[0].reviewExplanation.length, 400);
  const clarification = JSON.parse(webPrompt([{ ...question, reviewReason: 'model_uncertain', previousReviewExplanation: explanation }], { text: '' }, 'nonce').split('\n').at(-1));
  assert.equal(clarification.questions[0].previousReviewExplanation, explanation);
  await assert.rejects(readyWeb({ title: async () => 'Just a moment...' }), /GPT_WEB_CHALLENGE/);
});

test('web verification revisits only needs_review questions and reuses escalation journals', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'batch-verify-'));
  const questions = [q('1'), q('2')];
  const context = { status: 'missing', text: '', contextHash: null };
  const calls = [];
  const notified = [];
  const web = (batch, context, options) => checkpointed(options.journalPath, async () => {
    calls.push(batch.map(q => q.slot));
    if (calls.length === 2) {
      assert.ok(notified.some(states => states[0] === 'needs_review' && states[1] === 'candidate'));
      assert.equal(batch[0].reviewReason, 'context_quote_not_found');
      assert.equal(batch[0].previousEvidence.quote, 'A quote missing from the material.');
      const input = JSON.parse(webPrompt(batch, context, options.requestId).split('\n').at(-1));
      assert.equal(input.questions[0].reviewReason, batch[0].reviewReason);
    }
    return batch.map(question => ({ slot: question.slot, provider: 'gpt_web', answer: [question.options[0].id],
      reviewReason: 'context_quote_not_found', evidence: { kind: 'context', quote: 'A quote missing from the material.' },
      status: question.slot === '1' && !Object.hasOwn(question, 'previousUnverifiedAnswer') ? 'needs_review' : 'candidate' }));
  });
  try {
    const result = await solveTest(questions, context, { journalDir: dir, web, onAnswers: answers => { notified.push(answers.map(q => q.decision?.status)); } });
    assert.deepEqual(calls, [['1', '2'], ['1']]);
    assert.deepEqual(result.map(q => q.decision.status), ['candidate', 'candidate']);
    await solveTest(questions, context, { journalDir: dir, web });
    assert.equal(calls.length, 2);
    let attempts = 0;
    await solveTest([q('3')], context, { journalDir: dir, web: async batch => {
      attempts++; return batch.map(q => ({ slot: q.slot, answer: null, status: 'needs_review' }));
    } });
    assert.equal(attempts, 3, 'Instant, Medium and High are bounded when no reliable answer exists');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('shared packets preserve test context, avoid slot collisions, and escalate only uncertain questions in the same conversation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'batch-shared-'));
  const contexts = { documents: { first: { status: 'ready', text: 'Alpha lecture. '.repeat(20), contextHash: 'alpha' },
    second: { status: 'ready', text: 'Beta lecture. '.repeat(20), contextHash: 'beta' } } };
  const questions = [q('20:30:1', { nativeSlot: '1', contextId: 'first' }),
    q('21:31:1', { nativeSlot: '1', quizId: '21', attemptId: '31', contextId: 'second', memory: { status: 'unresolved', excludedAnswers: [[options[0].id]] } })];
  let jevCalls = 0;
  const calls = [];
  try {
    const result = await solveTest(questions, contexts, { journalDir: dir,
      jev: async packet => { jevCalls++; assert.equal(packet.bindings.length, 2);
        assert.equal(packet.payload.questions.q1.instructions.contextId, 'first');
        assert.equal(packet.payload.questions.q2.instructions.contextId, 'second');
        return response(packet); },
      web: async (batch, context, opts) => {
        calls.push({ slots: batch.map(q => q.slot), reasoning: opts.reasoning, parents: opts.parentRequestId, id: opts.requestId });
        const prompt = JSON.parse(webPrompt(batch, context, opts.requestId).split('\n').at(-1));
        assert.equal(prompt.contexts.first, contexts.documents.first.text);
        assert.equal(prompt.contexts.second, contexts.documents.second.text);
        return batch.map(q => ({ slot: q.slot, provider: 'gpt_web', answer: [options[q.quizId === '20' ? 0 : 1].id],
          status: q.quizId === '21' && opts.reasoning !== 'high' ? 'needs_review' : 'candidate', conversationUrl: 'https://chatgpt.com/c/synthetic' }));
      } });
    assert.equal(jevCalls, 1);
    assert.deepEqual(calls.map(c => c.slots), [['20:30:1', '21:31:1'], ['21:31:1'], ['21:31:1']]);
    assert.deepEqual(calls.map(c => c.reasoning), ['instant', 'medium', 'high']);
    assert.deepEqual(calls[2].parents, [calls[0].id, calls[1].id]);
    assert.deepEqual(result.map(q => q.decision.answer), [[options[0].id], [options[1].id]]);
    assert.equal(result[0].decision.provider, 'jev');
    const pending = join(dir, `${'a'.repeat(64)}.json`);
    await writeFile(pending, JSON.stringify({ state: 'pending', questionIds: ['21:31:1'] }));
    await assert.rejects(solveTest(questions.slice(1), contexts, { journalDir: dir, web: () => assert.fail('regrouped pending request') }), /UNKNOWN_MODEL_OUTCOME/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('verified cached answers survive regrouping but changed wording, context or exclusions requires a new decision', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'batch-regroup-'));
  const question = q('20:30:1');
  const context = { status: 'missing', text: '', contextHash: null };
  try {
    await writeFile(join(dir, `${'b'.repeat(64)}.json`), JSON.stringify({ state: 'complete',
      bindings: [{ slot: question.slot, fingerprint: questionFingerprint(question, context) }],
      result: { answers: [{ slot: question.slot, status: 'candidate', answer: [options[0].id], provider: 'gpt_web', evidenceVerified: true, semanticVerified: true }] } }));
    const [cached] = await solveTest([question], context, { journalDir: dir, web: () => assert.fail('verified answer must be reused') });
    assert.equal(cached.decision.cached, true);
    const path = join(dir, `${'b'.repeat(64)}.json`), saved = JSON.parse(await readFile(path, 'utf8'));
    delete saved.result.answers[0].semanticVerified;
    await writeFile(path, JSON.stringify(saved));
    let rechecked = false;
    await solveTest([question], context, { journalDir: dir, web: async () => {
      rechecked = true; return [{ ...saved.result.answers[0], semanticVerified: true }];
    } });
    assert.equal(rechecked, true, 'regrouped old cache cannot skip semantic checks');
    for (const [changed, material] of [[{ ...question, text: 'A changed question?' }, context], [question, { ...context, contextHash: 'new' }],
      [{ ...question, memory: { ...question.memory, excludedAnswers: [[options[0].id]] } }, context]]) {
      let called = false;
      await solveTest([changed], material, { journalDir: dir, web: async batch => { called = true; return batch.map(q => ({ slot: q.slot, answer: [options[1].id], status: 'candidate' })); } });
      assert.equal(called, true);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('unsupported deadline claims cannot be accepted from fresh or regrouped cached answers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'batch-deadline-review-'));
  const context = { status: 'missing', text: '', contextHash: null };
  const choices = ['срок не определен', 'в последний день работы'].map(text => ({ id: optionId(text), text }));
  const question = q('1', { options: choices });
  const unsupported = { slot: '1', provider: 'gpt_web', status: 'candidate', answer: [choices[0].id], confidence: 0.99,
    evidenceVerified: true, evidence: { kind: 'web', quote: 'Работник должен быть ознакомлен с приказом под роспись.' } };
  try {
    await writeFile(join(dir, `${'d'.repeat(64)}.json`), JSON.stringify({ state: 'complete',
      bindings: [{ slot: '1', fingerprint: questionFingerprint(question, context) }], result: { answers: [unsupported] } }));
    const efforts = [];
    const [result] = await solveTest([question], context, { journalDir: dir, web: async (batch, material, opts) => {
      efforts.push(opts.reasoning);
      if (opts.reasoning === 'instant') return [unsupported];
      assert.equal(batch[0].reviewReason, 'evidence_not_supportive');
      assert.match(webPrompt(batch, material, opts.requestId), /evidence_not_supportive означает/);
      return [{ ...unsupported, answer: [choices[1].id], evidence: { kind: 'web', quote: 'В день увольнения (последний день работы) ознакомьте работника с приказом под роспись.' } }];
    } });
    assert.deepEqual(efforts, ['instant', 'medium']);
    assert.deepEqual(result.decision.answer, [choices[1].id]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('multiple answers check omitted options at Medium even with 99% confidence and reuse the checked result', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'batch-multiple-review-'));
  const context = { status: 'missing', text: '', contextHash: null };
  const questions = [q('1', { type: 'multiple' }), q('2'), q('3', { type: 'multiple', memory: { status: 'known', answer: [options[0].id] } })];
  const calls = [], snapshots = [];
  const web = (batch, material, opts) => checkpointed(opts.journalPath, async () => {
    calls.push({ effort: opts.reasoning, slots: batch.map(q => q.slot) });
    if (opts.reasoning === 'medium') {
      assert.equal(batch[0].reviewReason, 'multiple_completeness');
      assert.equal(opts.continueUrl, 'https://chatgpt.com/c/multiple');
      assert.ok(snapshots.some(s => s[0] === 'needs_review' && s[1] === 'candidate' && s[2] === 'confirmed'));
      assert.match(webPrompt(batch, material, opts.requestId), /включая не выбранные ранее/);
    }
    return { reasoning: opts.reasoning === 'medium' ? 'Средний' : 'Instant', answers: batch.map(q => ({ slot: q.slot,
      provider: 'gpt_web', status: 'candidate', confidence: 0.99, evidenceVerified: true, semanticVerified: true,
      answer: q.type === 'multiple' && opts.reasoning === 'medium' ? options.map(o => o.id) : [options[0].id],
      ...(q.type === 'multiple' && opts.reasoning === 'medium' ? { optionsVerified: true,
        optionChecks: options.map(o => ({ optionId: o.id, selected: true, reason: 'The source explicitly includes this option.' })) } : {}),
      conversationUrl: 'https://chatgpt.com/c/multiple' })) };
  }, opts.questionIds, opts.bindings).then(result => result.answers);
  try {
    const result = await solveTest(questions, context, { journalDir: dir, web, onAnswers: answers => snapshots.push(answers.map(q => q.decision?.status)) });
    assert.deepEqual(calls, [{ effort: 'instant', slots: ['1', '2'] }, { effort: 'medium', slots: ['1'] }]);
    assert.deepEqual(result[0].decision.answer, options.map(o => o.id));
    assert.equal(result[2].decision.provider, 'memory');
    const cached = await solveTest(questions, context, { journalDir: dir, web: () => assert.fail('checked multiple answer must be reused') });
    assert.deepEqual(cached[0].decision.answer, options.map(o => o.id));
    assert.equal(cached[0].decision.reasoning, 'Средний');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('independent context packets get Instant answers before clarification and retain their own conversation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'batch-instant-first-'));
  const context = { documents: { first: { status: 'missing', text: 'Alpha '.repeat(10000), contextHash: 'first' },
    second: { status: 'missing', text: 'Beta '.repeat(12000), contextHash: 'second' } } };
  const questions = [q('20:30:1', { contextId: 'first', text: 'Alpha question?' }),
    q('21:31:1', { contextId: 'second', quizId: '21', attemptId: '31', text: 'Beta question?' })];
  const calls = [], ready = new Set();
  const web = (batch, material, opts) => checkpointed(opts.journalPath, async () => {
    assert.equal(batch.length, 1);
    const question = batch[0];
    calls.push(`${opts.reasoning}:${question.contextId}`);
    assert.deepEqual(Object.keys(material.documents), [question.contextId]);
    if (opts.reasoning !== 'instant') assert.equal(opts.continueUrl, 'https://chatgpt.com/c/first', 'another packet must not switch the clarification chat');
    return { answers: [{ slot: question.slot, provider: 'gpt_web', answer: [options[0].id], evidenceVerified: true, semanticVerified: true,
      status: question.contextId === 'first' && opts.reasoning !== 'high' ? 'needs_review' : 'candidate',
      conversationUrl: `https://chatgpt.com/c/${question.contextId}` }] };
  }, opts.questionIds, opts.bindings).then(result => result.answers);
  try {
    const result = await solveTest(questions, context, { journalDir: dir, web, onAnswers: answers => {
      for (const q of answers) if (q.decision?.status === 'candidate' && !ready.has(q.contextId)) {
        ready.add(q.contextId); calls.push(`ready:${q.contextId}`);
      }
    } });
    assert.deepEqual(calls, ['instant:first', 'instant:second', 'ready:second', 'medium:first', 'high:first', 'ready:first']);
    assert.ok(result.every(q => q.decision.status === 'candidate'));
    await solveTest(questions, context, { journalDir: dir, web: () => assert.fail('completed answers must be reused') });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('borderline completed answers cannot bypass Medium and High clarification through the verified cache', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'batch-confidence-'));
  const question = q('20:30:1'), context = { status: 'missing', text: '', contextHash: null };
  const savedAnswer = { slot: question.slot, status: 'candidate', answer: [options[0].id], provider: 'gpt_web', evidenceVerified: true, confidence: 0.86 };
  try {
    const journalPath = join(dir, `${'c'.repeat(64)}.json`);
    await writeFile(journalPath, JSON.stringify({ state: 'complete', bindings: [{ slot: question.slot, fingerprint: questionFingerprint(question, context) }], result: { answers: [savedAnswer] } }));
    const cachedWeb = webSolver({ extension: true, connect: () => assert.fail('completed request must not be resent') });
    const [old] = await cachedWeb([question], context, { journalPath });
    assert.equal(old.status, 'needs_review'); assert.equal(old.evidenceVerified, false);
    await cachedWeb.close();
    const efforts = [];
    const [solved] = await solveTest([question], context, { journalDir: dir, web: async (batch, _, opts) => {
      efforts.push(opts.reasoning);
      return batch.map(q => ({ ...savedAnswer, slot: q.slot, confidence: opts.reasoning === 'high' ? 0.95 : 0.86 }));
    } });
    assert.deepEqual(efforts, ['instant', 'medium', 'high']);
    assert.equal(solved.decision.status, 'candidate'); assert.equal(solved.decision.confidence, 0.95);
    assert.equal(solved.decision.cached, undefined);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('packets split large distinct contexts instead of mixing or silently truncating them to tiny excerpts', () => {
  const questions = Array.from({ length: 3 }, (_, i) => q(String(i), { contextId: String(i) }));
  const context = { documents: Object.fromEntries(questions.map(q => [q.contextId, { text: 'A'.repeat(60000) }])) };
  assert.deepEqual(questionPackets(questions, context).map(b => b.length), [1, 1, 1]);
  const shared = questions.map(q => ({ ...q, contextId: '0' }));
  assert.equal(questionPackets(shared, context).length, 1);
});

test('matching context excerpts include terms from row labels and answer options', () => {
  const question = q('1', { type: 'matching', text: 'Сопоставьте', options: [], rows: [
    { text: 'Альбит', options: [{ text: 'Плагиоклаз' }] }
  ] });
  const text = 'irrelevant '.repeat(800) + ' Альбит относится к группе плагиоклазов. ' + 'irrelevant '.repeat(800);
  const excerpt = selectContext(text, [question], 2402);
  assert.ok(excerpt.includes('Альбит относится к группе плагиоклазов.'));
  assert.match(excerpt, /ВЫДЕРЖКА/);
  assert.match(excerpt, /Фрагмент \d+ из \d+; исходные символы \d+–\d+/u);
  assert.ok(excerpt.length <= 2402);
  assert.equal(selectContext('Full uncut material', [question], 2402), 'Full uncut material');
});

test('oversized questions are rejected both first and after a packet split for each provider', () => {
  const context = { text: '' };
  const normal = q('1');
  const oversized = q('2', { text: 'A'.repeat(10000) });
  for (const provider of ['web', 'jev']) {
    assert.throws(() => questionPackets([oversized], context, 5000, 40, provider), /QUESTION_PACKET_TOO_LARGE/);
    assert.throws(() => questionPackets([normal, oversized], context, 5000, 40, provider), /QUESTION_PACKET_TOO_LARGE/);
    assert.deepEqual(questionPackets([normal, q('3')], context, 5000, 1, provider).map(b => b.length), [1, 1]);
  }
});

test('Jev strips native matching fields and sends individually oversized questions to Web without stopping other tests', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'batch-large-matching-'));
  const rows = Array.from({ length: 7 }, (_, i) => {
    const text = `Row ${i}`;
    const options = Array.from({ length: 7 }, (_, j) => {
      const text = `Option ${j} ` + 'A'.repeat(140);
      return { id: optionId(text), text, nativeValue: 'native-value' };
    });
    return { id: digest(['row-v1', text, options.map(o => o.text).sort()]), text, fieldName: 'native-field', options };
  });
  const matching = q('2', { type: 'matching', options: [], rows });
  const packet = jevPacket([matching], 'material');
  assert.ok(!JSON.stringify(packet.payload).includes('native-field'));
  assert.ok(!JSON.stringify(packet.payload).includes('native-value'));
  assert.deepEqual(packet.payload.questions.q1_r0.instructions.matchingRows[6].options, rows[6].options.map(o => o.text));
  const context = { status: 'ready', text: 'Course material. '.repeat(2000), contextHash: 'large' };
  let jevCalls = 0, webCalls = 0;
  try {
    const solved = await solveTest([q('1'), matching], context, { journalDir: dir,
      jev: async packet => { jevCalls++; assert.deepEqual(packet.bindings.map(b => b.q.slot), ['1']); return response(packet); },
      web: async batch => { webCalls++; assert.deepEqual(batch.map(q => q.slot), ['1', '2']); assert.deepEqual(batch[1].rows, rows);
        return batch.map(q => ({ slot: q.slot, status: 'candidate', answer: q.type === 'matching'
          ? Object.fromEntries(rows.map(r => [r.id, r.options[0].id])) : [options[0].id] })); }
    });
    assert.equal(jevCalls, 1); assert.equal(webCalls, 1);
    assert.ok(solved.every(q => q.decision.status === 'candidate'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('context discovery chooses materials preceding the exact test; text extraction caches source hash', async () => {
  const parser = await openParser();
  const dir = await mkdtemp(join(tmpdir(), 'batch-context-'));
  try {
    const html = '<body id="page-course-view-topics" class="course-10"><li class="section"><div class="activity"><a href="/mod/resource/view.php?id=7">Lesson</a></div><div class="activity"><a href="/mod/quiz/view.php?id=20">Quiz</a></div><div class="activity"><a href="/mod/resource/view.php?id=8">Next lesson</a></div><div class="activity"><a href="/mod/quiz/view.php?id=21">Next quiz</a></div></li></body>';
    const refs = await parser.materials(html, 'https://moodle.example', '10', '20');
    assert.deepEqual(refs.map(r => new URL(r.url).searchParams.get('id')), ['7']);
    assert.deepEqual((await parser.quizzes(html, 'https://moodle.example', '10')).map(q => q.quizId), ['20', '21']);
    const material = { buffer: Buffer.from('Useful lecture text. '.repeat(20)), mime: 'text/plain', title: 'Lesson' };
    const first = await extractMaterial(material, dir);
    assert.equal(first.cacheHit, false);
    assert.equal((await extractMaterial(material, dir)).cacheHit, true);
    const changed = await extractMaterial({ ...material, buffer: Buffer.from('Different lecture. '.repeat(20)) }, dir);
    assert.notEqual(changed.contentHash, first.contentHash);
    const context = await loadContext({ materials: async () => refs, downloadMaterial: async () => material }, { origin: 'https://moodle.example', userScope: 'u1', courseId: '10' }, dir);
    assert.equal(context.status, 'ready');
    assert.equal((await loadContext({ materials: async () => refs, downloadMaterial: async () => { throw new Error(); } }, {}, dir)).status, 'missing');
  } finally { await parser.close(); await rm(dir, { recursive: true, force: true }); }
});

test('Web dispatch on a synthetic page sends once and reads completed JSON with citations', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'batch-web-'));
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await context.route('https://chatgpt.com/**', route => new URL(route.request().url()).pathname === '/backend-api/f/conversation'
      ? route.fulfill({ body: 'data: [DONE]\n\n', contentType: 'text/event-stream' })
      : route.fulfill({ contentType: 'text/html', body: `<title>ChatGPT fixture</title>
      <div role="textbox" contenteditable="true"></div><button data-testid="composer-plus-btn" onclick="document.querySelector('[role=menuitem]').hidden=false">Tools</button>
      <button role="menuitem" hidden onclick="this.hidden=true">Search the web</button>
      <button data-testid="send-button" onclick="send()">Send</button><script>
      window.dispatches=0;
      async function send(){window.dispatches++;await fetch('/backend-api/f/conversation',{method:'POST'});const text=document.querySelector('[role=textbox]').innerText;const id=/requestId[^a-zA-Z0-9]+([a-zA-Z0-9]+)/.exec(text)[1];
      const user=document.createElement('div');user.dataset.messageAuthorRole='user';user.textContent=text;document.body.append(user);
      const assistant=document.createElement('div');assistant.dataset.messageAuthorRole='assistant';
      const pre=document.createElement('pre');const code=document.createElement('code');code.textContent=JSON.stringify({requestId:id,answers:[{slot:'1',answer:['${options[0].id}'],needsReview:false,evidence:{kind:'context',quote:'Sample material supports Alpha.'},sourceUrls:['https://source.example/one']}]});pre.append(code);assistant.append(pre);
      const source=document.createElement('a');source.href='https://source.example/one';source.textContent='Source';assistant.append(source);document.body.append(assistant);
      const copy=document.createElement('button');copy.dataset.testid='copy-turn-action-button';document.body.append(copy);}
      </script>` }));
    await page.goto('https://chatgpt.com/');
    await page.evaluate(() => {
      const editor = document.querySelector('[role=textbox]'); editor.textContent = 'Restoring editor';
      setTimeout(() => { editor.textContent = ''; }, 100);
    });
    const material = { text: 'Sample material supports Alpha.' };
    const answer = await dispatchWeb(page, [q('1')], material, { requestId: 'nonce', journalPath: join(dir, 'web.json'), reasoning: 'current' });
    assert.equal(answer[0].status, 'candidate');
    assert.equal(await page.evaluate(() => window.dispatches), 1);
    for (const [id, parents] of [['second', ['nonce']], ['third', ['nonce', 'second']]]) {
      await page.locator('[role="textbox"]').fill('');
      const followup = await dispatchWeb(page, [q('1')], material, { requestId: id,
        parentRequestId: parents, journalPath: join(dir, `${id}.json`), reasoning: 'current' });
      assert.equal(followup[0].evidenceVerified, true);
    }
    assert.equal(await page.evaluate(() => window.dispatches), 3);
    await page.locator('[role="textbox"]').fill('A real user draft');
    await assert.rejects(dispatchWeb(page, [q('1')], material, { requestId: 'fourth',
      parentRequestId: ['nonce', 'second', 'third'], journalPath: join(dir, 'fourth.json'), reasoning: 'current' }), /GPT_WEB_FOREIGN_DRAFT/);
    assert.equal(await page.locator('[role="textbox"]').innerText(), 'A real user draft');
    assert.equal(await page.evaluate(() => window.dispatches), 3);
    await page.locator('[role="textbox"]').fill('');
    const locator = page.locator.bind(page);
    page.locator = (selector, ...args) => {
      const result = locator(selector, ...args);
      if (selector.startsWith('button[data-testid="send-button"]')) {
        const first = result.first.bind(result);
        result.first = () => {
          const button = first();
          button.click = async () => { throw Object.assign(new Error('send click timed out'), { name: 'TimeoutError' }); };
          return button;
        };
      }
      return result;
    };
    const failedPath = join(dir, 'send-failed.json');
    await assert.rejects(dispatchWeb(page, [q('1')], material, { requestId: 'send-failed',
      parentRequestId: ['nonce', 'second', 'third'], journalPath: failedPath, reasoning: 'current',
      questionIds: ['quiz:attempt:1'], bindings: [{ slot: '1', fingerprint: 'binding' }] }), /UNKNOWN_WEB_OUTCOME/);
    const pending = JSON.parse(await readFile(failedPath, 'utf8'));
    assert.equal(pending.state, 'pending');
    assert.equal(pending.requestId, 'send-failed');
    assert.equal(pending.conversationUrl, 'https://chatgpt.com/');
    assert.deepEqual(pending.questionIds, ['quiz:attempt:1']);
    assert.deepEqual(pending.bindings, [{ slot: '1', fingerprint: 'binding' }]);
    await assert.rejects(checkpointed(failedPath, () => assert.fail('unknown click must not be retried')), /UNKNOWN_MODEL_OUTCOME/);
    assert.equal(await page.evaluate(() => window.dispatches), 3);
  } finally { await browser.close(); await rm(dir, { recursive: true, force: true }); }
});

test('Web readiness activates its own tab before waiting for the composer', async () => {
  const calls = [];
  const composer = { waitFor: async () => { calls.push('composer'); } };
  const page = { bringToFront: async () => { calls.push('foreground'); }, title: async () => 'ChatGPT',
    url: () => 'https://chatgpt.com/', locator: selector => selector.startsWith('iframe')
      ? { count: async () => 0 } : { first: () => composer } };
  assert.equal(await readyWeb(page), composer);
  assert.deepEqual(calls, ['foreground', 'composer']);
});

test('reasoning selector changes Instant to verified High and rejects a menu that cannot provide it', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(`<button aria-label="Выбрать модель ChatGPT" onclick="document.querySelector('[role=menu]').hidden=false">Уровень усилий рассужденияInstant</button>
      <div role="menu" hidden><span role="status">Instant, 1 из 3.</span>
      <div data-reasoning-slider="true" tabindex="0" style="width:200px;height:24px"><span role="slider" aria-valuenow="0" aria-valuemax="2"></span></div></div>
      <script>window.keys=0;window.levels=['Instant','Medium','High'];
      document.addEventListener('keydown',e=>{if(e.key==='Escape'){document.querySelector('[role=menu]').hidden=true;return;}
      if(!['ArrowRight','ArrowLeft'].includes(e.key))return;window.keys++;
      const t=document.querySelector('[role=slider]');let n=Math.max(0,Math.min(Number(t.getAttribute('aria-valuemax')),Number(t.getAttribute('aria-valuenow'))+(e.key==='ArrowRight'?1:-1)));
      t.setAttribute('aria-valuenow',String(n));document.querySelector('[role=status]').textContent=window.levels[n]+', '+(n+1)+' из 3.';
      document.querySelector('button').textContent='Уровень усилий рассуждения'+window.levels[n];});</script>`);
    assert.equal(await selectWebReasoning(page), 'High');
    assert.equal(await page.locator('button').textContent(), 'Уровень усилий рассужденияHigh');
    assert.equal(await page.evaluate(() => window.keys), 2);
    assert.equal(await selectWebReasoning(page, 'instant'), 'Instant');
    assert.equal(await selectWebReasoning(page, 'medium'), 'Medium');
    assert.equal(await selectWebReasoning(page), 'High');
    assert.equal(await selectWebReasoning(page), 'High');
    assert.equal(await page.evaluate(() => window.keys), 6);
    await page.evaluate(() => {
      const control = document.querySelector('[data-reasoning-slider]');
      control.addEventListener('keydown', e => {
        if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
        e.stopPropagation();
        setTimeout(() => {
          const thumb = document.querySelector('[role=slider]');
          const n = Math.max(0, Math.min(2, Number(thumb.getAttribute('aria-valuenow')) + (e.key === 'ArrowRight' ? 1 : -1)));
          thumb.setAttribute('aria-valuenow', String(n));
          document.querySelector('[role=status]').textContent = window.levels[n] + ', ' + (n + 1) + ' из 3.';
          document.querySelector('button').textContent = 'Уровень усилий рассуждения' + window.levels[n];
        }, 100);
      });
    });
    assert.equal(await selectWebReasoning(page, 'instant'), 'Instant');
    assert.equal(await selectWebReasoning(page, 'medium'), 'Medium');
    assert.equal(await selectWebReasoning(page, 'high'), 'High');

    await page.evaluate(() => {
      document.querySelector('[role=slider]').setAttribute('aria-valuenow', '0');
      document.querySelector('[role=slider]').setAttribute('aria-valuemax', '1');
      document.querySelector('[role=status]').textContent = 'Instant, 1 из 2.';
    });
    await assert.rejects(selectWebReasoning(page), /GPT_WEB_REASONING_UNAVAILABLE/);
  } finally { await browser.close(); }
});
