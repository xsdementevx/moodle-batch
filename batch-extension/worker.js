importScripts('config.js');
const config = globalThis.batchConfig;
const request = async (route, body) => {
  const state = route === 'state';
  const response = await fetch(`${config.endpoint}/${route}`, {
    method: state ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${config.token}`, ...(!state ? { 'Content-Type': 'application/json' } : {}) },
    ...(state ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60000),
  });
  const data = await response.json();
  if (!response.ok) { const error = new Error(data.error || 'READ_FAILED'); error.rejected = true; throw error; }
  return data;
};
let sessionTask, lastCookies;
const sessionState = () => sessionTask ??= (async () => {
  let state = await request('state');
  const cookies = await chrome.cookies.getAll({ url: config.origin });
  if (!cookies.length) return { ...state, authRequired: true, error: 'LOGIN_REQUIRED' };
  const signature = JSON.stringify(cookies);
  if (cookies.length && (lastCookies !== signature || state.authRequired)
      && !state.running && !state.jobs.some(job => ['queued', 'running'].includes(job.status))) {
    try { await request('session', { cookies }); }
    catch (error) {
      if (['LOGIN_REQUIRED', 'INVALID_COOKIE_FILE'].includes(error.message)) return { ...state, authRequired: true, error: 'LOGIN_REQUIRED' };
      throw error;
    }
    lastCookies = signature;
    state = await request('state');
  }
  return state;
})().finally(() => { sessionTask = null; });
const dashboard = (quiz = '') => chrome.tabs.create({
  url: chrome.runtime.getURL(`dashboard.html?user=${encodeURIComponent(config.userScope)}&quiz=${encodeURIComponent(quiz)}`),
});
chrome.action.onClicked.addListener(() => dashboard());
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return;
  let url;
  try { url = new URL(sender.url); } catch { return; }
  if (message?.type === 'open' && url.origin === config.origin && sender.frameId === 0
      && /^\/(?:mod\/quiz\/(?:view|attempt|review)\.php|grade\/report\/overview\/index\.php)$/u.test(url.pathname)) {
    if (message.quizId && !/^\d+$/u.test(message.quizId)) {
      reply({ error: 'INVALID_REQUEST' }); return;
    }
    dashboard(message.quizId || '').then(() => reply({ ok: true })); return true;
  }
  if (url.href.split('?')[0] !== chrome.runtime.getURL('dashboard.html') || message?.type !== 'api') return;
  if (!['state', 'jobs', 'stop', 'refresh'].includes(message.route)) {
    reply({ error: 'INVALID_REQUEST' }); return;
  }
  (async () => {
    const state = await sessionState();
    if (message.route !== 'state' && state.authRequired) {
      const error = new Error('LOGIN_REQUIRED'); error.rejected = true; throw error;
    }
    if (message.route !== 'state' && message.userScope !== state.userScope) {
      const error = new Error('SESSION_CHANGED'); error.rejected = true; throw error;
    }
    const data = message.route === 'state' ? state
      : await request(message.route, { ...message.body, userScope: state.userScope });
    reply({ data });
  })().catch(error => reply({ error: error.rejected ? error.message : 'SERVICE_UNAVAILABLE', rejected: error.rejected === true }));
  return true;
});
