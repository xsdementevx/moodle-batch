import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { webSolver, openWebPage } from '../../batch/web.js';

test('clarification reuses its owned conversation tab without navigation and preserves a user draft', async () => {
  const root = await mkdtemp(join(tmpdir(), 'batch-tabs-'));
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const conversations = new Map(), navigations = [];
  let sends = 0, solve;
  const material = { text: 'Sample material supports Alpha.' };
  const questions = [{ slot: '1', type: 'choice', rows: [], text: 'Choose Alpha', options: [{ id: 'alpha', text: 'Alpha' }], memory: { excludedAnswers: [] } }];
  try {
    await context.route('https://chatgpt.com/**', async route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      const json = body => route.fulfill({ json: body });
      if (path === '/api/auth/session') return json({ accessToken: 'fixture' });
      if (path.startsWith('/backend-api/conversation/')) {
        const id = path.split('/').at(-1), messages = conversations.get(id);
        assert.ok(messages, 'only the requested owned history may be read');
        return json({ id, current_node: String(messages.length - 1), mapping: Object.fromEntries(messages.map((message, i) => [String(i),
          { id: String(i), parent: i ? String(i - 1) : null, message }])) });
      }
      if (path === '/fixture/send') {
        const { prompt, chat } = request.postDataJSON();
        const id = chat || `chat-${conversations.size + 1}`;
        const requestId = JSON.parse(prompt.split('\n').at(-1)).requestId;
        const messages = conversations.get(id) || []; sends++;
        messages.push({ author: { role: 'user' }, content: { content_type: 'text', parts: [prompt] } },
          { author: { role: 'assistant' }, end_turn: true, content: { content_type: 'text', parts: [JSON.stringify({ requestId,
            answers: [{ slot: '1', answer: ['alpha'], needsReview: false, evidence: { kind: 'context', quote: material.text }, sourceUrls: [] }] })] } });
        conversations.set(id, messages); return json({ id });
      }
      assert.equal(path, '/', 'clarification must not reload a conversation document'); navigations.push(path);
      await route.fulfill({ contentType: 'text/html', body: `<title>ChatGPT fixture</title><div role="textbox" contenteditable="true"></div>
        <button data-testid="composer-plus-btn" onclick="document.querySelector('[role=menuitem]').hidden=false">Tools</button>
        <button role="menuitem" hidden onclick="this.hidden=true">Search the web</button><button data-testid="send-button" onclick="send()">Send</button>
        <script>async function send(){const editor=document.querySelector('[role=textbox]');const r=await fetch('/fixture/send',{
          method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({prompt:editor.innerText,chat:location.pathname.split('/')[2]})});
          const data=await r.json();history.replaceState({},'', '/c/'+data.id);editor.innerText='';}</script>` });
    });
    const personal = await context.newPage(); await personal.setContent('<p>Personal page</p>');
    solve = webSolver({ extension: true, connect: async () => ({ contexts: () => [context], close: async () => {} }) });
    const request = (requestId, extra = {}) => solve(questions, material, { requestId, journalPath: join(root, requestId + '.json'), reasoning: 'current', ...extra });
    const first = await request('first');
    await request('independent');
    const owned = context.pages().find(page => page.url() === first[0].conversationUrl);
    assert.ok(owned);
    await request('clarification', { continueUrl: first[0].conversationUrl, parentRequestId: ['first'] });
    assert.equal(sends, 3); assert.equal(navigations.length, 2); assert.equal(context.pages().length, 3);
    await owned.locator('[role=textbox]').fill('Personal draft');
    await assert.rejects(request('blocked', { continueUrl: first[0].conversationUrl, parentRequestId: ['first', 'clarification'] }), /GPT_WEB_FOREIGN_DRAFT/);
    assert.equal(sends, 3);
    await solve.release();
    assert.equal(personal.isClosed(), false); assert.equal(owned.isClosed(), false);
    assert.equal(await owned.locator('[role=textbox]').innerText(), 'Personal draft');
    assert.equal(context.pages().length, 2, 'release closes only completed owned tabs');
  } finally { await solve?.close(); await browser.close(); await rm(root, { recursive: true, force: true }); }
});


test('a delayed original chat becomes ready in place without a reload or extra history request', async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const target = 'https://chatgpt.com/c/original-chat', requests = [], waits = [];
  try {
    await page.route('https://chatgpt.com/**', async route => {
      requests.push(route.request().url());
      assert.equal(route.request().url(), target);
      await route.fulfill({ contentType: 'text/html', body: '<title>ChatGPT</title><p id="loading">Loading conversation...</p>' });
    });
    const pending = openWebPage(page, target, detail => waits.push(detail));
    await page.locator('#loading').waitFor();
    await page.waitForFunction(() => document.readyState === 'complete');
    await page.evaluate(() => {
      document.querySelector('#loading').remove();
      const editor = document.createElement('div'); editor.contentEditable = 'true';
      editor.setAttribute('role', 'textbox'); document.body.append(editor);
    });
    await pending;
    assert.deepEqual(requests, [target]);
    assert.equal(page.url(), target); assert.equal(browser.contexts()[0].pages().length, 1);
    assert.ok(waits[0].retryAt); assert.equal(waits.at(-1), null);
  } finally { await browser.close(); }
});
