(async () => {
  if (window.top !== window.self || document.getElementById('moodle-batch-open')) return;
  const quizId = location.pathname.includes('/mod/quiz/')
    ? new URL(location.href).searchParams.get('cmid') || new URL(location.href).searchParams.get('id')
      || [...document.body.classList].find(c => /^cmid-\d+$/u.test(c))?.slice(5) : '';
  const button = document.createElement('button'); button.id = 'moodle-batch-open'; button.type = 'button';
  button.textContent = quizId ? 'Moodle Batch — решить тест' : 'Moodle Batch — анализ и решение тестов';
  const label = button.textContent;
  button.style.cssText = 'padding:10px 16px;margin:10px 0;border:0;border-radius:8px;background:#2563eb;color:white;cursor:pointer';
  (document.querySelector('#region-main') || document.body).prepend(button);
  let opening = false;
  button.addEventListener('click', async () => {
    if (opening) return;
    opening = true; button.disabled = true; button.textContent = 'Открываю Moodle Batch…';
    try {
      const result = await chrome.runtime.sendMessage({ type: 'open', quizId });
      button.textContent = result?.error ? 'Не удалось открыть Moodle Batch' : 'Moodle Batch открыт в новой вкладке';
    } catch { button.textContent = 'Расширение обновлено — перезагрузите вкладку Moodle (F5)'; }
    setTimeout(() => { opening = false; button.disabled = false; button.textContent = label; }, 2000);
  });
})();
