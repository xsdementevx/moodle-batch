const params = new URLSearchParams(location.search);
let userScope = globalThis.batchConfig.userScope;
const preset = params.get('quiz');
const $ = id => document.getElementById(id);
const selected = new Set(preset ? [preset] : []);
const cacheKey = () => `overview:${userScope}`;
const timingKey = () => `secondsPerQuestion:${userScope}`;
const intentKey = () => `pendingJob:${userScope}`;
async function restoreIntent() {
  const key = intentKey();
  const saved = await chrome.storage.local.get([key, 'pendingJob']);
  if (!saved[key] && saved.pendingJob?.userScope === userScope) {
    await chrome.storage.local.set({ [key]: saved.pendingJob });
    await chrome.storage.local.remove('pendingJob');
    return saved.pendingJob;
  }
  return saved[key];
}
let current, connected = false, pending = false, timer, submitting = false, initial = true, pendingIntent = null;
let issuesOnly = location.hash === '#issues';
const api = async (route, body) => {
  const result = await chrome.runtime.sendMessage({ type: 'api', route, userScope, body });
  if (!result || result.error) {
    const error = new Error(result?.error || 'SERVICE_UNAVAILABLE'); error.rejected = result?.rejected === true; throw error;
  }
  return result.data;
};
const busy = () => current?.jobs.find(job => ['queued', 'running'].includes(job.status));
const belowMaximum = quiz => Number.isFinite(quiz.percent) && quiz.percent >= 0 && quiz.percent < 100;
const stages = { reading: 'Получаю тест', starting: 'Открываю попытку', context: 'Читаю материалы', solving: 'Решаю вопросы', recovering: 'Восстанавливаю сохранённый ответ ChatGPT', web_wait: 'Ожидаю доступ к ответу ChatGPT', waiting: 'Жду минимальное время попытки', submitting: 'Отправляю ответы', verifying: 'Проверяю оценку' };
const errors = { SERVICE_UNAVAILABLE: 'Запустите Moodle Batch на компьютере.', USER_SCOPE_MISMATCH: 'Аккаунт Moodle отличается от аккаунта сервиса.',
  SESSION_CHANGED: 'Аккаунт Moodle изменился. Обновите панель перед запуском.',
  SESSION_BUSY: 'Смена сессии ожидает завершения текущего действия. Повторите обновление.',
  LOGIN_REQUIRED: 'Войдите в Moodle в этом браузере. Расширение передаст сессию автоматически. Показаны сохранённые оценки.',
  PAIRING_REQUIRED: 'Обновите расширение из папки, подготовленной сервисом.', UNKNOWN_MODEL_OUTCOME: 'Есть незавершённый сохранённый запрос модели для этого теста. Повторная отправка заблокирована; остальные тесты могут решаться.',
  START_UNAVAILABLE: 'Moodle не предоставил форму начала попытки. Откройте тест, чтобы проверить сроки, доступ и лимит попыток.',
  UNRESOLVED_SUBMISSION: 'Есть вопросы без надёжного ответа. Отправка остановлена.', MOODLE_PREFLIGHT_REQUIRED: 'Moodle требует подтвердить начало попытки. Откройте тест и подтвердите условия, затем запустите его здесь — активная попытка будет продолжена.',
  QUESTION_PACKET_TOO_LARGE: 'Один вопрос превышает размер запроса модели. Решение остановлено; попытка не отправлена.',
  SERVICE_RESTARTED: 'Сервис был перезапущен. Проверьте последнюю попытку перед новым запуском.', JOB_ALREADY_RUNNING: 'Другой запуск уже выполняется.' };
errors.GPT_WEB_REASONING_UNAVAILABLE = 'Не удалось выбрать уровень размышления ChatGPT. Запрос не отправлен. Повторите запуск после загрузки меню модели.';
errors.GPT_EXTENSION_CONTEXT_UNAVAILABLE = 'Нет доступа к браузеру ChatGPT. Откройте Яндекс и разрешите подключение Playwright Extension.';
errors.GPT_WEB_CONVERSATION_UNAVAILABLE = 'Сохранённая беседа ChatGPT недоступна (404). Проверьте аккаунт и наличие чата. Повторный запрос не отправляется.';
errors.GPT_WEB_GENERATION_INTERRUPTED = 'Поток ответа ChatGPT прерван. Запрос сохранён; повторно модели не отправляется.';
errors.GPT_WEB_GENERATION_TIMEOUT = 'ChatGPT не завершил поток ответа за 5 минут. Запрос сохранён; перед продолжением нужно прочитать исходную беседу.';
errors.GPT_WEB_GENERATION_NOT_OBSERVED = 'После нажатия отправки запрос генерации не обнаружен. Исход неизвестен; повторная отправка заблокирована, нужно проверить исходную беседу.';
errors.GPT_WEB_HISTORY_LOAD_TIMEOUT = 'История исходной беседы ChatGPT не загрузилась за 5 минут. Повторный запрос модели не отправляется.';
errors.GPT_WEB_RATE_LIMITED = 'ChatGPT ограничил частоту чтения (429). Время ожидания истекло; запрос сохранён, повторно модели не отправлялся.';
errors.GPT_WEB_CONVERSATION_ACCESS_DENIED = 'ChatGPT не разрешил прочитать беседу. Проверьте вход в тот же аккаунт в браузере.';
errors.INVALID_ATTEMPT_TIME = 'Сохранённая отметка времени попытки повреждена или относится к другой попытке. Отправка остановлена.';
errors.INVALID_MINIMUM_TIME = 'Укажите целое число от 0 до 600 секунд на вопрос.';
const node = (tag, text, className) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el; };
const time = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
const duration = seconds => `${Math.floor(Math.max(0, Math.ceil(seconds)) / 60)} мин. ${Math.max(0, Math.ceil(seconds)) % 60} сек.`;
const effortLabel = { Instant: 'Лёгкое размышление', Medium: 'Среднее размышление', High: 'Высокое размышление', instant: 'Лёгкое размышление', medium: 'Среднее размышление', high: 'Высокое размышление' };
const jobLabel = job => job.status === 'running' ? job.stopRequested ? 'Останавливается' : stages[job.current?.stage] || 'Выполняется' : job.status === 'complete' && job.results.some(q => q.error) ? 'Завершён с ошибками' : ({ queued: 'Запуск принят', stopped: 'Остановлено', interrupted: 'Запуск прерван', complete: 'Запуск завершён' }[job.status] || job.status);
function notice(text, error = false) { $('message').textContent = text; $('message').classList.toggle('error', error); }
const feedbackLabel = value => ({ correct: 'Верно', incorrect: 'Неверно', partiallycorrect: 'Частично верно', unconfirmed: 'Результат не раскрыт' }[value] || 'Результат не раскрыт');
const answerDetails = source => [
  ...(source.question ? [`Формулировка: ${source.question}`] : []),
  ...(source.answer?.length ? [`Отправлено: ${source.answer.join('; ')}`] : []),
  ...(Number.isFinite(source.confidence) ? [`Уверенность модели: ${Math.round(source.confidence * 100)}%`] : []),
  ...(source.semanticVerified ? ['Связь цитат с ответом: проверена отдельно через Jev'] : []),
  ...(source.evidence || []).map(e => `Цитата: «${e.quote}» · ${e.kind === 'context' ? 'материалы курса' : e.url}`),
  ...(source.optionChecks || []).map(check => `${check.selected ? 'Выбрать' : 'Исключить'} «${check.text}»: ${check.reason}${check.evidence ? ` · «${check.evidence.quote}» · ${check.evidence.kind === 'context' ? 'материалы курса' : check.evidence.url}` : ' · проверено Moodle'}`),
];
const reviewDetail = question => `Вопрос ${question.slot}: ${reviewReasons[question.reason] || question.reason}${question.explanation ? ` · ${question.explanation}` : ''}${Number.isFinite(question.confidence) ? ` · уверенность модели: ${Math.round(question.confidence * 100)}%` : ''}`;
function problemDetails(q) {
  const latest = current?.jobs.slice().reverse().flatMap(job => job.results || []).find(result => result.quizId === q.quizId);
  const code = latest?.error || q.error || q.reviewError;
  return [code ? errors[code] || code : '', q.analysis?.conflict ? `Конфликтов в памяти: ${q.analysis.conflict}` : '',
    q.analysis?.unsupported ? `Неподдерживаемых вопросов: ${q.analysis.unsupported}` : '',
    ...(latest?.unresolvedQuestions || []).map(reviewDetail),
    ...(latest?.attempts.at(-1)?.sources || []).filter(item => ['incorrect', 'partiallycorrect'].includes(item.feedback))
      .map(item => `Вопрос ${item.slot}: ${feedbackLabel(item.feedback)} по проверке Moodle`)].filter(Boolean);
}
function matches(q, course) {
  if (issuesOnly && !problemDetails(q).length) return false;
  const search = $('search').value.trim().toLocaleLowerCase('ru');
  if (search && !`${course.title} ${q.topic || ''} ${q.title} ${q.quizId}`.toLocaleLowerCase('ru').includes(search)) return false;
  if ($('course-filter').value && course.courseId !== $('course-filter').value) return false;
  if ($('low').checked && !belowMaximum(q)) return false;
  return ({ all: true, low: belowMaximum(q), new: !Number.isFinite(q.percent), maximum: q.percent === 100,
    active: Boolean(q.activeAttempt), selected: selected.has(q.quizId), error: Boolean(problemDetails(q).length) })[$('grade-filter').value];
}
function visibleQuizzes() { return (current?.overview?.courses || []).flatMap(course => course.quizzes.filter(q => matches(q, course))); }
function buttons() {
  const locked = submitting || Boolean(pendingIntent);
  $('run').disabled = submitting || Boolean(busy()) || !connected || !current || current.authRequired || !selected.size;
  $('run').textContent = pendingIntent ? `Проверить сохранённый запуск (${pendingIntent.quizIds.length})` : `Решить и отправить выбранные (${selected.size})`;
  for (const id of ['select', 'clear', 'rounds']) $(id).disabled = locked;
  $('seconds-per-question').disabled = locked || Boolean(busy());
  for (const control of $('courses').querySelectorAll('input[type=checkbox],.course-select')) control.disabled = locked;
  for (const control of $('courses').querySelectorAll('.quiz-action')) control.disabled = locked || Boolean(busy()) || !connected || current?.authRequired || control.dataset.exhausted === 'true';
  $('stop').disabled = !busy() || busy().stopRequested;
  $('stop').textContent = busy()?.stopRequested ? 'Остановка запрошена…' : 'Остановить после текущего действия';
  $('refresh').disabled = Boolean(current?.running) || pending; $('analyze').disabled = $('refresh').disabled; $('check-attempts').disabled = $('refresh').disabled;
  $('selection-count').textContent = selected.size ? `Выбрано тестов: ${selected.size}` : 'Ничего не выбрано';
  const shown = new Set(visibleQuizzes().map(q => q.quizId));
  const hidden = [...selected].filter(id => !shown.has(id)).length;
  $('hidden-selected').textContent = hidden ? `${hidden} скрыто фильтрами · они тоже будут запущены` : '';
  $('run-summary').textContent = selected.size ? `В пакете ${selected.size} тестов. Сначала память и Jev, затем GPT Web для нерешённых вопросов.` : 'Выберите тесты слева, чтобы начать.';
}
function showProgress() {
  const job = busy() || current?.jobs.at(-1);
  if (!job) {
    $('job-title').textContent = 'Готов к запуску'; $('job-badge').textContent = 'Ожидание';
    $('job-badge').classList.remove('active'); $('job-detail').textContent = '';
    $('job-progress').value = 0; $('job-count').textContent = ''; $('job-results').replaceChildren();
    return;
  }
  $('job-title').textContent = jobLabel(job);
  $('job-badge').textContent = ['queued', 'running'].includes(job.status) ? 'В работе' : job.error || job.results.some(q => q.error) ? 'Есть ошибки' : 'Завершён';
  $('job-badge').classList.toggle('active', ['queued', 'running'].includes(job.status));
  const detail = job.current;
  $('job-detail').textContent = detail ? [detail.quizId ? `Тест ${detail.quizId}` : `Пакет из ${detail.tests || job.quizIds.length} тестов`, `Попытка ${detail.round || 1} из ${job.maxAttempts}`, detail.provider, effortLabel[detail.reasoning] || detail.reasoning, detail.questions ? `${detail.questions} вопросов` : ''].filter(Boolean).join(' · ') : `Выбрано ${job.quizIds.length} тестов · ${time(job.finishedAt || job.createdAt)}`;
  if (job.status === 'running' && detail?.stage === 'waiting') {
    $('job-detail').textContent += ` · минимум ${duration(detail.minimumSeconds)} · прошло ${duration((Date.now() - detail.startedAt) / 1000)} · осталось ${duration((detail.readyAt - Date.now()) / 1000)}${detail.timingSource === 'first_seen' ? ' · отсчёт с первого обнаружения' : ''}`;
  }
  if (job.status === 'running' && detail?.stage === 'web_wait') {
    $('job-detail').textContent += !detail.httpStatus ? ' · Жду загрузку исходного чата в той же вкладке (до 5 минут).' : ` · ${detail.httpStatus === 429 ? 'ChatGPT ограничил частоту чтения' : 'ChatGPT временно недоступен'} (HTTP ${detail.httpStatus}) · следующая проверка через ${duration((detail.retryAt - Date.now()) / 1000)}. Читаю беседу без повторной отправки запроса модели.`;
  }
  const processed = job.results.filter(q => q.attempts.length || q.error).length;
  $('job-progress').max = job.quizIds.length; $('job-progress').value = processed;
  $('job-count').textContent = `Результат получен: ${processed} из ${job.quizIds.length} тестов`;
  $('job-results').replaceChildren(node('span', `100%: ${job.results.filter(q => q.attempts.at(-1)?.percent === 100).length}`, 'good'), node('span', `Ошибки: ${job.results.filter(q => q.error).length}`, 'job-error'), node('span', `Ниже 100%: ${job.results.filter(q => belowMaximum(q.attempts.at(-1) || {})).length}`, 'low'));
}
function eventText(event) {
  if (event.error) return [event.quizId ? `Тест ${event.quizId}` : '', event.round ? `попытка ${event.round}` : '', errors[event.error] || event.error].filter(Boolean).join(' · ');
  if (event.kind === 'result') return `Тест ${event.quizId}: ${event.percent === null ? 'оценка не раскрыта' : `${event.percent}%`}`;
  if (event.kind === 'stop') return 'Запрошена остановка после текущего действия';
  if (event.kind === 'stopped') return 'Запуск остановлен';
  if (event.kind === 'complete') return 'Запуск завершён';
  if (event.stage === 'web_wait' && !event.httpStatus) return 'Жду загрузку исходного чата в той же вкладке (до 5 минут)';
  if (event.stage === 'web_wait') return `Ожидаю доступ к ответу ChatGPT · HTTP ${event.httpStatus} · следующая проверка ${time(new Date(event.retryAt).toISOString())}`;
  if (event.stage === 'waiting') return `Тест ${event.quizId}: ожидание до ${time(new Date(event.readyAt).toISOString())} · минимум ${duration(event.minimumSeconds)}${event.timingSource === 'first_seen' ? ' · с первого обнаружения' : ''}`;
  return [stages[event.stage] || (event.kind === 'start' ? 'Запуск принят' : event.stage || 'Событие'), event.quizId ? `тест ${event.quizId}` : '', event.tests ? `${event.tests} тестов` : '', event.round ? `попытка ${event.round}` : '', event.provider, effortLabel[event.reasoning] || event.reasoning, event.questions ? `${event.questions} вопросов` : '', event.total ? `${event.total} всего вопросов` : ''].filter(Boolean).join(' · ');
}
let jobsSignature = '';
const reviewReasons = { multiple_completeness: 'Проверяю полноту набора вариантов', source_unavailable: 'Источник не удалось прочитать', evidence_not_supportive: 'Цитата не доказывает выбранный ответ', model_uncertain: 'Модель не уверена в ответе', source_quote_not_found: 'Цитата не найдена в веб-источнике', context_quote_not_found: 'Цитата не найдена в материале', source_not_observed: 'Источник не подтверждён веб-поиском', evidence_incomplete: 'Доказательства покрывают не весь ответ', excluded_answer: 'Этот ответ уже был признан неправильным', conflict: 'Противоречие в памяти ответов', unsupported: 'Тип вопроса пока не поддерживается', unresolved: 'Нет проверенного ответа' };
function sourceSummary(attempt) {
  const sources = attempt?.sources || [];
  return [['memory', 'Память'], ['jev', 'Jev'], ['gpt_web', 'GPT Web']].map(([provider, label]) => sources.some(s => s.provider === provider) ? `${label}: ${sources.filter(s => s.provider === provider).length}` : '').filter(Boolean).join(' · ');
}
function reportFor(job) {
  if (!job) return '';
  const lines = ['Moodle Batch — отчёт запуска', `Запуск: ${job.requestId}`, `Начало: ${time(job.createdAt)}`, `Статус: ${jobLabel(job)}`, `Тесты: ${job.quizIds.join(', ')}`, `Попыток на тест: ${job.maxAttempts}`, '', 'РЕЗУЛЬТАТЫ'];
  lines.splice(lines.length - 2, 0, `Минимальное время на вопрос: ${job.secondsPerQuestion ?? 0} сек.`);
  if (job.error) lines.push(`Ошибка запуска: ${job.error} — ${errors[job.error] || job.error}`);
  for (const result of job.results) {
    const last = result.attempts.at(-1);
    lines.push(`Тест ${result.quizId} | ${result.status} | попыток: ${result.attempts.length} | оценка: ${last?.percent ?? 'нет'}${Number.isFinite(last?.percent) ? '%' : ''}${result.error ? ` | ${result.error}: ${errors[result.error] || result.error}` : ''}`);
    for (const question of result.unresolvedQuestions || []) lines.push(`  ${reviewDetail(question)}; ${question.provider || 'без ответа'} [${question.reason}]`);
    for (const [i, attempt] of result.attempts.entries()) {
      lines.push(`  Попытка ${i + 1}: ${attempt.percent ?? 'не раскрыта'}${Number.isFinite(attempt.percent) ? '%' : ''}; вопросов: ${attempt.total ?? 'нет данных'}; правильных: ${attempt.correct ?? 'нет данных'}`);
      if (Number.isFinite(attempt.gradePercent)) lines.push(`  Итоговая оценка в журнале Moodle: ${attempt.gradePercent}%`);
      if (attempt.timing) lines.push(`  Время до отправки: ${duration(attempt.timing.elapsedSeconds)}; минимум: ${duration(attempt.timing.minimumSeconds)}; начало отсчёта: ${time(new Date(attempt.timing.startedAt).toISOString())}${attempt.timing.source === 'first_seen' ? ' (первое обнаружение)' : ''}`);
      for (const source of attempt.sources || []) {
        lines.push(`    Вопрос ${source.slot}: ${source.provider || 'провайдер не указан'}; ${source.cached ? 'сохранённый ответ; ' : ''}${source.reasoning ? `${source.reasoning}; ` : ''}Moodle: ${feedbackLabel(source.feedback)}`);
        for (const detail of answerDetails(source)) lines.push(`      ${detail}`);
        for (const option of source.options || []) lines.push(`      ${option.text}: ${feedbackLabel(option.feedback)}`);
      }
    }
  }
  lines.push('', 'ЭТАПЫ (по времени)');
  for (const event of job.events || []) lines.push(`${event.at} | ${eventText(event)}${event.error ? ` [${event.error}]` : ''}`);
  if (!job.events?.length) lines.push('Подробные этапы этого старого запуска не записывались.');
  return lines.join('\n');
}
function chosenJob() { return current?.jobs.find(job => job.requestId === $('log-job').value); }
function showJobs(force = false) {
  showProgress(); $('log-count').textContent = current?.jobs.length || 0;
  const previous = $('log-job').value;
  const jobs = [...(current?.jobs || [])].reverse();
  const optionsSignature = jobs.map(job => `${job.requestId}:${job.status}:${job.results.filter(q => q.error).length}`).join('|');
  if ($('log-job').dataset.signature !== optionsSignature) {
    $('log-job').replaceChildren(...jobs.map(job => new Option(`${time(job.createdAt)} · ${job.quizIds.length} тестов · ${jobLabel(job)}`, job.requestId)));
    if (jobs.some(job => job.requestId === previous)) $('log-job').value = previous;
    $('log-job').dataset.signature = optionsSignature;
  }
  const job = chosenJob(); $('copy-report').disabled = !job;
  const signature = JSON.stringify([job, $('errors-only').checked]);
  if (!force && signature === jobsSignature) return; jobsSignature = signature;
  $('log-export').value = reportFor(job);
  $('jobs').replaceChildren();
  if (!job) { $('jobs').append(node('div', 'Пока нет запусков. Выберите тесты и начните решение.', 'empty')); return; }
  if ($('errors-only').checked && !job.error && !job.results.some(q => q.error)) { $('jobs').append(node('div', 'Запусков с ошибками нет.', 'empty')); return; }
  const box = node('article', undefined, 'job');
  const heading = node('div', undefined, 'job-heading'); heading.append(node('strong', jobLabel(job)), node('span', `${job.results.filter(q => q.error).length} ошибок · ${job.results.filter(q => q.attempts.at(-1)?.percent === 100).length} на 100%`, 'badge'));
  box.append(heading, node('p', `ID: ${job.requestId}`, 'job-time'));
  if (job.error) box.append(node('p', errors[job.error] || job.error, 'job-error'));
  const table = node('table', undefined, 'job-results'); table.setAttribute('aria-label', 'Результаты выбранного запуска');
  const head = node('thead'); const header = node('tr'); ['Тест', 'Состояние', 'Оценка', 'Подробности'].forEach(text => { const th = node('th', text); th.scope = 'col'; header.append(th); }); head.append(header); table.append(head);
  const body = node('tbody');
  for (const result of job.results) {
    if ($('errors-only').checked && !result.error) continue;
    const last = result.attempts.at(-1); const row = node('tr');
    const test = node('td'); const link = node('a', result.quizId); link.href = `${current.origin}/mod/quiz/view.php?id=${encodeURIComponent(result.quizId)}`; link.target = '_blank'; link.rel = 'noopener'; test.append(link);
    const status = result.error ? 'Остановлен' : last?.percent === 100 ? '100%' : result.status === 'running' ? 'В работе' : result.status === 'stopped' ? 'Остановлен' : 'Нужна проверка';
    const description = node('td', result.error ? errors[result.error] || result.error : `Завершено попыток: ${result.attempts.length}`);
    for (const question of result.unresolvedQuestions || []) description.append(node('small', reviewDetail(question), 'quiz-meta'));
    if (sourceSummary(last)) description.append(node('small', sourceSummary(last), 'quiz-meta'));
    if (Number.isFinite(last?.gradePercent)) description.append(node('small', `В журнале Moodle: ${last.gradePercent}%`, 'quiz-meta'));
    if (last?.sources?.length) {
      const review = node('details'); review.append(node('summary', 'Проверка каждого вопроса Moodle'));
      const list = node('ul');
      for (const source of last.sources) {
        const item = node('li', undefined, source.feedback === 'correct' ? 'good' : ['incorrect', 'partiallycorrect'].includes(source.feedback) ? 'job-error' : '');
        item.append(node('span', `Вопрос ${source.slot}: ${feedbackLabel(source.feedback)} · ${source.provider || 'провайдер не указан'}`));
        for (const detail of answerDetails(source)) item.append(node('small', detail, 'quiz-meta'));
        if (source.options?.length) {
          const options = node('ul');
          for (const option of source.options) options.append(node('li', `${option.text}: ${feedbackLabel(option.feedback)}`, option.feedback === 'correct' ? 'good' : option.feedback === 'incorrect' ? 'job-error' : 'muted'));
          item.append(options);
        }
        list.append(item);
      }
      review.append(list); description.append(review);
    }
    if (result.error) description.append(node('code', result.error, 'error-code'));
    if (last?.reviewUrl) { try { const url = new URL(last.reviewUrl); if (url.origin === current.origin && url.pathname === '/mod/quiz/review.php') { const review = node('a', ' Результат Moodle ↗'); review.href = url.href; review.target = '_blank'; review.rel = 'noopener'; description.append(review); } } catch { /* malformed link */ } }
    row.append(test, node('td', status, result.error ? 'job-error' : last?.percent === 100 ? 'good' : ''), node('td', Number.isFinite(last?.percent) ? `${last.percent}%` : '—'), description); body.append(row);
  }
  table.append(body); box.append(table, node('h3', 'Хронология запуска', 'events-heading'));
  const list = node('ol', undefined, 'events');
  for (const event of job.events || []) {
    if ($('errors-only').checked && !event.error) continue;
    const row = node('li', undefined, event.error ? 'error' : ''); const stamp = node('time', new Date(event.at).toLocaleTimeString('ru-RU')); stamp.dateTime = event.at;
    const content = node('div'); content.append(node('span', event.error ? `Тест ${event.quizId || '—'} · остановлен` : eventText(event), 'event-title'));
    if (event.error) content.append(node('span', errors[event.error] || event.error, 'event-info'), node('code', event.error, 'error-code'));
    row.append(stamp, content); list.append(row);
  }
  box.append(list);
  if (!job.events?.length) box.append(node('p', 'Для старого запуска сохранены результаты. Подробные этапы записываются с новой версии.', 'muted'));
  $('jobs').append(box);
}
$('log-job').addEventListener('change', () => { $('copy-status').textContent = ''; showJobs(true); });
$('copy-report').addEventListener('click', async () => {
  const report = reportFor(chosenJob()); if (!report) return;
  $('log-export').value = report;
  try { await navigator.clipboard.writeText(report); $('copy-status').textContent = 'Отчёт скопирован. Вставьте его в сообщение.'; }
  catch { $('report-text').open = true; $('log-export').focus(); $('log-export').select(); $('copy-status').textContent = 'Браузер не разрешил копирование. Текст выделен — нажмите Ctrl+C.'; }
});

let overviewSignature = '';
function render(overview, cached = false, force = false) {
  if (!overview || overview.userScope !== userScope || overview.origin !== 'https://sdo.sibupk.su') throw new Error('USER_SCOPE_MISMATCH');
  const all = overview.courses.flatMap(course => course.quizzes);
  $('metric-total').textContent = all.length; $('nav-count').textContent = all.length;
  $('issues-count').textContent = all.filter(q => problemDetails(q).length).length;
  $('metric-courses').textContent = `Курсов: ${overview.courses.length}`;
  $('metric-max').textContent = all.filter(q => q.percent === 100).length;
  $('metric-low').textContent = all.filter(belowMaximum).length;
  $('metric-new').textContent = all.filter(q => !Number.isFinite(q.percent)).length;
  $('active-filter').textContent = `Активные попытки: ${all.filter(q => q.activeAttempt).length}`;
  $('analysis-summary').textContent = `С подробным анализом: ${all.filter(q => q.analysis).length}/${all.length} · требуют проверки: ${all.filter(q => q.error || q.reviewError || q.analysis?.conflict).length}`;
  const progress = overview.progress;
  const scanningCourses = overview.phase === 'courses' || overview.detailed === false;
  $('scan-progress').max = (scanningCourses ? progress.totalCourses : progress.totalTests) || 1;
  $('scan-progress').value = (scanningCourses ? progress.courses : progress.tests) || 0;
  $('scan-detail').textContent = overview.detailed === false ? `Оценки: ${progress.courses} из ${progress.totalCourses} курсов · состояния попыток из последнего подробного анализа` : scanningCourses ? `Курсы: ${progress.courses} из ${progress.totalCourses}` : `Проверено тестов: ${progress.tests} из ${progress.totalTests}`;
  $('scan-badge').textContent = cached ? 'Сохранено' : current?.error ? 'Остановлен' : current?.running ? 'Обновляется' : 'Готово';
  $('scan-badge').classList.toggle('active', Boolean(current?.running));
  $('updated').textContent = overview.completedAt ? `Обновлено: ${time(overview.completedAt)}${Number.isFinite(overview.elapsedMs) ? ` · анализ занял ${Math.round(overview.elapsedMs / 1000)} с` : ''}` : 'Оценки появляются по мере проверки.';
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
      const a = node('a', undefined, 'quiz-link');
      a.append(node('div', q.topic ? `${q.topic} — ${q.title}` : q.title));
      const usage = q.attemptUsage;
      const attempts = usage ? `Использовано: ${usage.used ?? 'неизвестно'} · лимит: ${usage.unlimited ? 'без ограничений' : usage.allowed ?? 'неизвестен'} · осталось новых: ${usage.unlimited ? 'без ограничений' : usage.remaining ?? 'неизвестно'}`
        : Number.isInteger(q.attempts) ? `Попыток в истории: ${q.attempts} · лимит неизвестен` : 'Лимит попыток ещё не проверен';
      const info = [q.activeAttempt ? 'Активная попытка · продолжение при запуске' : q.preflightRequired ? 'Нужно подтвердить начало в Moodle' : '', attempts];
      if (q.analysis) info.push(`В памяти: ${q.analysis.known}/${q.analysis.total} (по прошлой попытке)`, `Нерешённых: ${q.analysis.unresolved}`, q.analysis.withExclusions ? `С исключёнными ответами: ${q.analysis.withExclusions}` : '', q.analysis.conflict ? `Конфликтов: ${q.analysis.conflict}` : '', q.analysis.unsupported ? `Не поддерживается: ${q.analysis.unsupported}` : '');
      if (q.detailCheckedAt) info.push(`Попытки проверены: ${time(q.detailCheckedAt)}`);
      else if (q.analysis || q.activeAttempt || q.attempts) info.push('Состояние попыток — из сохранённого подробного анализа');
      if (q.error || q.reviewError) info.push('Анализ требует проверки');
      if (info.some(Boolean)) a.append(node('small', info.filter(Boolean).join(' · '), q.activeAttempt ? 'quiz-meta resume' : 'quiz-meta')); a.href = `${overview.origin}/mod/quiz/view.php?id=${encodeURIComponent(q.quizId)}`; a.target = '_blank'; a.rel = 'noopener';
      if (issuesOnly) a.append(node('small', problemDetails(q).join('\n'), 'quiz-problem'));
      const score = node('span', !Number.isFinite(q.percent) ? 'Без оценки' : `${q.percent}%`, `score ${belowMaximum(q) ? 'low' : q.percent === 100 ? 'good' : ''}`);
      if (q.error || q.reviewError) score.title = errors[q.error || q.reviewError] || q.error || q.reviewError;
      const action = node('button', q.activeAttempt ? 'Завершить попытку' : Number.isFinite(q.percent) || q.attempts ? 'Перерешать' : 'Решить', 'secondary quiz-action');
      action.dataset.exhausted = String(!q.activeAttempt && q.attemptUsage?.remaining === 0);
      if (action.dataset.exhausted === 'true') { action.textContent = 'Попытки исчерпаны'; action.title = 'По последней проверке новых попыток нет. Обновите лимиты, если условия теста изменились.'; }
      else action.title = 'Решить и отправить только этот тест, одна попытка';
      action.setAttribute('aria-label', `${action.textContent}: ${q.title}`);
      action.addEventListener('click', () => startRun([q.quizId], 1));
      const actions = node('div', undefined, 'quiz-actions'); actions.append(score, action);
      row.append(check, a, actions); details.append(row);
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
function navigate(logs, issues = false) {
  issuesOnly = issues;
  $('tests-view').hidden = logs; $('logs-view').hidden = !logs;
  for (const [id, active] of [['nav-tests', !logs && !issues], ['nav-logs', logs], ['nav-issues', issues]]) {
    $(id).classList.toggle('active', active); $(id).removeAttribute('aria-current'); if (active) $(id).setAttribute('aria-current', 'page');
  }
  history.replaceState(null, '', logs ? '#logs' : issues ? '#issues' : '#tests');
  $('page-title').textContent = logs ? 'Журнал запусков' : issues ? 'Требуют внимания' : 'Ваши тесты';
  document.querySelector('.subtitle').textContent = logs ? 'История решений, причины остановки и отчёт для передачи.' : issues ? 'Ошибки и конфликты. Проверьте причины и завершите начатые попытки.' : 'Выберите тесты. Следите за решением и результатами в одном месте.';
  if (current?.overview) render(current.overview, false, true);
}
$('active-filter').addEventListener('click', () => { navigate(false); $('search').value = ''; $('course-filter').value = ''; $('grade-filter').value = 'active'; $('low').checked = false; if (current?.overview) render(current.overview, false, true); $('grade-filter').focus(); });
$('nav-tests').addEventListener('click', () => navigate(false)); $('nav-logs').addEventListener('click', () => navigate(true)); $('open-logs').addEventListener('click', () => { navigate(true); $('nav-logs').focus(); });
$('nav-issues').addEventListener('click', () => { $('search').value = ''; $('course-filter').value = ''; $('grade-filter').value = 'all'; $('low').checked = false; navigate(false, true); });
$('errors-only').addEventListener('change', () => showJobs(true));
for (const id of ['search', 'course-filter', 'grade-filter']) $(id).addEventListener(id === 'search' ? 'input' : 'change', () => { if (id === 'grade-filter') $('low').checked = $('grade-filter').value === 'low'; if (current?.overview) render(current.overview, false, true); });
$('reset-filters').addEventListener('click', () => { $('search').value = ''; $('course-filter').value = ''; $('grade-filter').value = 'all'; $('low').checked = false; if (current?.overview) render(current.overview, false, true); });

async function load() {
  if (pending) return;
  pending = true; clearTimeout(timer);
  try {
    current = await api('state');
    connected = true; $('connection').textContent = 'Сервис подключён'; $('connection-dot').classList.add('online');
    if (current.userScope !== userScope) {
      userScope = current.userScope; selected.clear(); pendingIntent = null; initial = true;
      for (const id of ['metric-total', 'metric-max', 'metric-low', 'metric-new', 'nav-count', 'issues-count', 'metric-courses']) $(id).textContent = '—';
      $('course-filter').replaceChildren(new Option('Все курсы', ''));
      overviewSignature = ''; jobsSignature = ''; $('courses').replaceChildren();
      const saved = await chrome.storage.local.get([timingKey(), intentKey()]);
      $('seconds-per-question').value = String(saved[timingKey()] ?? 10);
      pendingIntent = await restoreIntent() || null;
      if (pendingIntent) { pendingIntent.quizIds.forEach(id => selected.add(id)); $('rounds').value = String(pendingIntent.maxAttempts); }
    }
    if (initial) {
      initial = false;
      if (!current.authRequired && !current.running && (!current.overview || Date.now() - Date.parse(current.overview.completedAt || '') > 300000)) await api('refresh');
    }
    if (current.overview) {
      render(current.overview);
      if (current.overview.phase === 'complete') await chrome.storage.local.set({ [cacheKey()]: current.overview });
    }
    showJobs(); buttons();
    if (!current.authRequired && !current.error) notice('');
    if (current.authRequired) notice(errors.LOGIN_REQUIRED, true);
    if (current.error) notice(`Анализ остановлен: ${errors[current.error] || current.error}. Нажмите «Обновить анализ».`, true);
    const intent = await restoreIntent();
    if (intent?.userScope === userScope && current.jobs.some(job => job.requestId === intent.requestId)) {
      await chrome.storage.local.remove(intentKey()); pendingIntent = null; buttons();
    }
  } catch (error) { connected = false; notice(errors[error.message] || error.message, true); $('connection').textContent = 'Нет подключения'; $('connection-dot').classList.remove('online'); $('run').disabled = true; }
  finally { pending = false; $('refresh').disabled = Boolean(current?.running); $('analyze').disabled = $('refresh').disabled; $('check-attempts').disabled = $('refresh').disabled; timer = setTimeout(load, busy() || current?.running ? 2000 : 10000); }
}
$('low').addEventListener('change', () => { $('grade-filter').value = $('low').checked ? 'low' : 'all'; if (current?.overview) render(current.overview, false, true); });
$('select').addEventListener('click', () => {
  for (const q of visibleQuizzes()) selected.add(q.quizId);
  if (current?.overview) render(current.overview, false, true);
});
$('clear').addEventListener('click', () => { selected.clear(); if (current?.overview) render(current.overview, false, true); });
$('analyze').addEventListener('click', async () => { try { await api('refresh', { detailed: true }); await load(); } catch (error) { notice(errors[error.message] || error.message, true); } });
$('check-attempts').addEventListener('click', async () => { try { await api('refresh', { attemptsOnly: true }); await load(); } catch (error) { notice(errors[error.message] || error.message, true); } });
$('refresh').addEventListener('click', async () => { try { await api('refresh'); await load(); } catch (error) { notice(errors[error.message] || error.message, true); } });
$('stop').addEventListener('click', async () => { try { await api('stop', { requestId: busy().requestId }); await load(); } catch (error) { notice(errors[error.message] || error.message, true); } });
async function startRun(quizIds, maxAttempts) {
  if (submitting || busy() || !connected || current?.authRequired || !quizIds.length) return;
  if (!pendingIntent && !$('seconds-per-question').reportValidity()) return;
  submitting = true; buttons();
  try {
    // Preserve the exact intent across a lost HTTP reply; retries use the same requestId.
    let intent = await restoreIntent();
    if (intent && intent.userScope !== userScope) throw new Error('USER_SCOPE_MISMATCH');
    intent ||= { requestId: crypto.randomUUID(), userScope, quizIds, maxAttempts, secondsPerQuestion: Number($('seconds-per-question').value) };
    pendingIntent = intent;
    await chrome.storage.local.set({ [intentKey()]: intent });
    await api('jobs', intent); await chrome.storage.local.remove(intentKey()); pendingIntent = null; await load();
  } catch (error) {
    if (error.rejected) { await chrome.storage.local.remove(intentKey()); pendingIntent = null; }
    notice(errors[error.message] || error.message, true);
  }
  finally { submitting = false; buttons(); }
}
$('run').addEventListener('click', () => startRun([...selected], Number($('rounds').value)));
$('seconds-per-question').addEventListener('change', async () => {
  if ($('seconds-per-question').checkValidity()) await chrome.storage.local.set({ [timingKey()]: Number($('seconds-per-question').value) });
});
(async () => {
  const seconds = (await chrome.storage.local.get(timingKey()))[timingKey()];
  if (Number.isInteger(seconds) && seconds >= 0 && seconds <= 600) $('seconds-per-question').value = String(seconds);
  const intent = await restoreIntent();
  if (intent?.userScope === userScope) {
    pendingIntent = intent; selected.clear(); intent.quizIds.forEach(id => selected.add(id)); $('rounds').value = String(intent.maxAttempts);
    $('seconds-per-question').value = String(intent.secondsPerQuestion ?? 0);
  }
  const cached = (await chrome.storage.local.get(cacheKey()))[cacheKey()];
  if (cached) { try { render(cached, true); } catch { /* another account cache */ } }
  navigate(location.hash === '#logs', location.hash === '#issues');
  buttons();
  load();
})();
