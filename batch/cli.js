import { parseArgs } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { openAnswers } from './answers.js';
import { openMoodle } from './moodle.js';
import { loadContext } from './context.js';
import { solveTest } from './solve.js';
import { webSolver } from './web.js';
import { buildSubmission, submitTest, submissionId, startTest, startId, rememberAttemptStart } from './submit.js';

const { values } = parseArgs({ options: {
  quiz: { type: 'string', multiple: true },
  attempt: { type: 'string' },
  auth: { type: 'string', default: '.playwright-mcp/reference-auth/cookies.json' },
  origin: { type: 'string', default: 'https://sdo.sibupk.su' },
  db: { type: 'string', default: '.playwright-mcp/batch/answers.sqlite' },
  report: { type: 'string', default: '.playwright-mcp/batch/report.json' },
  help: { type: 'boolean' },
  context: { type: 'boolean' },
  solve: { type: 'boolean' },
  'prepare-submit': { type: 'boolean' },
  submit: { type: 'boolean' },
  'seconds-per-question': { type: 'string', default: '10' },
  start: { type: 'boolean' },
  'gpt-auth': { type: 'string', default: '.playwright-mcp/reference-auth/cookies_gpt.json' },
  'gpt-profile': { type: 'string', default: '.playwright-mcp/batch/gpt-profile' },
  'gpt-browser': { type: 'string' },
  'gpt-extension': { type: 'boolean' },
  'gpt-visible': { type: 'boolean' },
} });
if (values['prepare-submit'] || values.submit) values.solve = true;

if (values.help || !values.quiz?.length) {
  console.log('Использование: npm run batch -- --quiz ID [--quiz ID] [--attempt ID]\n'
    + 'Параметры: --auth cookies.json --origin https://moodle.example --db answers.sqlite --report report.json\n'
    + '--context: прочитать материалы; --solve: хранилище → Jev → GPT Web; --gpt-auth: cookies ChatGPT; --gpt-profile: профиль браузера\n'
    + '--gpt-extension: подключиться через установленное Playwright Extension; --gpt-browser: путь браузера\n'
    + '--prepare-submit: проверить итоговый запрос без отправки; --submit: завершить существующую активную попытку и импортировать результат\n'
    + '--start: начать новую попытку, если активной нет (можно сочетать с --solve и --submit)\n'
    + '--seconds-per-question: минимум секунд на вопрос с начала попытки (10 по умолчанию; 0 без ожидания)\n'
    + 'Читает существующие попытки и импортирует результаты. Если активной попытки нет, показывает последнюю завершённую.');
} else {
  let moodle;
  let store;
  let web;
  try {
    const secondsPerQuestion = Number(values['seconds-per-question']);
    if (!Number.isInteger(secondsPerQuestion) || secondsPerQuestion < 0 || secondsPerQuestion > 600) throw new Error('INVALID_MINIMUM_TIME');
    if (values.quiz.some(id => !/^\d+$/u.test(id)) || (values.attempt && (!/^\d+$/u.test(values.attempt) || values.quiz.length !== 1 || values.start))) throw new Error('INVALID_IDS');
    moodle = await openMoodle({ authFile: resolve(values.auth), origin: values.origin });
    store = openAnswers(resolve(values.db));
    web = webSolver({ authFile: resolve(values['gpt-auth']), profileDir: resolve(values['gpt-profile']),
      executablePath: values['gpt-browser'], visible: Boolean(values['gpt-visible']), extension: Boolean(values['gpt-extension']) });
    const tests = [];
    for (const quizId of [...new Set(values.quiz)]) {
      const view = await moodle.read(`/mod/quiz/view.php?id=${quizId}`);
      const reviews = [];
      for (const href of view.reviews) {
        const reviewUrl = new URL(href);
        reviewUrl.searchParams.set('showall', '1');
        const review = await moodle.collect(reviewUrl.href);
        if (review.kind !== 'review' || review.quizId !== quizId || review.courseId !== view.courseId || review.userScope !== view.userScope) throw new Error('PAGE_SCOPE_MISMATCH');
        store.importReview(review.questions);
        reviews.push(review);
      }
      let activeUrl = values.attempt ? `/mod/quiz/attempt.php?attempt=${values.attempt}&cmid=${quizId}` : view.activeUrl;
      if (values.start && !activeUrl) {
        const started = await startTest(moodle, view, join(resolve('.playwright-mcp/batch/operations'), `${startId(view)}.json`));
        activeUrl = started.attemptUrl;
      }
      const test = activeUrl ? await moodle.collect(activeUrl) : reviews.at(-1);
      if (!test) {
        if (values.submit || values['prepare-submit']) throw new Error('ACTIVE_COMPLETE_ATTEMPT_REQUIRED');
        tests.push({ quizId, mode: 'no_attempt', summary: { total: 0, known: 0, unresolved: 0, conflict: 0, unsupported: 0, questionsWithExclusions: 0 }, questions: [] });
        continue;
      }
      if (test.quizId !== quizId || test.userScope !== view.userScope || test.courseId !== view.courseId) throw new Error('PAGE_SCOPE_MISMATCH');
      if (values.submit && test.kind === 'attempt') await rememberAttemptStart(test,
        join(resolve('.playwright-mcp/batch/operations'), `${submissionId(test)}.json.timing`),
        join(resolve('.playwright-mcp/batch/operations'), `${startId(view)}.json`));
      let questions = test.questions.map(question => ({ ...question, memory: store.lookup(question) }));
      const context = values.context || values.solve ? await loadContext(moodle, view, resolve('.playwright-mcp/batch/materials')) : null;
      let solveError = null;
      let submission = null;
      if (values.solve) {
        try {
          questions = await solveTest(questions, context, {
            journalDir: resolve('.playwright-mcp/batch/operations'), web,
          });
        } catch (error) {
          solveError = /^[A-Z][A-Z_0-9]+$/u.test(error.message || '') ? error.message : 'MODEL_OR_LOCAL_ERROR';
          process.exitCode = 1;
          console.error(`Тест ${quizId}: ${solveError}`);
        }
      }
      if ((values['prepare-submit'] || values.submit) && !solveError) {
        try {
          const plan = buildSubmission(test, questions);
          submission = { state: 'prepared', questionCount: questions.length, url: plan.url };
          if (values.submit) {
            const result = await submitTest(moodle, test, questions,
              join(resolve('.playwright-mcp/batch/operations'), `${submissionId(test)}.json`), {
                secondsPerQuestion, progress: async (stage, detail) => {
                  if (stage === 'waiting') console.log(`Тест ${quizId}: жду минимальное время, до отправки ${Math.max(0, Math.ceil((detail.readyAt - Date.now()) / 1000))} сек.`);
                },
              });
            submission = { ...submission, state: 'submitted', reviewUrl: result.reviewUrl, timing: result.timing };
            const review = await moodle.collect(result.reviewUrl);
            if (review.kind !== 'review' || review.attemptId !== test.attemptId || review.quizId !== test.quizId
                || review.userScope !== test.userScope || review.courseId !== test.courseId) throw new Error('PAGE_SCOPE_MISMATCH');
            submission.imported = store.importReview(review.questions);
            submission.state = 'reviewed';
            submission.feedback = Object.fromEntries(['correct', 'incorrect', 'partiallycorrect', 'unconfirmed']
              .map(state => [state, review.questions.filter(q => q.feedback === state).length]));
          }
        } catch (error) {
          submission = { ...submission, error: /^[A-Z][A-Z_0-9]+$/u.test(error.message || '') ? error.message : 'SUBMISSION_OR_LOCAL_ERROR' };
          process.exitCode = 1;
          console.error(`Отправка теста ${quizId}: ${submission.error}`);
        }
      }
      const summary = { total: questions.length, known: 0, unresolved: 0, conflict: 0, unsupported: 0, questionsWithExclusions: 0 };
      for (const question of questions) {
        summary[question.memory.status]++;
        if (question.memory.excludedAnswers.length) summary.questionsWithExclusions++;
      }
      tests.push({ quizId, attemptId: test.attemptId, mode: test.kind === 'attempt' ? 'active_attempt' : 'completed_review', complete: test.complete,
        summary, context, solveError, submission, questions });
      const label = test.kind === 'attempt' ? 'активная попытка' : 'последняя завершённая попытка';
      console.log(`Тест ${quizId} (${label}): ${summary.total} вопросов, известно ${summary.known}, решить ${summary.unresolved}, конфликты ${summary.conflict}, неподдерживаемые ${summary.unsupported}, с исключениями ${summary.questionsWithExclusions}.`);
      if (context) console.log(`Контекст: ${context.status}, материалов ${context.materials.length}, символов ${context.text.length}.`);
      if (values.solve) console.log(`Ответы: ${questions.filter(q => q.decision?.answer !== null && q.decision?.answer !== undefined).length}/${questions.length}.`);
      if (submission?.state) console.log(`Отправка: ${submission.state}.`);
    }
    const reportPath = resolve(values.report);
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, JSON.stringify({ schemaVersion: 1, createdAt: new Date().toISOString(), tests }, null, 2), { mode: 0o600 });
    console.log(`Отчёт сохранён: ${reportPath}`);
  } catch (error) {
    // Never print Playwright request traces: they may contain cookie headers.
    const code = /^[A-Z][A-Z_0-9]+$/u.test(error.message || '') ? error.message : 'LOCAL_OR_NETWORK_ERROR';
    console.error(`Ошибка: ${code}`);
    process.exitCode = 1;
  } finally {
    await web?.close();
    store?.close();
    await moodle?.close();
  }
}
