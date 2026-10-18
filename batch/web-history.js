// Observe only conversation history on program-owned pages. Never log bodies or headers containing credentials.
const histories = new WeakMap();
const readLimits = new WeakMap();

export function observeWebHistory(page, log) {
  let state = histories.get(page);
  if (state) { if (log) state.log = log; return; }
  if (!page.on) return;
  const account = page.context?.() || page;
  if (!readLimits.has(account)) readLimits.set(account, { notBefore: 0, reads: new Map() });
  state = { entries: new Map(), log, limit: readLimits.get(account) }; histories.set(page, state);
  const requests = new WeakMap();
  const record = detail => { try { state.log?.({ at: new Date().toISOString(), ...detail }); } catch {} };
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.origin !== 'https://chatgpt.com') return;
    const generation = request.method() === 'POST' && /^\/backend-api\/(?:f\/)?conversation$/u.test(url.pathname);
    const id = /^\/backend-api\/conversations?\/([a-zA-Z0-9-]+)$/u.exec(url.pathname)?.[1];
    if (!generation && (!id || request.method() !== 'GET')) return;
    const source = request.headers()['x-moodle-batch-read'] ? 'batch' : 'page';
    let resolve;
    const entry = { id, source, generation, method: request.method(), path: url.pathname, promise: new Promise(done => { resolve = done; }), resolve: value => resolve(value) };
    requests.set(request, entry);
    if (generation) { state.entries.clear(); state.generation = entry; state.armed?.resolve(true); state.armed = undefined; }
    else {
      state.limit.reads.set(id, Date.now() + 20000);
      if (source === 'page') state.entries.set(id, entry);
    }
    record({ event: 'request', source, method: entry.method, path: url.pathname });
  });
  page.on('response', async response => {
    const entry = requests.get(response.request());
    if (!entry) return;
    const status = response.status(), retryAfter = response.headers()['retry-after'];
    record({ event: 'response', source: entry.source, method: entry.method, path: entry.path, status, retryAfter });
    if (!response.ok()) {
      const delay = retryAfter ? (/^\d+$/u.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now()) : 0;
      const retryMs = Math.max(status === 429 ? 60000 : 5000, Number.isFinite(delay) ? delay : 0);
      if (status === 429) state.limit.notBefore = Math.max(state.limit.notBefore, Date.now() + retryMs);
      entry.resolve({ error: status === 429 ? 'GPT_WEB_RATE_LIMITED' : status === 404 ? 'GPT_WEB_CONVERSATION_UNAVAILABLE'
        : [401, 403].includes(status) ? 'GPT_WEB_CONVERSATION_ACCESS_DENIED' : 'GPT_WEB_CONVERSATION_READ_FAILED',
        httpStatus: status, retryMs, retryAt: Date.now() + retryMs });
      return;
    }
    if (entry.generation) return; // requestfinished fires only after the response stream ends.
    try { entry.resolve({ data: await response.json() }); }
    catch { entry.resolve({ unavailable: true }); }
  });
  page.on('requestfinished', request => {
    const entry = requests.get(request);
    if (entry?.generation) { record({ event: 'generation_finished', source: entry.source, path: entry.path }); entry.resolve({ finished: true }); }
  });
  page.on('requestfailed', request => {
    const entry = requests.get(request);
    if (entry) { record({ event: 'requestfailed', source: entry.source, path: entry.path, error: request.failure?.()?.errorText }); entry.resolve(entry.generation ? { error: 'GPT_WEB_GENERATION_INTERRUPTED' } : { unavailable: true }); }
  });
  page.on('close', () => { state.armed?.resolve(false); state.generation?.resolve({ error: 'GPT_WEB_GENERATION_INTERRUPTED' }); for (const entry of state.entries.values()) entry.resolve?.({ unavailable: true }); });
}

export function checkWebReadLimit(page, url) {
  const limit = histories.get(page)?.limit;
  const retryMs = (limit?.notBefore || 0) - Date.now();
  if (retryMs > 0) throw Object.assign(new Error('GPT_WEB_RATE_LIMITED'), { httpStatus: 429, retryMs });
  const interval = (url && limit?.reads.get(new URL(url).pathname.split('/').at(-1)) || 0) - Date.now();
  if (interval > 0) throw Object.assign(new Error('GPT_WEB_RESPONSE_NOT_READY'), { retryMs: interval });
}

// Wait for the page's history request (including its own retry); never fetch history here.
export async function waitForWebHistory(page, url, deadline = Date.now() + 300000) {
  const id = new URL(url).pathname.split('/').at(-1);
  const state = histories.get(page);
  if (!state) return undefined;
  const matches = request => {
    const target = new URL(request.url());
    return request.method() === 'GET' && target.origin === 'https://chatgpt.com'
      && [`/backend-api/conversation/${id}`, `/backend-api/conversations/${id}`].includes(target.pathname);
  };
  let previous;
  while (true) {
    let entry = state.entries.get(id);
    if (!entry || entry === previous) {
      const timeout = Math.min(300000, deadline - Date.now());
      if (timeout <= 0) throw new Error('GPT_WEB_HISTORY_LOAD_TIMEOUT');
      await page.waitForRequest(matches, { timeout }).catch(() => { throw new Error('GPT_WEB_HISTORY_LOAD_TIMEOUT'); });
      entry = state.entries.get(id);
    }
    if (!entry) throw new Error('GPT_WEB_HISTORY_NOT_OBSERVED');
    let timer;
    let result;
    try {
      const timeout = Math.min(300000, deadline - Date.now());
      if (timeout <= 0) throw new Error('GPT_WEB_HISTORY_LOAD_TIMEOUT');
      result = await Promise.race([entry.promise, new Promise(resolve => {
        timer = setTimeout(() => resolve({ error: 'GPT_WEB_HISTORY_LOAD_TIMEOUT' }), timeout);
      })]);
    } finally { clearTimeout(timer); }
    if (!result.error) {
      if (!result.data) throw new Error('GPT_WEB_HISTORY_UNAVAILABLE');
      return result.data;
    }
    if (![429, 500, 502, 503, 504].includes(result.httpStatus)) throw Object.assign(new Error(result.error), result);
    const retryAt = result.retryAt || Date.now() + (result.retryMs || 0);
    const retryDelay = retryAt - Date.now();
    if (retryDelay > 0) {
      if (Date.now() + retryDelay >= deadline) throw Object.assign(new Error(result.error), result);
      await new Promise(resolve => setTimeout(resolve, retryDelay));
    }
    previous = entry;
  }
}

function messageFromNode(message) {
  return { role: message.author?.role, toolName: message.author?.name, endTurn: message.end_turn,
    text: message.content?.content_type === 'text' && (message.author?.role === 'user' || message.end_turn)
      ? message.content.parts.filter(part => typeof part === 'string').join('\n') : undefined,
    sources: message.author?.role === 'tool' && message.author?.name === 'web.run'
      ? (message.metadata?.search_result_groups || []).flatMap(group => (group.entries || []).map(entry => entry.url)) : [],
  };
}

function mappedConversationMessages(data, id) {
  if ([data.id, data.conversation_id].some(value => value != null && value !== id)) throw new Error('GPT_WEB_SCOPE_MISMATCH');
  const mapping = data.mapping;
  let node = mapping?.[data.current_node];
  if (!node) return undefined;
  const messages = [], seen = new Set();
  let nodeId = data.current_node;
  while (node) {
    if (!node.id || node.id !== nodeId || seen.has(nodeId) || seen.size >= 100) throw new Error('GPT_WEB_INVALID_CONVERSATION');
    seen.add(nodeId);
    if (node.message) messages.unshift(messageFromNode(node.message));
    if (node.parent && !mapping[node.parent]) return undefined;
    nodeId = node.parent;
    node = nodeId ? mapping[nodeId] : null;
  }
  return messages;
}

export function clearWebHistory(page) {
  const state = histories.get(page);
  if (state) { state.entries.clear(); state.generation = undefined; state.armed?.resolve(false); state.armed = undefined; }
}

export function armWebGeneration(page) {
  observeWebHistory(page);
  const state = histories.get(page);
  if (!state) throw new Error('GPT_WEB_GENERATION_NOT_OBSERVED');
  let resolve;
  state.armed = { promise: new Promise(done => { resolve = done; }), resolve: value => resolve(value) };
}

export async function waitForWebGeneration(page) {
  const state = histories.get(page);
  if (state?.armed) {
    let timer;
    try {
      const started = await Promise.race([state.armed.promise, new Promise(resolve => {
        timer = setTimeout(() => resolve(false), 60000);
      })]);
      if (!started) throw new Error('GPT_WEB_GENERATION_NOT_OBSERVED');
    } finally { clearTimeout(timer); }
  }
  if (!state?.generation) return;
  let timer;
  try {
    const result = await Promise.race([state.generation.promise, new Promise(resolve => {
      timer = setTimeout(() => resolve({ error: 'GPT_WEB_GENERATION_TIMEOUT' }), 300000);
    })]);
    const interrupted = result.error === 'GPT_WEB_GENERATION_INTERRUPTED';
    if (result.error && !interrupted) throw Object.assign(new Error(result.error), result);
    const id = /^\/c\/([a-zA-Z0-9-]+)$/u.exec(new URL(page.url()).pathname)?.[1];
    if (id && !state.entries.has(id) && !state.generation.historyWaited) {
      state.generation.historyWaited = true;
      // The UI normally fetches saved history after the stream finishes. Give it priority.
      await page.waitForRequest(request => {
        const url = new URL(request.url());
        return request.method() === 'GET' && url.origin === 'https://chatgpt.com'
          && [`/backend-api/conversation/${id}`, `/backend-api/conversations/${id}`].includes(url.pathname);
      }, { timeout: 15000 }).catch(() => null);
    }
    // A closed or cancelled transport permits a read, never acceptance by itself.
    // readWebResult still requires the complete final answer and exact request chain.
  } finally { clearTimeout(timer); }
}

// Reuse a complete read for parent verification; a new send invalidates it.
export async function rememberWebRead(page, url, read) {
  const state = histories.get(page), generation = state?.generation;
  const messages = await read();
  if (state && state.generation !== generation) throw new Error('GPT_WEB_FOREIGN_CONVERSATION');
  const lastUser = messages.findLastIndex(m => m.role === 'user');
  if (state && lastUser >= 0 && messages.slice(lastUser + 1).some(m => m.role === 'assistant' && m.endTurn && m.text?.trim())) {
    state.entries.set(new URL(url).pathname.split('/').at(-1), { promise: Promise.resolve({ messages }) });
  }
  return messages;
}

export function nativeConversationMessages(data, id) {
  if (data.conversation_id !== id) throw new Error('GPT_WEB_SCOPE_MISMATCH');
  // A paginated fragment cannot establish the complete parent chain.
  if (!data.page_info || data.page_info.has_previous_page !== false || data.page_info.has_next_page !== false
      || !Array.isArray(data.messages) || !data.messages.length || data.messages.length > 100
      || data.messages.at(-1)?.id !== data.current_node) return undefined;
  if (new Set(data.messages.map(m => m.id)).size !== data.messages.length) throw new Error('GPT_WEB_INVALID_CONVERSATION');
  return data.messages.map(messageFromNode);
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
    const messages = result.messages || (result.data?.mapping ? mappedConversationMessages(result.data, id)
      : result.data?.conversation_id ? nativeConversationMessages(result.data, id) : undefined);
    if (requestId && (!messages?.some(m => m.role === 'user' && m.text?.includes(requestId))
        || !messages.slice(messages.findLastIndex(m => m.role === 'user') + 1).some(m => m.role === 'assistant' && m.endTurn && m.text?.trim()))) return undefined;
    return messages;
  } finally { clearTimeout(timer); }
}
