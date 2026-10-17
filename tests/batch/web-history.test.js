import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { chromium } from 'playwright';
import { observeWebHistory, nativeWebHistory, nativeConversationMessages, clearWebHistory } from '../../batch/web-history.js';
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
