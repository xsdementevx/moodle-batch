importScripts('config.js');
const config = globalThis.batchConfig;
const dashboard = (user = config.userScope, quiz = '') => chrome.tabs.create({
  url: chrome.runtime.getURL(`dashboard.html?user=${encodeURIComponent(user)}&quiz=${encodeURIComponent(quiz)}`),
});
chrome.action.onClicked.addListener(() => dashboard());
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return;
  let url;
  try { url = new URL(sender.url); } catch { return; }
  if (message?.type === 'open' && url.origin === config.origin && sender.frameId === 0
      && /^\/(?:mod\/quiz\/(?:view|attempt|review)\.php|grade\/report\/overview\/index\.php)$/u.test(url.pathname)) {
    if (message.userScope !== config.userScope || (message.quizId && !/^\d+$/u.test(message.quizId))) {
      reply({ error: 'USER_SCOPE_MISMATCH' }); return;
    }
    dashboard(message.userScope, message.quizId || '').then(() => reply({ ok: true })); return true;
  }
  if (url.href.split('?')[0] !== chrome.runtime.getURL('dashboard.html') || message?.type !== 'api') return;
  if (!['state', 'jobs', 'stop', 'refresh'].includes(message.route) || message.userScope !== config.userScope) {
    reply({ error: 'USER_SCOPE_MISMATCH' }); return;
  }
  (async () => {
    const state = message.route === 'state';
    const response = await fetch(`${config.endpoint}/${message.route}${state ? `?user=${encodeURIComponent(config.userScope)}` : ''}`, {
      method: state ? 'GET' : 'POST', headers: { Authorization: `Bearer ${config.token}`, ...(!state ? { 'Content-Type': 'application/json' } : {}) },
      ...(state ? {} : { body: JSON.stringify({ ...message.body, userScope: config.userScope }) }), signal: AbortSignal.timeout(15000),
    });
    const data = await response.json();
    reply(response.ok ? { data } : { error: data.error || 'READ_FAILED', rejected: true });
  })().catch(() => reply({ error: 'SERVICE_UNAVAILABLE' }));
  return true;
});
