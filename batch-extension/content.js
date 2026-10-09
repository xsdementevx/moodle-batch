(() => {
  if (window.top !== window.self || document.getElementById('moodle-batch-open')) return;
  const ids = new Set([...document.querySelectorAll('.usermenu a[href*="/user/profile.php"],table a[href*="/course/user.php"]')]
    .map(a => { const u = new URL(a.href); return u.origin === location.origin ? u.searchParams.get('user') || u.searchParams.get('id') : null; }).filter(Boolean));
  if (document.body.dataset.userScope) ids.add(document.body.dataset.userScope);
  if (ids.size !== 1) return;
  const userScope = [...ids][0];
  const quizId = location.pathname.includes('/mod/quiz/')
    ? new URL(location.href).searchParams.get('cmid') || new URL(location.href).searchParams.get('id')
      || [...document.body.classList].find(c => /^cmid-\d+$/u.test(c))?.slice(5) : '';
  const button = document.createElement('button'); button.id = 'moodle-batch-open'; button.type = 'button';
  button.textContent = quizId ? 'Moodle Batch — решить тест' : 'Moodle Batch — анализ и решение тестов';
  button.style.cssText = 'padding:10px 16px;margin:10px 0;border:0;border-radius:8px;background:#2563eb;color:white;cursor:pointer';
  (document.querySelector('#region-main') || document.body).prepend(button);
  button.addEventListener('click', async () => {
    const result = await chrome.runtime.sendMessage({ type: 'open', userScope, quizId });
    if (result?.error) button.textContent = 'Аккаунт Moodle отличается от аккаунта сервиса';
  });
})();
