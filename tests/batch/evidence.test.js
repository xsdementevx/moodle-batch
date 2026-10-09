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
  const unreadable = (await verifyEvidence([decision(web)], questions, contexts, { readSource: async () => { throw new Error(); }, renderSource: null }))[0];
  assert.equal(unreadable.status, 'needs_review');
  assert.equal(unreadable.reviewReason, 'source_unavailable');
  const absent = (await verifyEvidence([decision(web)], questions, contexts, { readSource: async () => 'A readable page with different facts.', renderSource: null }))[0];
  assert.equal(absent.reviewReason, 'source_quote_not_found');
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

test('public PDF evidence is checked as extracted text without HTML or browser rendering', async () => {
  const quote = 'The precise condition is x < 3 and y > 2 in the original PDF.';
  const url = 'https://source.example/book.pdf';
  const decision = { slot: '1', status: 'candidate', sourceUrls: [url], evidence: { kind: 'web', url, quote } };
  const options = { readSource: async () => ({ text: quote, format: 'pdf' }),
    textFromHtml: () => assert.fail('PDF text must not be parsed as HTML'),
    renderSource: () => assert.fail('PDF must not open the browser PDF viewer') };
  assert.equal((await verifyEvidence([decision], [{ slot: '1' }], {}, options))[0].evidenceVerified, true);
  const invented = { ...decision, evidence: { ...decision.evidence, quote: 'A fabricated statement absent from this PDF document.' } };
  assert.equal((await verifyEvidence([invented], [{ slot: '1' }], {}, options))[0].status, 'needs_review');
});

test('multiple source quotes must all be observed, exact and cover every matching row or selected option', async () => {
  const first = 'The first event happened on the verified earlier date.';
  const second = 'The second event happened on the verified later date.';
  const urls = ['https://source.example/first', 'https://source.example/second'];
  const question = { slot: '1', type: 'matching', rows: [{ id: 'r1' }, { id: 'r2' }] };
  const evidence = [first, second].map((quote, i) => ({ kind: 'web', url: urls[i], quote, rowIds: [`r${i + 1}`] }));
  const decision = { slot: '1', status: 'candidate', answer: { r1: 'o1', r2: 'o2' }, sourceUrls: urls, evidence };
  const options = { readSource: async url => url === urls[0] ? first : second, renderSource: null };
  const verify = d => verifyEvidence([d], [question], {}, options).then(r => r[0]);
  assert.equal((await verify(decision)).evidenceVerified, true);
  for (const wrong of [[], [evidence[0]], [...evidence, { ...evidence[0], rowIds: ['foreign'] }],
    [evidence[0], { ...evidence[1], quote: 'An invented event and invented date.' }],
    [evidence[0], { ...evidence[1], url: 'https://unobserved.example/' }]]) {
    assert.equal((await verify({ ...decision, evidence: wrong })).status, 'needs_review');
  }
  const multiple = { slot: '1', type: 'multiple' };
  const mapped = evidence.map(({ rowIds, ...item }, i) => ({ ...item, optionIds: [`o${i + 1}`] }));
  assert.equal((await verifyEvidence([{ ...decision, answer: ['o1', 'o2'], evidence: mapped }], [multiple], {}, options))[0].evidenceVerified, true);
  assert.equal((await verifyEvidence([{ ...decision, answer: ['o1', 'o2'], evidence: [mapped[0]] }], [multiple], {}, options))[0].reviewReason, 'evidence_incomplete');
});

test('a rejected duplicate cannot block complete verified coverage or fill a missing answer', async () => {
  const quote = 'The course explicitly establishes the first and second selected claims.';
  const good = { kind: 'context', quote, optionIds: ['one', 'two'] };
  const bad = { kind: 'web', url: 'https://source.example/blocked', quote: 'A duplicate quote from an unreadable external source.', optionIds: ['one'] };
  const question = { slot: '1', type: 'multiple' };
  const decision = { slot: '1', status: 'candidate', answer: ['one', 'two'], sourceUrls: [bad.url], evidence: [bad, good] };
  const options = { readSource: async () => { throw new Error('SOURCE_UNAVAILABLE'); }, renderSource: null };
  const result = (await verifyEvidence([decision], [question], { text: quote }, options))[0];
  assert.equal(result.status, 'candidate');
  assert.deepEqual(result.evidence, [good]);
  assert.equal(result.rejectedEvidence[0].reason, 'source_unavailable');
  const missing = { ...decision, evidence: [bad, { ...good, optionIds: ['two'] }] };
  assert.equal((await verifyEvidence([missing], [question], { text: quote }, options))[0].status, 'needs_review');
  const foreign = { ...decision, evidence: [good, { ...bad, optionIds: ['foreign'] }] };
  assert.equal((await verifyEvidence([foreign], [question], { text: quote }, options))[0].status, 'needs_review');
  const matching = { slot: '1', type: 'matching', rows: [{ id: 'one' }, { id: 'two' }] };
  const pairs = { ...decision, answer: { one: 'o1', two: 'o2' }, evidence: [
    { ...good, rowIds: good.optionIds }, { ...bad, rowIds: bad.optionIds }] };
  assert.equal((await verifyEvidence([pairs], [matching], { text: quote }, options))[0].status, 'candidate');
});

test('single answers retain a verified source when an additional quote fails, without promoting uncertainty', async () => {
  const quote = 'The commercial establishments are located in different countries.';
  const good = { kind: 'web', url: 'https://source.example/primary', quote };
  const bad = { kind: 'web', url: 'https://source.example/secondary', quote: 'An absent supplementary quotation of sufficient length.' };
  const decision = { slot: '1', status: 'candidate', answer: ['one'], sourceUrls: [good.url, bad.url], evidence: [bad, good] };
  const options = { readSource: async url => url === good.url ? quote : 'Different text.', renderSource: null };
  for (const type of ['choice', 'text']) {
    const verify = d => verifyEvidence([d], [{ slot: '1', type }], {}, options).then(r => r[0]);
    const result = await verify(decision);
    assert.equal(result.status, 'candidate');
    assert.equal(result.evidenceVerified, true);
    assert.deepEqual(result.evidence, [good]);
    assert.equal(result.rejectedEvidence[0].reason, 'source_quote_not_found');
    assert.equal((await verify({ ...decision, evidence: [bad] })).status, 'needs_review');
    assert.equal((await verify({ ...decision, status: 'needs_review' })).evidenceVerified, false);
    assert.equal((await verify({ ...decision, sourceUrls: [] })).status, 'needs_review');
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
