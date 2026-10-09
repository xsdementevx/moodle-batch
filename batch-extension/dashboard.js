const params = new URLSearchParams(location.search);
const userScope = params.get('user');
const preset = params.get('quiz');
const $ = id => document.getElementById(id);
const selected = new Set(preset ? [preset] : []);
const cacheKey = `overview:${userScope}`;
let current, pending = false, timer, submitting = false, initial = true, pendingIntent = null;
const api = async (route, body) => {
  const result = await chrome.runtime.sendMessage({ type: 'api', route, userScope, body });
  if (!result || result.error) {
    const error = new Error(result?.error || 'SERVICE_UNAVAILABLE'); error.rejected = result?.rejected === true; throw error;
  }
  return result.data;
};
const busy = () => current?.jobs.find(job => ['queued', 'running'].includes(job.status));
const stages = { reading: 'Получаю тест', starting: 'Открываю попытку', context: 'Читаю материалы', solving: 'Решаю вопросы', submitting: 'Отправляю ответы', verifying: 'Проверяю оценку' };
const errors = { SERVICE_UNAVAILABLE: 'Запустите Moodle Batch на компьютере.', USER_SCOPE_MISMATCH: 'Аккаунт Moodle отличается от аккаунта сервиса.',
  LOGIN_REQUIRED: 'Сессия Moodle истекла. Войдите в Moodle, обновите cookies.json и нажмите «Обновить анализ». Показаны сохранённые оценки.',
  PAIRING_REQUIRED: 'Обновите расширение из папки, подготовленной сервисом.', UNKNOWN_MODEL_OUTCOME: 'Нужно проверить сохранённый запрос модели.',
  UNRESOLVED_SUBMISSION: 'Есть вопросы без надёжного ответа. Отправка остановлена.', MOODLE_PREFLIGHT_REQUIRED: 'Moodle требует подтверждение перед началом.',
  SERVICE_RESTARTED: 'Сервис был перезапущен. Проверьте последнюю попытку перед новым запуском.', JOB_ALREADY_RUNNING: 'Другой запуск уже выполняется.' };
errors.GPT_EXTENSION_CONTEXT_UNAVAILABLE = 'Нет доступа к браузеру ChatGPT. Откройте Яндекс и разрешите подключение Playwright Extension.';
function buttons() {
  $('run').disabled = submitting || Boolean(busy()) || current?.authRequired || !selected.size;
  $('run').textContent = pendingIntent ? `Проверить сохранённый запуск (${pendingIntent.quizIds.length})` : `Решить и отправить выбранные (${selected.size})`;
  for (const id of ['select', 'clear', 'rounds']) $(id).disabled = submitting || Boolean(pendingIntent);
  for (const check of $('courses').querySelectorAll('input[type=checkbox]')) check.disabled = submitting || Boolean(pendingIntent);
  $('stop').disabled = !busy();
}
function showJobs() {
  $('jobs').replaceChildren();
  for (const job of (current?.jobs || []).slice(-5).reverse()) {
    const box = document.createElement('div'); box.className = 'job';
    const heading = document.createElement('strong');
    const target = job.current?.quizId ? `тест ${job.current.quizId}` : `пакет: ${job.current?.tests || job.quizIds.length} тестов`;
    const effort = job.current?.reasoning ? ` · ${job.current.reasoning} · ${job.current.questions} вопросов` : '';
    heading.textContent = job.status === 'running' ? `${stages[job.current?.stage] || 'Выполняю'}${effort} · ${target} · попытка ${job.current?.round || 1}`
      : job.status === 'queued' ? 'Запуск принят' : job.status === 'stopped' ? 'Остановлено' : job.status === 'interrupted' ? 'Запуск прерван' : 'Запуск завершён';
    box.append(heading);
    if (job.error) { const p = document.createElement('p'); p.textContent = errors[job.error] || job.error; box.append(p); }
    for (const result of job.results) {
      const p = document.createElement('p'); const last = result.attempts.at(-1);
      p.textContent = `Тест ${result.quizId}: ${last ? last.grade || `${last.correct}/${last.total} правильных` : result.error ? 'остановлен' : 'проверяется'}${result.error ? ` · ${errors[result.error] || result.error}` : ''}`;
      p.className = last?.percent === 100 ? 'good' : result.error || last ? 'low' : '';
      if (last?.reviewUrl) {
        const url = new URL(last.reviewUrl);
        if (url.origin === current.origin && url.pathname === '/mod/quiz/review.php') {
          const link = document.createElement('a'); link.href = url.href; link.textContent = ' Результат Moodle'; link.target = '_blank'; p.append(link);
        }
      }
      box.append(p);
    }
    $('jobs').append(box);
  }
}
function render(overview, cached = false) {
  if (!overview || overview.userScope !== userScope || overview.origin !== 'https://sdo.sibupk.su') throw new Error('USER_SCOPE_MISMATCH');
  const opened = new Set([...$('courses').querySelectorAll('details[open]')].map(el => el.dataset.course));
  $('courses').replaceChildren();
  $('message').textContent = `${cached ? 'Сохранённые данные. ' : ''}Курсов ${overview.progress.courses}/${overview.progress.totalCourses}; проверено тестов ${overview.progress.tests}/${overview.progress.totalTests}.`;
  for (const course of overview.courses) {
    const quizzes = course.quizzes.filter(q => !$('low').checked || q.status === 'retry' || selected.has(q.quizId));
    if (!quizzes.length) continue;
    const details = document.createElement('details'); details.dataset.course = course.courseId;
    details.open = opened.has(course.courseId) || quizzes.some(q => q.quizId === preset);
    const summary = document.createElement('summary'); summary.textContent = `${course.title} · тестов ${course.summary.total} · ниже 90%: ${course.summary.retry}`; details.append(summary);
    for (const q of quizzes) {
      const row = document.createElement('label'); row.className = 'quiz';
      const check = document.createElement('input'); check.type = 'checkbox'; check.checked = selected.has(q.quizId);
      check.addEventListener('change', () => { if (check.checked) selected.add(q.quizId); else selected.delete(q.quizId); buttons(); });
      const a = document.createElement('a'); a.href = `https://sdo.sibupk.su/mod/quiz/view.php?id=${encodeURIComponent(q.quizId)}`;
      a.textContent = q.topic ? `${q.topic} — ${q.title}` : q.title; a.target = '_blank';
      const score = document.createElement('span'); score.textContent = q.percent === null ? 'Без оценки' : `${q.percent}%`;
      score.className = q.status === 'retry' ? 'low' : q.status === 'maximum' ? 'good' : '';
      row.append(check, a, score); details.append(row);
    }
    $('courses').append(details);
  }
  buttons();
}
async function load() {
  if (pending) return;
  pending = true; clearTimeout(timer);
  try {
    current = await api('state');
    if (current.userScope !== userScope) throw new Error('USER_SCOPE_MISMATCH');
    if (initial) {
      initial = false;
      if (!current.running && (!current.overview || Date.now() - Date.parse(current.overview.completedAt || '') > 300000)) await api('refresh');
    }
    if (current.overview) {
      render(current.overview);
      if (current.overview.phase === 'complete') await chrome.storage.local.set({ [cacheKey]: current.overview });
    }
    showJobs(); buttons();
    if (current.authRequired) $('message').textContent = errors.LOGIN_REQUIRED;
    if (current.error) $('message').textContent = `Анализ остановлен: ${errors[current.error] || current.error}. Нажмите «Обновить анализ».`;
    const intent = (await chrome.storage.local.get('pendingJob')).pendingJob;
    if (intent?.userScope === userScope && current.jobs.some(job => job.requestId === intent.requestId)) {
      await chrome.storage.local.remove('pendingJob'); pendingIntent = null; buttons();
    }
  } catch (error) { $('message').textContent = errors[error.message] || error.message; }
  finally { pending = false; timer = setTimeout(load, busy() || current?.running ? 2000 : 10000); }
}
$('low').addEventListener('change', () => { if (current?.overview) render(current.overview); });
$('select').addEventListener('click', () => {
  for (const q of current?.overview?.courses.flatMap(course => course.quizzes) || []) if (!$('low').checked || q.status === 'retry') selected.add(q.quizId);
  if (current?.overview) render(current.overview);
});
$('clear').addEventListener('click', () => { selected.clear(); if (current?.overview) render(current.overview); });
$('refresh').addEventListener('click', async () => { try { await api('refresh'); await load(); } catch (error) { $('message').textContent = errors[error.message] || error.message; } });
$('stop').addEventListener('click', async () => { try { await api('stop', { requestId: busy().requestId }); await load(); } catch (error) { $('message').textContent = errors[error.message] || error.message; } });
$('run').addEventListener('click', async () => {
  if (submitting || busy() || !selected.size) return;
  submitting = true; buttons();
  try {
    // Preserve the exact intent across a lost HTTP reply; retries use the same requestId.
    let intent = (await chrome.storage.local.get('pendingJob')).pendingJob;
    if (intent && intent.userScope !== userScope) throw new Error('USER_SCOPE_MISMATCH');
    intent ||= { requestId: crypto.randomUUID(), userScope, quizIds: [...selected], maxAttempts: Number($('rounds').value) };
    pendingIntent = intent;
    await chrome.storage.local.set({ pendingJob: intent });
    await api('jobs', intent); await chrome.storage.local.remove('pendingJob'); pendingIntent = null; await load();
  } catch (error) {
    if (error.rejected) { await chrome.storage.local.remove('pendingJob'); pendingIntent = null; }
    $('message').textContent = errors[error.message] || error.message;
  }
  finally { submitting = false; buttons(); }
});
(async () => {
  const intent = (await chrome.storage.local.get('pendingJob')).pendingJob;
  if (intent?.userScope === userScope) {
    pendingIntent = intent; selected.clear(); intent.quizIds.forEach(id => selected.add(id)); $('rounds').value = String(intent.maxAttempts);
  }
  const cached = (await chrome.storage.local.get(cacheKey))[cacheKey];
  if (cached) { try { render(cached, true); } catch { /* another account cache */ } }
  buttons();
  load();
})();
