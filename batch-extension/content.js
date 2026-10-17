(async () => {
  if (window.top !== window.self || document.getElementById('moodle-batch-open')) return;
  const quizId = location.pathname.includes('/mod/quiz/')
    ? new URL(location.href).searchParams.get('cmid') || new URL(location.href).searchParams.get('id')
      || [...document.body.classList].find(c => /^cmid-\d+$/u.test(c))?.slice(5) : '';
  const button = document.createElement('button'); button.id = 'moodle-batch-open'; button.type = 'button';
  button.textContent = quizId ? 'Moodle Batch — решить тест' : 'Moodle Batch — анализ и решение тестов';
  button.style.cssText = 'padding:10px 16px;margin:10px 0;border:0;border-radius:8px;background:#2563eb;color:white;cursor:pointer';
  (document.querySelector('#region-main') || document.body).prepend(button);
  button.addEventListener('click', async () => {
    const result = await chrome.runtime.sendMessage({ type: 'open', quizId });
    if (result?.error) button.textContent = 'Не удалось открыть Moodle Batch';
  });
})();
