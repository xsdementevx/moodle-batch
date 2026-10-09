// ==UserScript==
// @name         Moodle Batch — оценки
// @namespace    local.moodle-batch
// @version      1.0.0
// @description  Сводка тестов по всем курсам из пакетного анализа Moodle.
// @match        https://sdo.sibupk.su/grade/report/overview/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      127.0.0.1
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';
  if (window.top !== window.self || document.getElementById('moodle-batch-grades')) return;
  const endpoint = 'http://127.0.0.1:49804/overview';
  const links = [...document.querySelectorAll('table a[href]')].filter(a => {
    const url = new URL(a.href);
    return url.origin === location.origin && url.pathname === '/course/user.php' && url.searchParams.get('mode') === 'grade';
  });
  if (!links.length) return;
  const users = [...new Set(links.map(a => new URL(a.href).searchParams.get('user')))];
  const toolbar = document.createElement('div'); toolbar.id = 'moodle-batch-grades';
  const message = document.createElement('span');
  const refresh = document.createElement('button'); refresh.type = 'button'; refresh.textContent = 'Обновить анализ';
  toolbar.append(message, refresh);
  links[0].closest('table').before(toolbar);
  const style = document.createElement('style');
  style.textContent = `#moodle-batch-grades{display:flex;gap:12px;align-items:center;flex-wrap:wrap;padding:12px;background:#f1f5f9;border-radius:8px;margin-bottom:12px}
    .moodle-batch-summary{font:13px/1.5 Arial,sans-serif;margin:8px 0}.moodle-batch-summary summary{cursor:pointer;color:#334155}
    .moodle-batch-tests{padding:0;list-style:none;margin:8px 0}.moodle-batch-tests li{padding:5px 0;border-bottom:1px solid #e2e8f0}
    .moodle-batch-tests span{margin-left:8px}.moodle-batch-low{color:#b91c1c}.moodle-batch-good{color:#166534}`;
  document.head.append(style);
  if (users.length !== 1 || !/^\d+$/u.test(users[0] || '')) { message.textContent = 'Не удалось определить аккаунт для сводки.'; refresh.disabled = true; return; }
  const user = users[0];
  const cacheKey = `moodle_batch_overview:${location.origin}:${user}`;
  const containers = new Map();
  for (const link of links) {
    const id = new URL(link.href).searchParams.get('id');
    const container = document.createElement('div'); container.className = 'moodle-batch-summary';
    container.textContent = 'Анализ тестов: загрузка…'; link.closest('td,th')?.append(container);
    if (!containers.has(id)) containers.set(id, []);
    containers.get(id).push(container);
  }
  let pending = false;
  let timer;
  const request = url => new Promise((done, reject) => GM_xmlhttpRequest({ method: 'GET', url,
    timeout: 15000, anonymous: true, headers: { Origin: location.origin },
    onload: response => {
      try {
        const data = JSON.parse(response.responseText);
        if (response.status !== 200) throw new Error(data.error || 'READ_FAILED');
        done(data);
      } catch (error) { reject(error); }
    }, onerror: () => reject(new Error('SERVICE_UNAVAILABLE')), ontimeout: () => reject(new Error('SERVICE_TIMEOUT')),
  }));
  function render(overview) {
    if (overview.origin !== location.origin || overview.userScope !== user || overview.schemaVersion !== 1) throw new Error('USER_SCOPE_MISMATCH');
    const progress = overview.progress;
    message.textContent = overview.phase === 'complete'
      ? `Проанализировано ${progress.totalCourses} курсов и ${progress.totalTests} тестов. Обновлено ${new Date(overview.completedAt).toLocaleTimeString()}.`
      : `Загружено курсов ${progress.courses}/${progress.totalCourses}; проверено тестов ${progress.tests}/${progress.totalTests}.`;
    for (const course of overview.courses) {
      for (const container of containers.get(course.courseId) || []) {
        const open = container.querySelector('details')?.open || false;
        const details = document.createElement('details'); details.open = open;
        const title = document.createElement('summary');
        const s = course.summary;
        title.textContent = course.status === 'loading' ? 'Анализ тестов: загрузка…'
          : `Тестов ${s.total} · 100%: ${s.maximum} · 90–99%: ${s.excellent} · ниже 90%: ${s.retry} · не решено: ${s.unattempted} · активных: ${s.active}`;
        if (course.cached) title.textContent += ' · сохранённые данные';
        details.append(title);
        if (course.gradeError || course.discoveryError || s.errors || s.unknown) {
          const warning = document.createElement('div'); warning.className = 'moodle-batch-low';
          warning.textContent = `Данные неполные: ошибок ${s.errors + Number(Boolean(course.gradeError)) + Number(Boolean(course.discoveryError))}; без оценки ${s.unknown}.`;
          details.append(warning);
        }
        const list = document.createElement('ul'); list.className = 'moodle-batch-tests';
        for (const quiz of course.quizzes) {
          const item = document.createElement('li');
          const link = document.createElement('a');
          const url = new URL(quiz.url);
          if (url.origin !== location.origin || url.pathname !== '/mod/quiz/view.php') continue;
          link.href = url.href; link.textContent = quiz.topic ? `${quiz.topic} — ${quiz.title}` : quiz.title;
          const grade = document.createElement('span');
          grade.textContent = quiz.percent === null ? (quiz.status === 'unattempted' ? 'Не решено' : 'Оценка неизвестна') : `${quiz.percent}%`;
          grade.className = quiz.status === 'retry' ? 'moodle-batch-low' : quiz.status === 'maximum' ? 'moodle-batch-good' : '';
          const info = document.createElement('span');
          info.textContent = quiz.error ? 'Не удалось проверить' : !quiz.checked ? 'Проверяется…'
            : [quiz.activeAttempt ? 'Активная попытка' : '', quiz.analysis ? `Известно ${quiz.analysis.known}/${quiz.analysis.total} ответов последней попытки` : '',
              quiz.analysis?.withExclusions ? `Исключения: ${quiz.analysis.withExclusions}` : '',
              quiz.preflightRequired ? 'Нужно подтверждение Moodle' : '', quiz.reviewError ? 'Обзор доступен не полностью' : ''].filter(Boolean).join(' · ');
          item.append(link, grade, info); list.append(item);
        }
        details.append(list); container.replaceChildren(details);
      }
    }
  }
  async function load(force = false) {
    if (pending) return;
    pending = true; refresh.disabled = true; clearTimeout(timer);
    try {
      const state = await request(`${endpoint}?user=${encodeURIComponent(user)}${force ? '&refresh=1' : ''}`);
      if (state.overview) render(state.overview);
      else message.textContent = 'Начинаю анализ всех курсов…';
      if (state.running && state.overview?.phase === 'complete') message.textContent += ' Обновляю в фоне…';
      if (state.overview?.phase === 'complete' && typeof GM_setValue === 'function') GM_setValue(cacheKey, state.overview);
      if (state.error) message.textContent = `Анализ остановлен: ${state.error}. Можно повторить обновление.`;
      if (state.running) timer = setTimeout(() => load(), 2000);
    } catch (error) {
      message.textContent = error.message === 'USER_SCOPE_MISMATCH' ? 'Аккаунт сводки отличается от аккаунта Moodle.'
        : 'Сервис анализа недоступен. Запустите Moodle Batch и нажмите «Обновить анализ».';
    } finally { pending = false; refresh.disabled = false; }
  }
  refresh.addEventListener('click', () => load(true));
  window.addEventListener('pagehide', () => clearTimeout(timer), { once: true });
  if (typeof GM_getValue === 'function') {
    const cached = GM_getValue(cacheKey, null);
    if (cached) {
      try { render({ ...cached, courses: cached.courses.map(course => ({ ...course, cached: true })) }); message.textContent += ' Проверяю обновления…'; }
      catch { /* wrong account or obsolete cache: use fresh authenticated analysis */ }
    }
  }
  load();
})();
