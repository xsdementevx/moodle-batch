import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { normalize } from './answers.js';

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

export async function verifyEvidence(decisions, questions, context, { readSource = readPublicSource, textFromHtml } = {}) {
  const pages = new Map();
  const results = [];
  for (const decision of decisions) {
    let grounded = false;
    const evidence = decision.evidence;
    if (decision.status === 'candidate' && typeof evidence?.quote === 'string' && normalize(evidence.quote).length >= 20) {
      const question = questions.find(q => q.slot === decision.slot);
      if (evidence.kind === 'context') {
        const doc = context.documents?.[question.contextId] || context;
        grounded = (!context.documents || evidence.contextId === question.contextId)
          && normalize(doc.text || '').includes(normalize(evidence.quote));
      } else if (evidence.kind === 'web' && decision.sourceUrls.includes(evidence.url)) {
        if (!pages.has(evidence.url)) pages.set(evidence.url, (async () => {
          try {
            const raw = await readSource(evidence.url);
            return normalize(textFromHtml ? await textFromHtml(raw) : raw);
          } catch { return ''; }
        })());
        grounded = (await pages.get(evidence.url)).includes(normalize(evidence.quote));
      }
    }
    results.push({ ...decision, evidenceVerified: grounded,
      status: decision.status === 'candidate' && !grounded ? 'needs_review' : decision.status });
  }
  return results;
}
