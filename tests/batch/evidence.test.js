import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyEvidence, readRenderedSource, sourceText } from '../../batch/evidence.js';
import { chromium } from 'playwright';

test('evidence requires a real quote from the correct context or an observed and readable web source', async () => {
  const quote = 'This is the actual source statement.';
  const contexts = { documents: { first: { text: quote }, second: { text: 'A different lecture, with different facts.' } } };
  const questions = [{ slot: '1', contextId: 'first' }];
  const decision = evidence => ({ slot: '1', status: 'candidate', sourceUrls: ['https://source.example/'], evidence });
  const evidence = { kind: 'context', contextId: 'first', quote };
  assert.equal((await verifyEvidence([decision(evidence)], questions, contexts))[0].status, 'candidate');
  for (const wrong of [undefined, { ...evidence, contextId: 'second' }, { ...evidence, quote: 'An invented quote of sufficient length.' }]) {
    assert.equal((await verifyEvidence([decision(wrong)], questions, contexts))[0].status, 'needs_review');
  }
  let reads = 0;
  const readSource = async () => { reads++; return quote; };
  const web = { kind: 'web', url: 'https://source.example/', quote };
  assert.ok((await verifyEvidence([decision(web), decision(web)], questions, contexts, { readSource })).every(d => d.evidenceVerified));
  assert.equal(reads, 1);
  assert.equal((await verifyEvidence([decision({ ...web, url: 'https://invented.example/' })], questions, contexts, { readSource }))[0].status, 'needs_review');
  assert.equal(reads, 1, 'unobserved URLs must not be read');
  assert.equal((await verifyEvidence([decision(web)], questions, contexts, { readSource: async () => { throw new Error(); }, renderSource: null }))[0].status, 'needs_review');
});

test('PDF discretionary word breaks do not invalidate quotes or merge different numbers', async () => {
  const quote = 'Учреждались должности судебных следователей, адвокатура.';
  const decision = { slot: '1', status: 'candidate', sourceUrls: [], evidence: { kind: 'context', quote } };
  for (const marker of ['\u001f', '\u00ad']) {
    const context = { text: quote.replace('Учреждались', `Учрежда${marker}лись`) };
    assert.equal((await verifyEvidence([decision], [{ slot: '1' }], context))[0].evidenceVerified, true);
    const numeric = { ...decision, evidence: { kind: 'context', quote: 'The verified numeric value is 1234.' } };
    assert.equal((await verifyEvidence([numeric], [{ slot: '1' }], { text: `The verified numeric value is 12${marker}34.` }))[0].evidenceVerified, false);
  }
});

test('JavaScript source rendering is isolated, permits normal same-origin loading and blocks private cross-origin reads', async () => {
  const browser = await chromium.launch();
  let isolated, privateBlocked = false;
  const create = browser.newContext.bind(browser);
  browser.newContext = async options => {
    isolated = await create(options);
    await isolated.route('https://source.example/**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/signal') return route.fulfill({ contentType: 'application/json', body: '{"ready":true}' });
      return route.fulfill({ contentType: 'text/html', body: `<script>
        fetch('/signal',{method:'POST'}).then(r=>r.json()).then(()=>{
          document.body.insertAdjacentHTML('beforeend','<table><tr><td>Country</td><td>42</td><td>4</td></tr></table>');
          fetch('http://127.0.0.1/private').catch(()=>{});
        });</script><body></body>` });
    });
    isolated.on('requestfailed', request => { if (request.url().includes('127.0.0.1')) privateBlocked = true; });
    return isolated;
  };
  const html = await readRenderedSource('https://source.example/', 'Country | 42 | 4', {
    launch: async () => browser, resolveHost: async () => [{ address: '8.8.8.8' }] });
  assert.ok(html.includes('<td>42</td>'));
  assert.equal(privateBlocked, true);
  assert.equal(browser.isConnected(), false);
  assert.equal(isolated.pages().length, 0);
});

test('rendered evidence ignores table separators and line escapes while preserving the exact numbers', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const decision = { slot: '1', status: 'candidate', sourceUrls: ['https://source.example/'],
      evidence: { kind: 'web', url: 'https://source.example/', quote: 'Country | Value | Rank\\nAlpha | 1234 | 4' } };
    const options = { readSource: async () => '<script>loading()</script>',
      renderSource: async () => '<table><tr><th>Country</th><th>Value</th><th>Rank</th></tr><tr><td>Alpha</td><td>1234</td><td>4</td></tr></table>',
      textFromHtml: html => page.evaluate(sourceText, html) };
    assert.equal((await verifyEvidence([decision], [{ slot: '1' }], {}, options))[0].evidenceVerified, true);
    assert.equal((await verifyEvidence([{ ...decision, evidence: { ...decision.evidence, quote: decision.evidence.quote.replace('1234', '9999') } }], [{ slot: '1' }], {}, options))[0].status, 'needs_review');
  } finally { await browser.close(); }
});
