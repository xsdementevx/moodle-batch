import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { normalize } from './answers.js';
import { chromium } from 'playwright';

// Whitespace and table delimiters are presentation, not changes to the quoted facts.
export const evidenceText = text => normalize(String(text).replace(/\\[nr]/gu, ' ').replace(/\s*\|\s*/gu, ' '));

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
    if (!response.ok || !/text\/(?:html|plain)/iu.test(response.headers.get('content-type') || '')) {
      await response.body?.cancel(); throw new Error('SOURCE_UNAVAILABLE');
    }
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 1000000) throw new Error('SOURCE_TOO_LARGE');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
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
    if (html.length > 1000000) throw new Error('SOURCE_TOO_LARGE');
    return html;
  } finally { await context?.close(); await browser.close(); }
}

export async function verifyEvidence(decisions, questions, context, { readSource = readPublicSource,
  renderSource = readRenderedSource, textFromHtml } = {}) {
  const pages = new Map();
  const results = [];
  for (const decision of decisions) {
    let grounded = false;
    const evidence = decision.evidence;
    if (decision.status === 'candidate' && typeof evidence?.quote === 'string' && evidenceText(evidence.quote).length >= 20) {
      const question = questions.find(q => q.slot === decision.slot);
      if (evidence.kind === 'context') {
        const doc = context.documents?.[question.contextId] || context;
        grounded = (!context.documents || evidence.contextId === question.contextId)
          && evidenceText(doc.text || '').includes(evidenceText(evidence.quote));
      } else if (evidence.kind === 'web' && decision.sourceUrls.includes(evidence.url)) {
        if (!pages.has(evidence.url)) pages.set(evidence.url, (async () => {
          try {
            const raw = await readSource(evidence.url);
            return evidenceText(textFromHtml ? await textFromHtml(raw) : raw);
          } catch { return ''; }
        })());
        const needle = evidenceText(evidence.quote);
        grounded = (await pages.get(evidence.url)).includes(needle);
        if (!grounded && renderSource) {
          const renderKey = `render:${evidence.url}:${needle}`;
          if (!pages.has(renderKey)) pages.set(renderKey, (async () => {
            try {
              const raw = await renderSource(evidence.url, evidence.quote);
              return evidenceText(textFromHtml ? await textFromHtml(raw) : raw);
            } catch { return ''; }
          })());
          grounded = (await pages.get(renderKey)).includes(needle);
        }
      }
    }
    results.push({ ...decision, evidenceVerified: grounded,
      status: decision.status === 'candidate' && !grounded ? 'needs_review' : decision.status });
  }
  return results;
}
