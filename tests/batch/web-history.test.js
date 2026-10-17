import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { chromium } from 'playwright';
import { observeWebHistory, nativeWebHistory, nativeConversationMessages, clearWebHistory, waitForWebGeneration, rememberWebRead, checkWebReadLimit } from '../../batch/web-history.js';
import { openWebPage, verifyWebParents, readWebResult } from '../../batch/web.js';

const target = 'https://chatgpt.com/c/owned-history';
const data = () => ({ conversation_id: 'owned-history', current_node: 'answer',
  page_info: { has_previous_page: false, has_next_page: false }, messages: [
    { id: 'user', author: { role: 'user' }, content: { content_type: 'text', parts: ['requestId nonce'] } },
    { id: 'answer', author: { role: 'assistant' }, end_turn: true, content: { content_type: 'text', parts: [JSON.stringify({
      requestId: 'nonce', answers: [{ slot: '1', answer: ['alpha'], needsReview: false, sourceUrls: [] }],
    })] } },
  ] });

test('native history waits for its body, verifies parents and reads the reply without a second GET', async () => {
  const browser = await chromium.launch();
  let release;
  const loading = new Promise(resolve => { release = resolve; });
  const requests = [], logs = [];
  try {
    const page = await browser.newPage();
    observeWebHistory(page, detail => logs.push(detail));
    await page.route('https://chatgpt.com/**', async route => {
      const path = new URL(route.request().url()).pathname; requests.push(path);
      if (path === '/c/owned-history') return route.fulfill({ contentType: 'text/html', body:
        '<title>ChatGPT</title><div role="textbox" contenteditable="true"></div><script>setTimeout(() => fetch("/backend-api/conversations/owned-history"), 100)</script>' });
      assert.equal(path, '/backend-api/conversations/owned-history', 'must not request auth or duplicate history');
      await loading; await route.fulfill({ json: data() });
    });
    const started = page.waitForRequest('**/backend-api/conversations/owned-history');
    await openWebPage(page, target); await started;
    let done = false;
    const pending = verifyWebParents(page, ['nonce']).then(() => { done = true; });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(done, false);
    release(); await pending;
    const question = { slot: '1', type: 'choice', text: 'Alpha?', options: [{ id: 'alpha', text: 'Alpha' }], memory: { excludedAnswers: [] } };
    assert.equal((await readWebResult(page, [question], 'nonce')).answers[0].answer[0], 'alpha');
    await assert.rejects(verifyWebParents(page, ['foreign']), /GPT_WEB_FOREIGN_CONVERSATION/);
    assert.deepEqual(requests, ['/c/owned-history', '/backend-api/conversations/owned-history']);
    assert.deepEqual(logs.map(e => [e.event, e.source, e.status]), [['request', 'page', undefined], ['response', 'page', 200]]);
    assert.equal(JSON.stringify(logs).includes('requestId'), false);
    clearWebHistory(page); assert.equal(await nativeWebHistory(page, target), undefined);
  } finally { release(); await browser.close(); }
});

test('native adapter rejects foreign identities and never trusts paginated, truncated or cyclic histories', () => {
  assert.throws(() => nativeConversationMessages({ ...data(), conversation_id: 'foreign' }, 'owned-history'), /SCOPE_MISMATCH/);
  for (const changes of [{ page_info: { has_previous_page: true, has_next_page: false } },
    { page_info: { has_previous_page: false, has_next_page: true } }, { page_info: undefined }, { current_node: 'missing' }]) {
    assert.equal(nativeConversationMessages({ ...data(), ...changes }, 'owned-history'), undefined);
  }
  const repeated = data(); repeated.messages.push(repeated.messages.at(-1));
  assert.throws(() => nativeConversationMessages(repeated, 'owned-history'), /INVALID_CONVERSATION/);
});

test('native rate limits hold fallback reads and preserve retry-after; batch reads are labelled separately', async () => {
  const page = new EventEmitter(), logs = [];
  observeWebHistory(page, detail => logs.push(detail));
  const request = { url: () => 'https://chatgpt.com/backend-api/conversations/owned-history', method: () => 'GET', headers: () => ({}) };
  page.emit('request', request);
  page.emit('response', { request: () => request, status: () => 429, ok: () => false, headers: () => ({ 'retry-after': '120' }) });
  await assert.rejects(nativeWebHistory(page, target), error => error.message === 'GPT_WEB_RATE_LIMITED' && error.retryMs === 120000);
  const batch = { ...request, headers: () => ({ 'x-moodle-batch-read': '1' }) };
  page.emit('request', batch);
  await assert.rejects(nativeWebHistory(page, target), /GPT_WEB_RATE_LIMITED/);
  assert.equal(logs.at(-1).source, 'batch');
  page.emit('close');
});


test('generation finishes before any history read, then the native history supplies the answer', async () => {
  const browser = await chromium.launch();
  let finish;
  const streaming = new Promise(resolve => { finish = resolve; });
  const requests = [], logs = [];
  try {
    const page = await browser.newPage(); observeWebHistory(page, detail => logs.push(detail));
    await page.route('https://chatgpt.com/**', async route => {
      const path = new URL(route.request().url()).pathname; requests.push(path);
      if (path === '/c/owned-history') return route.fulfill({ contentType: 'text/html', body:
        '<button onclick="fetch(\'/backend-api/f/conversation\', {method:\'POST\'}).then(r=>r.text()).then(()=>fetch(\'/backend-api/conversations/owned-history\'))">Send</button>' });
      if (path === '/backend-api/f/conversation') {
        await streaming;
        return route.fulfill({ contentType: 'text/event-stream', body: 'data: [DONE]\n\n' });
      }
      assert.equal(path, '/backend-api/conversations/owned-history', 'no reserve GET or session fetch while generating');
      return route.fulfill({ json: data() });
    });
    await page.goto(target); clearWebHistory(page);
    const posted = page.waitForRequest('**/backend-api/f/conversation');
    await page.getByRole('button', { name: 'Send' }).click(); await posted;
    let done = false;
    const pending = waitForWebGeneration(page).then(() => { done = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(done, false); assert.equal(requests.length, 2);
    finish(); await pending;
    assert.equal((await nativeWebHistory(page, target, 'nonce')).length, 2);
    assert.deepEqual(requests, ['/c/owned-history', '/backend-api/f/conversation', '/backend-api/conversations/owned-history']);
    assert.ok(logs.some(e => e.event === 'generation_finished'));
  } finally { finish(); await browser.close(); }
});

test('a cancelled transport ends the wait without creating an answer or resending', async () => {
  const page = new EventEmitter(); page.url = () => target; page.waitForRequest = async () => null; observeWebHistory(page);
  const request = { url: () => 'https://chatgpt.com/backend-api/f/conversation', method: () => 'POST', headers: () => ({}) };
  page.emit('request', request);
  const pending = waitForWebGeneration(page);
  page.emit('requestfailed', request);
  await pending;
  assert.equal(await nativeWebHistory(page, target), undefined, 'transport cancellation supplies no answer');
});


test('a complete reserve read is reused for parents and any new send invalidates it', async () => {
  const page = new EventEmitter(); page.url = () => target; page.waitForRequest = async () => null;
  page.evaluate = () => assert.fail('parent check must reuse the completed read');
  observeWebHistory(page);
  const messages = nativeConversationMessages(data(), 'owned-history');
  await rememberWebRead(page, target, async () => messages);
  await verifyWebParents(page, ['nonce']);
  const request = { url: () => 'https://chatgpt.com/backend-api/f/conversation', method: () => 'POST', headers: () => ({}) };
  page.emit('request', request);
  assert.equal(await nativeWebHistory(page, target), undefined, 'a manual send invalidates cached history too');
  page.emit('requestfailed', request);
  page.evaluate = async () => [...messages, { role: 'user', text: 'A manual message' }];
  await assert.rejects(verifyWebParents(page, ['nonce']), /GPT_WEB_FOREIGN_CONVERSATION/);
  page.emit('close');
});

test('a send racing a history read cannot cache or accept the old parent chain', async () => {
  const page = new EventEmitter(); observeWebHistory(page);
  let release;
  const pending = rememberWebRead(page, target, () => new Promise(resolve => { release = resolve; }));
  const request = { url: () => 'https://chatgpt.com/backend-api/conversation', method: () => 'POST', headers: () => ({}) };
  page.emit('request', request); release(nativeConversationMessages(data(), 'owned-history'));
  await assert.rejects(pending, /GPT_WEB_FOREIGN_CONVERSATION/);
  page.emit('close');
});


test('a native 429 pauses reserve reads across all pages of the same browser context', () => {
  const context = {}, first = new EventEmitter(), second = new EventEmitter();
  first.context = second.context = () => context;
  observeWebHistory(first); observeWebHistory(second);
  const request = { url: () => 'https://chatgpt.com/backend-api/conversations/owned-history', method: () => 'GET', headers: () => ({}) };
  first.emit('request', request);
  first.emit('response', { request: () => request, status: () => 429, ok: () => false, headers: () => ({ 'retry-after': '120' }) });
  assert.throws(() => checkWebReadLimit(second), error => error.message === 'GPT_WEB_RATE_LIMITED' && error.retryMs > 119000);
  const otherAccount = new EventEmitter(); observeWebHistory(otherAccount);
  assert.doesNotThrow(() => checkWebReadLimit(otherAccount));
  first.emit('close'); second.emit('close'); otherAccount.emit('close');
});


test('a cancelled stream can use a complete saved final history without treating cancellation as success alone', async () => {
  const page = new EventEmitter(); page.url = () => target; observeWebHistory(page);
  const generation = { url: () => 'https://chatgpt.com/backend-api/f/conversation', method: () => 'POST', headers: () => ({}) };
  const history = { url: () => 'https://chatgpt.com/backend-api/conversations/owned-history', method: () => 'GET', headers: () => ({}) };
  page.emit('request', generation); page.emit('request', history);
  page.emit('response', { request: () => history, status: () => 200, ok: () => true, headers: () => ({}), json: async () => data() });
  page.emit('requestfailed', generation);
  await waitForWebGeneration(page);
  await verifyWebParents(page, ['nonce']);
  await assert.rejects(verifyWebParents(page, ['foreign']), /GPT_WEB_FOREIGN_CONVERSATION/);
  page.emit('close');
});
