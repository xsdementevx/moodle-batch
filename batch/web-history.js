// Observe only conversation history on program-owned pages. Never log bodies or headers containing credentials.
const histories = new WeakMap();

export function observeWebHistory(page, log) {
  let state = histories.get(page);
  if (state) { if (log) state.log = log; return; }
  if (!page.on) return;
  state = { entries: new Map(), log }; histories.set(page, state);
  const requests = new WeakMap();
  const record = detail => { try { state.log?.({ at: new Date().toISOString(), ...detail }); } catch {} };
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.origin !== 'https://chatgpt.com' || request.method() !== 'GET') return;
    const id = /^\/backend-api\/conversations?\/([a-zA-Z0-9-]+)$/u.exec(url.pathname)?.[1];
    if (!id) return;
    const source = request.headers()['x-moodle-batch-read'] ? 'batch' : 'page';
    let resolve;
    const entry = { id, source, path: url.pathname, promise: new Promise(done => { resolve = done; }), resolve: value => resolve(value) };
    requests.set(request, entry);
    if (source === 'page') state.entries.set(id, entry);
    record({ event: 'request', source, method: 'GET', path: url.pathname });
  });
  page.on('response', async response => {
    const entry = requests.get(response.request());
    if (!entry) return;
    const status = response.status(), retryAfter = response.headers()['retry-after'];
    record({ event: 'response', source: entry.source, method: 'GET', path: entry.path, status, retryAfter });
    if (!response.ok()) {
      const delay = retryAfter ? (/^\d+$/u.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now()) : 0;
      const retryMs = Math.max(status === 429 ? 60000 : 5000, Number.isFinite(delay) ? delay : 0);
      entry.resolve({ error: status === 429 ? 'GPT_WEB_RATE_LIMITED' : status === 404 ? 'GPT_WEB_CONVERSATION_UNAVAILABLE'
        : [401, 403].includes(status) ? 'GPT_WEB_CONVERSATION_ACCESS_DENIED' : 'GPT_WEB_CONVERSATION_READ_FAILED',
        httpStatus: status, retryMs, retryAt: Date.now() + retryMs });
      return;
    }
    try { entry.resolve({ data: await response.json() }); }
    catch { entry.resolve({ unavailable: true }); }
  });
  page.on('requestfailed', request => {
    const entry = requests.get(request);
    if (entry) { record({ event: 'requestfailed', source: entry.source, path: entry.path }); entry.resolve({ unavailable: true }); }
  });
  page.on('close', () => { for (const entry of state.entries.values()) entry.resolve({ unavailable: true }); });
}

export function clearWebHistory(page) { histories.get(page)?.entries.clear(); }

export function nativeConversationMessages(data, id) {
  if (data.conversation_id !== id) throw new Error('GPT_WEB_SCOPE_MISMATCH');
  // A paginated fragment cannot establish the complete parent chain.
  if (!data.page_info || data.page_info.has_previous_page !== false || data.page_info.has_next_page !== false
      || !Array.isArray(data.messages) || !data.messages.length || data.messages.length > 100
      || data.messages.at(-1)?.id !== data.current_node) return undefined;
  if (new Set(data.messages.map(m => m.id)).size !== data.messages.length) throw new Error('GPT_WEB_INVALID_CONVERSATION');
  return data.messages.map(m => ({ role: m.author?.role, toolName: m.author?.name, endTurn: m.end_turn,
    text: m.content?.content_type === 'text' && (m.author?.role === 'user' || m.end_turn)
      ? m.content.parts.filter(p => typeof p === 'string').join('\n') : undefined,
    sources: m.author?.role === 'tool' && m.author?.name === 'web.run'
      ? (m.metadata?.search_result_groups || []).flatMap(g => (g.entries || []).map(e => e.url)) : [],
  }));
}

export async function nativeWebHistory(page, url, requestId) {
  const id = new URL(url).pathname.split('/').at(-1);
  const entry = histories.get(page)?.entries.get(id);
  if (!entry) return undefined;
  let timer;
  try {
    const result = await Promise.race([entry.promise, new Promise(resolve => {
      timer = setTimeout(() => resolve({ error: 'GPT_WEB_HISTORY_LOAD_TIMEOUT' }), 300000);
    })]);
    if (result.error) {
      if ([429, 500, 502, 503, 504].includes(result.httpStatus) && Date.now() >= result.retryAt) return undefined;
      throw Object.assign(new Error(result.error), result);
    }
    if (!result.data?.conversation_id) return undefined; // Other native formats require the existing full reader.
    const messages = nativeConversationMessages(result.data, id);
    if (requestId && !messages?.some(m => m.role === 'user' && m.text?.includes(requestId))) return undefined;
    return messages;
  } finally { clearTimeout(timer); }
}
