import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { normalize } from './answers.js';
import { chromium } from 'playwright';
import { extractMaterial } from './context.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Whitespace and table delimiters are presentation, not changes to the quoted facts.
export const evidenceText = text => normalize(String(text).replace(/(?<=\p{L})[\u001f\u00ad](?=\p{L})/gu, '')
  .replace(/\\[nr]/gu, ' ').replace(/\s*\|\s*/gu, ' '));

// Runs inside the inert DOM parser, never as page scripts from the source.
export function sourceText(raw) {
  const doc = new DOMParser().parseFromString(raw, 'text/html');
  doc.querySelectorAll('script,style,noscript').forEach(e => e.remove());
  doc.querySelectorAll('br').forEach(e => e.replaceWith('\n'));
  doc.querySelectorAll('p,div,li,section,article,h1,h2,h3,td,th').forEach(e => { e.prepend('\n'); e.append('\n'); });
  return doc.body.textContent;
}

function publicAddress(address) {
  if (isIP(address) === 6) return !/^(?:::|fc|fd|fe[89ab])/iu.test(address);
  const [a, b] = address.split('.').map(Number);
  return a > 0 && a < 224 && ![10, 127].includes(a) && !(a === 169 && b === 254)
    && !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && b === 168)
    && !(a === 100 && b >= 64 && b <= 127);
}

export function decodeSource(buffer, contentType = '') {
  const charset = buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf ? 'utf-8'
    : contentType.match(/charset\s*=\s*["']?([\w-]+)/iu)?.[1]
      || buffer.subarray(0, 1024).toString('latin1').match(/<meta\b[^>]*\bcharset\s*=\s*["']?([\w-]+)/iu)?.[1] || 'utf-8';
  try { return new TextDecoder(charset).decode(buffer); }
  catch { throw new Error('SOURCE_UNAVAILABLE'); }
}

// Public text only: no browser credentials, scripts, private addresses or unlimited downloads.
export async function readPublicSource(href) {
  for (let redirects = 0; redirects < 4; redirects++) {
    const url = new URL(href);
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')
      || isIP(url.hostname) || !url.hostname.includes('.')) throw new Error('SOURCE_UNAVAILABLE');
    const addresses = await lookup(url.hostname, { all: true });
    if (!addresses.length || addresses.some(a => !publicAddress(a.address))) throw new Error('SOURCE_UNAVAILABLE');
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15000) });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel(); href = new URL(response.headers.get('location'), url).href; continue;
    }
    const pdf = /^application\/pdf(?:;|$)/iu.test(response.headers.get('content-type') || '');
    if (!response.ok || (!pdf && !/text\/(?:html|plain)/iu.test(response.headers.get('content-type') || ''))) {
      await response.body?.cancel(); throw new Error('SOURCE_UNAVAILABLE');
    }
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 5000000) throw new Error('SOURCE_TOO_LARGE');
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);
    if (pdf) {
      if (buffer.subarray(0, 5).toString() !== '%PDF-') throw new Error('SOURCE_UNAVAILABLE');
      const material = await extractMaterial({ buffer, mime: 'application/pdf' }, join(tmpdir(), 'moodle-batch-public-pdf'));
      return { text: material.text, lineText: material.lineText, format: 'pdf' };
    }
    const html = decodeSource(buffer, response.headers.get('content-type') || '');
    if (/<title[^>]*>\s*(?:check failed|just a moment|verify you are human)/iu.test(html)) throw new Error('SOURCE_UNAVAILABLE');
    return html;
  }
  throw new Error('SOURCE_UNAVAILABLE');
}

export async function readRenderedSource(href, quote, { launch = () => chromium.launch(), resolveHost = lookup } = {}) {
  const url = new URL(href);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')
      || isIP(url.hostname) || !url.hostname.includes('.')) throw new Error('SOURCE_UNAVAILABLE');
  const addresses = await resolveHost(url.hostname, { all: true });
  if (!addresses.length || addresses.some(a => !publicAddress(a.address))) throw new Error('SOURCE_UNAVAILABLE');
  const browser = await launch();
  let context;
  try {
    context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false });
    await context.route('**/*', route => {
      const request = route.request(), target = new URL(request.url());
      return target.origin === url.origin && (['GET', 'HEAD'].includes(request.method())
        || (request.method() === 'POST' && ['xhr', 'fetch'].includes(request.resourceType())))
        && ['document', 'script', 'xhr', 'fetch', 'stylesheet'].includes(request.resourceType())
        ? route.fallback() : route.abort();
    });
    await context.routeWebSocket('**/*', socket => socket.close());
    const page = await context.newPage();
    await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForFunction(needle => document.body?.innerText.replace(/\s*\|\s*/gu, ' ')
      .replace(/\s+/gu, ' ').trim().includes(needle), evidenceText(quote), { timeout: 12000 }).catch(() => {});
    const html = await page.content();
    if (/check failed|just a moment|verify you are human/iu.test(await page.title())) throw new Error('SOURCE_UNAVAILABLE');
    if (html.length > 5000000) throw new Error('SOURCE_TOO_LARGE');
    return html;
  } finally { await context?.close(); await browser.close(); }
}

export async function verifyEvidence(decisions, questions, context, { readSource = readPublicSource,
  renderSource = readRenderedSource, textFromHtml } = {}) {
  const pages = new Map();
  const pdfs = new Set();
  const pdfLines = new Map();
  const unavailable = new Set();
  const results = [];
  async function verifyOne(evidence, decision, question) {
    let grounded = false;
    if (decision.status === 'candidate' && typeof evidence?.quote === 'string' && evidenceText(evidence.quote).length >= 20) {
      if (evidence.kind === 'context') {
        const doc = context.documents?.[question.contextId] || context;
        grounded = (!context.documents || evidence.contextId === question.contextId)
          && evidenceText(doc.text || '').includes(evidenceText(evidence.quote));
      } else if (evidence.kind === 'web' && decision.sourceUrls.includes(evidence.url)) {
        if (!pages.has(evidence.url)) pages.set(evidence.url, (async () => {
          try {
            const raw = await readSource(evidence.url);
            if (raw?.format === 'pdf') { pdfs.add(evidence.url); if (raw.lineText) pdfLines.set(evidence.url, raw.lineText); return evidenceText(raw.text); }
            return evidenceText(textFromHtml ? await textFromHtml(raw) : raw);
          } catch { unavailable.add(evidence.url); return ''; }
        })());
        const needle = evidenceText(evidence.quote);
        grounded = (await pages.get(evidence.url)).includes(needle);
        if (!grounded && pdfLines.has(evidence.url)) {
          // Only physical PDF line endings can join words; keep a compound's hyphen when the quote includes it.
          const joined = pdfLines.get(evidence.url).replace(/(\p{L}+)-[ \t]*\r?\n[ \t]*(\p{L}+)/gu,
            (whole, first, last) => needle.includes(first + last) ? first + last : first + '-' + last);
          grounded = evidenceText(joined).includes(needle);
        }
        if (!grounded && renderSource && !pdfs.has(evidence.url)) {
          const renderKey = `render:${evidence.url}:${needle}`;
          if (!pages.has(renderKey)) pages.set(renderKey, (async () => {
            try {
              const raw = await renderSource(evidence.url, evidence.quote);
              unavailable.delete(evidence.url);
              return evidenceText(textFromHtml ? await textFromHtml(raw) : raw);
            } catch { unavailable.add(evidence.url); return ''; }
          })());
          grounded = (await pages.get(renderKey)).includes(needle);
        }
      }
    }
    return { grounded, reason: decision.status !== 'candidate' ? 'model_uncertain'
        : evidence?.kind === 'context' ? 'context_quote_not_found'
        : !decision.sourceUrls.includes(evidence?.url) ? 'source_not_observed'
        : unavailable.has(evidence.url) ? 'source_unavailable' : 'source_quote_not_found' };
  }
  for (const decision of decisions) {
    const question = questions.find(q => q.slot === decision.slot);
    const evidence = Array.isArray(decision.evidence) ? decision.evidence : [decision.evidence];
    const verified = [], rejected = [];
    let grounded = false, reason = decision.status === 'candidate' ? 'evidence_incomplete' : 'model_uncertain';
    if (evidence.length && evidence.length <= 32 && question) {
      const array = Array.isArray(decision.evidence);
      const field = question.type === 'matching' ? 'rowIds' : question.type === 'multiple' ? 'optionIds' : null;
      const required = field === 'rowIds' ? question.rows.map(row => row.id) : field === 'optionIds' ? decision.answer : [];
      const covered = new Set(evidence.flatMap(item => Array.isArray(item?.[field]) ? item[field] : []));
      const coverage = !array || !field || (Array.isArray(required) && evidence.every(item => Array.isArray(item?.[field])
        && item[field].length && item[field].every(id => required.includes(id))) && required.every(id => covered.has(id)));
      if (coverage) {
        grounded = true;
        for (const item of evidence) {
          const check = await verifyOne(item, decision, question);
          if (check.grounded) verified.push(item);
          else { grounded = false; reason = check.reason; rejected.push({ ...item, reason: check.reason }); }
        }
        if (array && field && decision.status === 'candidate') {
          const supported = new Set(verified.flatMap(item => item[field]));
          grounded = required.length > 0 && required.every(id => supported.has(id));
        } else if (array && ['choice', 'text'].includes(question.type) && decision.status === 'candidate') {
          grounded = verified.length > 0;
        }
      }
    }
    results.push({ ...decision, evidenceVerified: grounded,
      ...(grounded && rejected.length ? { evidence: verified, rejectedEvidence: rejected } : {}),
      reviewReason: grounded ? undefined : decision.reviewReason || reason,
      status: decision.status === 'candidate' && !grounded ? 'needs_review' : decision.status });
  }
  return results;
}
