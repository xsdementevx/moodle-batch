import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runQuizzes } from './run.js';
import { safeCode, scanOverview, courseSummary, gradeStatus } from './overview.js';

const terminal = status => ['complete', 'stopped', 'interrupted'].includes(status);
const atomicWrite = async (path, value) => {
  await writeFile(`${path}.tmp`, JSON.stringify(value), { mode: 0o600 });
  await rename(`${path}.tmp`, path);
};

export async function openService({ moodle, store, web, root, runner, batchRunner = runQuizzes, scan = scanOverview }) {
  await mkdir(root, { recursive: true });
  const report = join(root, 'overview.json');
  const jobsPath = join(root, 'jobs.json');
  let overview = null, scanTask = null, scanError = null, active = null;
  let jobs = [];
  const event = (job, kind, detail = {}) => {
    const item = { at: new Date().toISOString(), kind };
    // Keep only display-safe metadata; never persist prompts, answers or credentials here.
    for (const key of ['stage', 'quizId', 'round', 'provider', 'reasoning', 'questions', 'percent', 'error']) {
      if (detail[key] !== undefined) item[key] = detail[key];
    }
    job.events ||= [];
    job.events.push(item);
    // ponytail: latest 300 events per job; result history remains complete.
    if (job.events.length > 300) job.events.shift();
  };
  try {
    const saved = JSON.parse(await readFile(report, 'utf8'));
    if (saved.schemaVersion === 1 && saved.origin === moodle.origin && saved.userScope === moodle.userScope) overview = saved;
  } catch (error) { if (error.code !== 'ENOENT') throw new Error('OVERVIEW_CACHE_INVALID'); }
  try {
    const saved = JSON.parse(await readFile(jobsPath, 'utf8'));
    if (saved.origin === moodle.origin && saved.userScope === moodle.userScope) jobs = saved.jobs;
    if (!Array.isArray(jobs)) throw new Error();
  } catch (error) { if (error.code !== 'ENOENT') throw new Error('JOBS_CACHE_INVALID'); }
  for (const job of jobs) if (!terminal(job.status)) { job.status = 'interrupted'; job.error = 'SERVICE_RESTARTED'; event(job, 'error', { error: job.error }); }
  // ponytail: one solver queue per account; keep GPT conversations and submission ordering simple.
  let writes = Promise.resolve();
  const save = () => {
    const value = structuredClone({ origin: moodle.origin, userScope: moodle.userScope, jobs });
    writes = writes.then(() => atomicWrite(jobsPath, value));
    return writes;
  };
  let reportWrites = Promise.resolve();
  const saveReport = () => {
    const snapshot = structuredClone(overview);
    reportWrites = reportWrites.then(() => atomicWrite(report, snapshot));
    return reportWrites;
  };
  await save();
  const updateGrade = result => {
    const course = overview?.courses.find(item => item.courseId === result.courseId);
    const quiz = course?.quizzes.find(item => item.quizId === result.quizId);
    if (!quiz || !Number.isFinite(result.gradePercent)) return;
    quiz.percent = result.gradePercent; quiz.status = gradeStatus(quiz.percent);
    quiz.activeAttempt = false; quiz.updatedAt = new Date().toISOString();
    course.summary = courseSummary(course.quizzes);
    overview.summary = courseSummary(overview.courses.flatMap(item => item.quizzes));
  };
  const recentGrades = new Map();
  const refresh = () => {
    if (scanTask) return scanTask;
    const previous = overview;
    scanError = null;
    scanTask = Promise.resolve().then(() => moodle.connect?.()).then(() => scan(moodle, store, { onProgress: next => {
      overview = { ...next, courses: next.courses.map(course => course.status === 'loading'
        ? previous?.courses.find(old => old.courseId === course.courseId) || course : course) };
      for (const result of recentGrades.values()) updateGrade(result);
    } })).then(async result => {
      overview = result;
      for (const grade of recentGrades.values()) updateGrade(grade);
      recentGrades.clear();
      await saveReport();
    })
      .catch(error => { scanError = safeCode(error); if (scanError === 'LOGIN_REQUIRED') moodle.authRequired = true; }).finally(() => { scanTask = null; });
    return scanTask;
  };
  const run = async job => {
    try {
      job.status = 'running'; await save();
      job.results = job.quizIds.map(quizId => ({ quizId, attempts: [], status: 'running' }));
      for (let n = 0; n < job.maxAttempts && !job.stopRequested; n++) {
        const pending = job.results.filter(q => !q.error && q.status === 'running');
        if (!pending.length) break;
        const options = { root, web, stopped: () => job.stopRequested,
          progress: async (stage, detail = {}) => { job.current = { round: n + 1, stage, ...detail }; event(job, 'stage', job.current); await save(); },
          onResult: async result => {
            const quiz = job.results.find(q => q.quizId === result.quizId);
            quiz.attempts.push(result);
            quiz.status = result.percent === 100 ? 'maximum' : result.percent === null ? 'review' : 'running';
            event(job, 'result', { quizId: result.quizId, round: n + 1, percent: result.percent ?? null });
            await save();
            recentGrades.set(result.quizId, result); updateGrade(result);
            if (overview && !scanTask) { await saveReport(); recentGrades.clear(); }
          } };
        const outcomes = runner ? await (async () => {
          const out = [];
          for (const quiz of pending) {
            if (job.stopRequested) break;
            try {
              const result = await runner(moodle, store, quiz.quizId, options);
              // Legacy injected runners may omit the test identifier.
              result.quizId ??= quiz.quizId;
              await options.onResult(result); out.push({ quizId: quiz.quizId, result });
            } catch (error) { out.push({ quizId: quiz.quizId, error }); }
          }
          return out;
        })() : await batchRunner(moodle, store, pending.map(q => q.quizId), options);
        for (const { quizId, error } of outcomes) if (error) {
          const quiz = job.results.find(q => q.quizId === quizId);
          quiz.error = safeCode(error); quiz.status = 'error';
          event(job, 'error', { quizId, round: n + 1, error: quiz.error });
          if (quiz.error === 'LOGIN_REQUIRED') moodle.authRequired = true;
        }
        await save();
      }
      for (const quiz of job.results) if (quiz.status === 'running') quiz.status = job.stopRequested ? 'stopped' : 'review';
      job.status = job.stopRequested ? 'stopped' : 'complete'; job.current = null;
      event(job, job.stopRequested ? 'stopped' : 'complete');
      job.finishedAt = new Date().toISOString(); await save();
    } catch (error) { job.status = 'interrupted'; job.error = safeCode(error); event(job, 'error', { error: job.error }); await save(); }
    finally { active = null; }
  };
  return {
    state() { return { origin: moodle.origin, userScope: moodle.userScope, authRequired: Boolean(moodle.authRequired), running: Boolean(scanTask),
      error: scanError, overview, jobs }; },
    refresh,
    async start(input) {
      if (!input || Object.keys(input).sort().join(',') !== 'maxAttempts,quizIds,requestId,userScope'
          || input.userScope !== moodle.userScope || !/^[\w-]{16,80}$/u.test(input.requestId || '')
          || ![1, 2, 3].includes(input.maxAttempts) || !Array.isArray(input.quizIds) || !input.quizIds.length
          || input.quizIds.length > 1000 || new Set(input.quizIds).size !== input.quizIds.length
          || input.quizIds.some(id => typeof id !== 'string' || !/^\d{1,12}$/u.test(id))) throw new Error('INVALID_JOB');
      const old = jobs.find(job => job.requestId === input.requestId);
      if (old) {
        if (JSON.stringify(old.quizIds) !== JSON.stringify(input.quizIds) || old.maxAttempts !== input.maxAttempts) throw new Error('REQUEST_ID_CONFLICT');
        await writes;
        return old;
      }
      if (moodle.authRequired) throw new Error('LOGIN_REQUIRED');
      if (active) throw new Error('JOB_ALREADY_RUNNING');
      const job = { ...input, status: 'queued', stopRequested: false, createdAt: new Date().toISOString(), results: [] };
      event(job, 'start');
      jobs.push(job); active = job;
      try { await save(); } catch (error) { active = null; jobs.pop(); throw error; }
      // Execution lives in Node, not the extension service worker's limited lifetime.
      const task = run(job).catch(error => { job.status = 'interrupted'; job.error = safeCode(error); });
      active = { job, task };
      return job;
    },
    async stop(requestId) {
      const job = jobs.find(item => item.requestId === requestId);
      if (!job) throw new Error('JOB_NOT_FOUND');
      if (!terminal(job.status) && !job.stopRequested) { job.stopRequested = true; event(job, 'stop'); await save(); }
      return job;
    },
    async close() {
      if (active?.job) await this.stop(active.job.requestId);
      await active?.task; await scanTask; await writes; await reportWrites;
    },
  };
}

export function serviceServer(service, token, port) {
  return createServer(async (req, res) => {
    const reply = (status, value) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify(value));
    };
    try {
      if (req.headers.host !== `127.0.0.1:${port}` || (req.headers.origin && !/^chrome-extension:\/\/[a-p]{32}$/u.test(req.headers.origin))) return reply(403, { error: 'ORIGIN_MISMATCH' });
      const auth = Buffer.from(req.headers.authorization || '');
      const expected = Buffer.from(`Bearer ${token}`);
      if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) return reply(403, { error: 'PAIRING_REQUIRED' });
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      if (req.method === 'GET' && url.pathname === '/state') {
        const current = service.state();
        if (url.searchParams.get('user') !== current.userScope) return reply(403, { error: 'USER_SCOPE_MISMATCH' });
        return reply(200, service.state());
      }
      if (req.method !== 'POST') return reply(405, { error: 'POST_REQUIRED' });
      if (!['/jobs', '/stop', '/refresh'].includes(url.pathname)) return reply(404, { error: 'NOT_FOUND' });
      if (req.headers['content-type'] !== 'application/json') return reply(415, { error: 'JSON_REQUIRED' });
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (Buffer.byteLength(body) > 16384) return reply(413, { error: 'BODY_TOO_LARGE' });
      }
      let input; try { input = JSON.parse(body); } catch { return reply(400, { error: 'INVALID_JSON' }); }
      if (input.userScope !== service.state().userScope) return reply(403, { error: 'USER_SCOPE_MISMATCH' });
      if (url.pathname === '/jobs') return reply(202, await service.start(input));
      if (url.pathname === '/stop') return reply(200, await service.stop(input.requestId));
      service.refresh(); return reply(202, { running: true });
    } catch (error) { reply(409, { error: safeCode(error) }); }
  });
}
