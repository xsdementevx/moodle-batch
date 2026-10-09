const params = new URLSearchParams(location.search);
const userScope = params.get('user');
const preset = params.get('quiz');
const $ = id => document.getElementById(id);
const selected = new Set(preset ? [preset] : []);
const cacheKey = `overview:${userScope}`;
let current, connected = false, pending = false, timer, submitting = false, initial = true, pendingIntent = null;
const api = async (route, body) => {
  const result = await chrome.runtime.sendMessage({ type: 'api', route, userScope, body });
  if (!result || result.error) {
    const error = new Error(result?.error || 'SERVICE_UNAVAILABLE'); error.rejected = result?.rejected === true; throw error;
  }
  return result.data;
};
const busy = () => current?.jobs.find(job => ['queued', 'running'].includes(job.status));
const belowMaximum = quiz => Number.isFinite(quiz.percent) && quiz.percent >= 0 && quiz.percent < 100;
const stages = { reading: 'Получаю тест', starting: 'Открываю попытку', context: 'Читаю материалы', solving: 'Решаю вопросы', submitting: 'Отправляю ответы', verifying: 'Проверяю оценку' };
const errors = { SERVICE_UNAVAILABLE: 'Запустите Moodle Batch на компьютере.', USER_SCOPE_MISMATCH: 'Аккаунт Moodle отличается от аккаунта сервиса.',
  LOGIN_REQUIRED: 'Сессия Moodle истекла. Войдите в Moodle, обновите cookies.json и нажмите «Обновить анализ». Показаны сохранённые оценки.',
  PAIRING_REQUIRED: 'Обновите расширение из папки, подготовленной сервисом.', UNKNOWN_MODEL_OUTCOME: 'Нужно проверить сохранённый запрос модели.',
  UNRESOLVED_SUBMISSION: 'Есть вопросы без надёжного ответа. Отправка остановлена.', MOODLE_PREFLIGHT_REQUIRED: 'Moodle требует подтверждение перед началом.',
  QUESTION_PACKET_TOO_LARGE: 'Один вопрос превышает размер запроса модели. Решение остановлено; попытка не отправлена.',
  SERVICE_RESTARTED: 'Сервис был перезапущен. Проверьте последнюю попытку перед новым запуском.', JOB_ALREADY_RUNNING: 'Другой запуск уже выполняется.' };
errors.GPT_EXTENSION_CONTEXT_UNAVAILABLE = 'Нет доступа к браузеру ChatGPT. Откройте Яндекс и разрешите подключение Playwright Extension.';
const node = (tag, text, className) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el; };
const time = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
const effortLabel = { Instant: 'Лёгкое размышление', Medium: 'Среднее размышление', High: 'Высокое размышление', instant: 'Лёгкое размышление', medium: 'Среднее размышление', high: 'Высокое размышление' };
const jobLabel = job => job.status === 'running' ? job.stopRequested ? 'Останавливается' : stages[job.current?.stage] || 'Выполняется' : ({ queued: 'Запуск принят', stopped: 'Остановлено', interrupted: 'Запуск прерван', complete: 'Запуск завершён' }[job.status] || job.status);
function notice(text, error = false) { $('message').textContent = text; $('message').classList.toggle('error', error); }
function matches(q, course) {
  const search = $('search').value.trim().toLocaleLowerCase('ru');
  if (search && !`${course.title} ${q.topic || ''} ${q.title} ${q.quizId}`.toLocaleLowerCase('ru').includes(search)) return false;
  if ($('course-filter').value && course.courseId !== $('course-filter').value) return false;
  if ($('low').checked && !belowMaximum(q)) return false;
  return ({ all: true, low: belowMaximum(q), new: !Number.isFinite(q.percent), maximum: q.percent === 100,
    selected: selected.has(q.quizId), error: Boolean(q.error || q.reviewError || q.analysis?.conflict || q.analysis?.unsupported) })[$('grade-filter').value];
}
function visibleQuizzes() { return (current?.overview?.courses || []).flatMap(course => course.quizzes.filter(q => matches(q, course))); }
function buttons() {
  const locked = submitting || Boolean(pendingIntent);
  $('run').disabled = submitting || Boolean(busy()) || !connected || !current || current.authRequired || !selected.size;
  $('run').textContent = pendingIntent ? `Проверить сохранённый запуск (${pendingIntent.quizIds.length})` : `Решить и отправить выбранные (${selected.size})`;
  for (const id of ['select', 'clear', 'rounds']) $(id).disabled = locked;
  for (const control of $('courses').querySelectorAll('input[type=checkbox],.course-select')) control.disabled = locked;
  $('stop').disabled = !busy() || busy().stopRequested;
  $('stop').textContent = busy()?.stopRequested ? 'Остановка запрошена…' : 'Остановить после текущего действия';
  $('refresh').disabled = Boolean(current?.running) || pending;
  $('selection-count').textContent = selected.size ? `Выбрано тестов: ${selected.size}` : 'Ничего не выбрано';
  const shown = new Set(visibleQuizzes().map(q => q.quizId));
  const hidden = [...selected].filter(id => !shown.has(id)).length;
  $('hidden-selected').textContent = hidden ? `${hidden} скрыто фильтрами · они тоже будут запущены` : '';
  $('run-summary').textContent = selected.size ? `В пакете ${selected.size} тестов. Сначала память и Jev, затем GPT Web для нерешённых вопросов.` : 'Выберите тесты слева, чтобы начать.';
}
function showProgress() {
  const job = busy() || current?.jobs.at(-1);
  if (!job) return;
  $('job-title').textContent = jobLabel(job);
  $('job-badge').textContent = ['queued', 'running'].includes(job.status) ? 'В работе' : job.error ? 'Прерван' : 'Завершён';
  $('job-badge').classList.toggle('active', ['queued', 'running'].includes(job.status));
  const detail = job.current;
  $('job-detail').textContent = detail ? [detail.quizId ? `Тест ${detail.quizId}` : `Пакет из ${detail.tests || job.quizIds.length} тестов`, `Попытка ${detail.round || 1} из ${job.maxAttempts}`, detail.provider, effortLabel[detail.reasoning] || detail.reasoning, detail.questions ? `${detail.questions} вопросов` : ''].filter(Boolean).join(' · ') : `Выбрано ${job.quizIds.length} тестов · ${time(job.finishedAt || job.createdAt)}`;
  const processed = job.results.filter(q => q.attempts.length || q.error).length;
  $('job-progress').max = job.quizIds.length; $('job-progress').value = processed;
  $('job-count').textContent = `Результат получен: ${processed} из ${job.quizIds.length} тестов`;
  $('job-results').replaceChildren(node('span', `100%: ${job.results.filter(q => q.attempts.at(-1)?.percent === 100).length}`, 'good'), node('span', `Ошибки: ${job.results.filter(q => q.error).length}`, 'job-error'), node('span', `Ниже 100%: ${job.results.filter(q => belowMaximum(q.attempts.at(-1) || {})).length}`, 'low'));
}
function eventText(event) {
  if (event.error) return errors[event.error] || event.error;
  if (event.kind === 'result') return `Тест ${event.quizId}: ${event.percent === null ? 'оценка не раскрыта' : `${event.percent}%`}`;
  if (event.kind === 'stop') return 'Запрошена остановка после текущего действия';
  if (event.kind === 'stopped') return 'Запуск остановлен';
  if (event.kind === 'complete') return 'Запуск завершён';
  return [stages[event.stage] || (event.kind === 'start' ? 'Запуск принят' : event.stage || 'Событие'), event.quizId ? `тест ${event.quizId}` : '', event.round ? `попытка ${event.round}` : '', event.provider, effortLabel[event.reasoning] || event.reasoning, event.questions ? `${event.questions} вопросов` : ''].filter(Boolean).join(' · ');
}
let jobsSignature = '';
function showJobs() {
  showProgress(); $('log-count').textContent = current?.jobs.length || 0;
  const signature = JSON.stringify([current?.jobs, $('errors-only').checked]);
  if (signature === jobsSignature) return; jobsSignature = signature;
  const opened = new Set([...$('jobs').querySelectorAll('details[open]')].map(el => el.dataset.job));
  $('jobs').replaceChildren();
  for (const job of [...(current?.jobs || [])].reverse()) {
    if ($('errors-only').checked && !job.error && !job.results.some(q => q.error)) continue;
    const box = node('article', undefined, 'job');
    const heading = node('div', undefined, 'job-heading'); heading.append(node('strong', jobLabel(job)), node('span', `${job.quizIds.length} тестов`, 'badge'));
    box.append(heading, node('p', `${time(job.createdAt)} · попыток на тест: ${job.maxAttempts}`, 'job-time'));
    if (job.error) box.append(node('p', errors[job.error] || job.error, 'job-error'));
    const resultDetails = node('details'); resultDetails.dataset.job = `${job.requestId}:results`; resultDetails.open = opened.has(resultDetails.dataset.job);
    resultDetails.append(node('summary', `Результаты тестов (${job.results.length})`));
    for (const result of job.results) {
      if ($('errors-only').checked && !result.error) continue;
      const last = result.attempts.at(-1);
      const p = node('p', `Тест ${result.quizId}: ${last ? last.grade || `${last.correct}/${last.total} правильных` : result.error ? 'остановлен' : result.status === 'stopped' ? 'не отправлен' : 'проверяется'}${result.error ? ` · ${errors[result.error] || result.error}` : ''}`, last?.percent === 100 ? 'good' : result.error ? 'job-error' : 'low');
      if (last?.reviewUrl) {
        try { const url = new URL(last.reviewUrl); if (url.origin === current.origin && url.pathname === '/mod/quiz/review.php') { const link = node('a', ' Результат Moodle ↗'); link.href = url.href; link.target = '_blank'; link.rel = 'noopener'; p.append(link); } } catch { /* malformed review URL */ }
      }
      resultDetails.append(p);
    }
    box.append(resultDetails);
    if (job.events?.length) {
      const details = node('details'); details.dataset.job = `${job.requestId}:events`; details.open = opened.has(details.dataset.job) || job.status === 'running'; details.append(node('summary', `Этапы запуска (${job.events.length})`));
      const list = node('ol', undefined, 'events');
      for (const event of [...job.events].reverse()) {
        if ($('errors-only').checked && !event.error) continue;
        const row = node('li', undefined, event.error ? 'error' : ''); const stamp = node('time', time(event.at)); stamp.dateTime = event.at; row.append(stamp, node('span', eventText(event))); list.append(row);
      }
      details.append(list); box.append(details);
    } else box.append(node('p', 'Для старого запуска сохранены результаты. Подробные этапы записываются с новой версии.', 'muted'));
    $('jobs').append(box);
  }
  if (!$('jobs').childElementCount) $('jobs').append(node('div', $('errors-only').checked ? 'Запусков с ошибками нет.' : 'Пока нет запусков. Выберите тесты и начните решение.', 'empty'));
}
let overviewSignature = '';
function render(overview, cached = false, force = false) {
  if (!overview || overview.userScope !== userScope || overview.origin !== 'https://sdo.sibupk.su') throw new Error('USER_SCOPE_MISMATCH');
  const all = overview.courses.flatMap(course => course.quizzes);
  $('metric-total').textContent = all.length; $('nav-count').textContent = all.length;
  $('metric-courses').textContent = `Курсов: ${overview.courses.length}`;
  $('metric-max').textContent = all.filter(q => q.percent === 100).length;
  $('metric-low').textContent = all.filter(belowMaximum).length;
  $('metric-new').textContent = all.filter(q => !Number.isFinite(q.percent)).length;
  const progress = overview.progress;
  const scanningCourses = overview.phase === 'courses';
  $('scan-progress').max = (scanningCourses ? progress.totalCourses : progress.totalTests) || 1;
  $('scan-progress').value = (scanningCourses ? progress.courses : progress.tests) || 0;
  $('scan-detail').textContent = scanningCourses ? `Курсы: ${progress.courses} из ${progress.totalCourses}` : `Проверено тестов: ${progress.tests} из ${progress.totalTests}`;
  $('scan-badge').textContent = cached ? 'Сохранено' : current?.error ? 'Остановлен' : current?.running ? 'Обновляется' : 'Готово';
  $('scan-badge').classList.toggle('active', Boolean(current?.running));
  $('updated').textContent = overview.completedAt ? `Обновлено: ${time(overview.completedAt)}` : 'Оценки появляются по мере проверки.';
  notice(cached ? 'Показаны сохранённые оценки. Подключаемся к сервису…' : current?.running ? 'Анализ обновляется. Вы можете выбирать тесты, пока появляются оценки.' : 'Данные актуальны. Выберите тесты для решения.');
  const signature = JSON.stringify(overview);
  if (!force && signature === overviewSignature) { buttons(); return; } overviewSignature = signature;
  const filter = $('course-filter'); const previous = filter.value;
  filter.replaceChildren(new Option('Все курсы', ''));
  for (const course of overview.courses) filter.add(new Option(course.title, course.courseId)); filter.value = previous;
  const opened = new Set([...$('courses').querySelectorAll('details[open]')].map(el => el.dataset.course));
  const focusedQuiz = document.activeElement?.dataset.quiz;
  const focusedCourse = document.activeElement?.classList.contains('course-select') ? document.activeElement.closest('details').dataset.course : null;
  const fragment = document.createDocumentFragment(); let count = 0, courseCount = 0;
  for (const course of overview.courses) {
    const quizzes = course.quizzes.filter(q => matches(q, course)); if (!quizzes.length) continue;
    count += quizzes.length; courseCount++;
    const details = node('details'); details.dataset.course = course.courseId;
    details.open = opened.has(course.courseId) || quizzes.some(q => q.quizId === preset) || Boolean($('search').value.trim()) || Boolean(filter.value);
    const summary = node('summary'); const title = node('div', undefined, 'course-title'); title.append(node('div', course.title), node('small', `${quizzes.length} тестов · ниже 100%: ${course.quizzes.filter(belowMaximum).length}`, 'course-meta'));
    const select = node('button', quizzes.every(q => selected.has(q.quizId)) ? 'Снять выбор' : 'Выбрать', 'text-button course-select'); select.type = 'button'; select.setAttribute('aria-label', `Выбор показанных тестов курса ${course.title}`);
    select.addEventListener('click', e => { e.preventDefault(); const clear = quizzes.every(q => selected.has(q.quizId)); quizzes.forEach(q => clear ? selected.delete(q.quizId) : selected.add(q.quizId)); render(overview, false, true); }); summary.append(title, select); details.append(summary);
    for (const q of quizzes) {
      const row = node('div', undefined, 'quiz'); const check = node('input'); check.type = 'checkbox'; check.dataset.quiz = q.quizId; check.checked = selected.has(q.quizId); check.setAttribute('aria-label', `Выбрать тест ${q.title}`);
      check.addEventListener('change', () => { check.checked ? selected.add(q.quizId) : selected.delete(q.quizId); if ($('grade-filter').value === 'selected') render(overview, false, true); else { buttons(); select.textContent = quizzes.every(q => selected.has(q.quizId)) ? 'Снять выбор' : 'Выбрать'; } });
      const a = node('a', q.topic ? `${q.topic} — ${q.title}` : q.title); a.href = `${overview.origin}/mod/quiz/view.php?id=${encodeURIComponent(q.quizId)}`; a.target = '_blank'; a.rel = 'noopener';
      const score = node('span', !Number.isFinite(q.percent) ? 'Без оценки' : `${q.percent}%`, `score ${belowMaximum(q) ? 'low' : q.percent === 100 ? 'good' : ''}`);
      if (q.error || q.reviewError) score.title = errors[q.error || q.reviewError] || q.error || q.reviewError;
      row.append(check, a, score); details.append(row);
    }
    fragment.append(details);
  }
  $('courses').replaceChildren(fragment);
  if (focusedQuiz) [...$('courses').querySelectorAll('input')].find(el => el.dataset.quiz === focusedQuiz)?.focus({ preventScroll: true });
  else if (focusedCourse) [...$('courses').querySelectorAll('details')].find(el => el.dataset.course === focusedCourse)?.querySelector('.course-select')?.focus({ preventScroll: true });
  $('empty').hidden = count > 0;
  $('visible-count').textContent = `Показано ${count} из ${all.length} тестов · ${courseCount} курсов`;
  buttons();
}
function navigate(logs) {
  $('tests-view').hidden = logs; $('logs-view').hidden = !logs;
  $('nav-tests').classList.toggle('active', !logs); $('nav-logs').classList.toggle('active', logs);
  $('nav-tests').toggleAttribute('aria-current', !logs); $('nav-logs').toggleAttribute('aria-current', logs);
  if (logs) $('nav-logs').setAttribute('aria-current', 'page'); else $('nav-tests').setAttribute('aria-current', 'page');
  history.replaceState(null, '', logs ? '#logs' : '#tests');
  $('page-title').textContent = logs ? 'Журнал запусков' : 'Ваши тесты';
}
$('nav-tests').addEventListener('click', () => navigate(false)); $('nav-logs').addEventListener('click', () => navigate(true)); $('open-logs').addEventListener('click', () => { navigate(true); $('nav-logs').focus(); });
$('errors-only').addEventListener('change', showJobs);
for (const id of ['search', 'course-filter', 'grade-filter']) $(id).addEventListener(id === 'search' ? 'input' : 'change', () => { if (id === 'grade-filter') $('low').checked = $('grade-filter').value === 'low'; if (current?.overview) render(current.overview, false, true); });
$('reset-filters').addEventListener('click', () => { $('search').value = ''; $('course-filter').value = ''; $('grade-filter').value = 'all'; $('low').checked = false; if (current?.overview) render(current.overview, false, true); });

async function load() {
  if (pending) return;
  pending = true; clearTimeout(timer);
  try {
    current = await api('state');
    connected = true; $('connection').textContent = 'Сервис подключён'; $('connection-dot').classList.add('online');
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
    if (current.authRequired) notice(errors.LOGIN_REQUIRED, true);
    if (current.error) notice(`Анализ остановлен: ${errors[current.error] || current.error}. Нажмите «Обновить анализ».`, true);
    const intent = (await chrome.storage.local.get('pendingJob')).pendingJob;
    if (intent?.userScope === userScope && current.jobs.some(job => job.requestId === intent.requestId)) {
      await chrome.storage.local.remove('pendingJob'); pendingIntent = null; buttons();
    }
  } catch (error) { connected = false; notice(errors[error.message] || error.message, true); $('connection').textContent = 'Нет подключения'; $('connection-dot').classList.remove('online'); $('run').disabled = true; }
  finally { pending = false; $('refresh').disabled = Boolean(current?.running); timer = setTimeout(load, busy() || current?.running ? 2000 : 10000); }
}
$('low').addEventListener('change', () => { $('grade-filter').value = $('low').checked ? 'low' : 'all'; if (current?.overview) render(current.overview, false, true); });
$('select').addEventListener('click', () => {
  for (const q of visibleQuizzes()) selected.add(q.quizId);
  if (current?.overview) render(current.overview, false, true);
});
$('clear').addEventListener('click', () => { selected.clear(); if (current?.overview) render(current.overview, false, true); });
$('refresh').addEventListener('click', async () => { try { await api('refresh'); await load(); } catch (error) { notice(errors[error.message] || error.message, true); } });
$('stop').addEventListener('click', async () => { try { await api('stop', { requestId: busy().requestId }); await load(); } catch (error) { notice(errors[error.message] || error.message, true); } });
$('run').addEventListener('click', async () => {
  if (submitting || busy() || !connected || current?.authRequired || !selected.size) return;
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
    notice(errors[error.message] || error.message, true);
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
  navigate(location.hash === '#logs');
  buttons();
  load();
})();
