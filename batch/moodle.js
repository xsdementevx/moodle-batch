import { readFile, writeFile, rename } from 'node:fs/promises';
import { chromium, request } from 'playwright';
import { digest, normalize, optionId } from './answers.js';
import { sourceText } from './evidence.js';

export function cookieState(raw, origin) {
  const host = new URL(origin).hostname;
  const cookies = Array.isArray(raw) ? raw : raw?.cookies;
  if (!Array.isArray(cookies)) throw new Error('INVALID_COOKIE_FILE');
  const sameSite = { no_restriction: 'None', lax: 'Lax', strict: 'Strict', unspecified: 'Lax' };
  const selected = cookies.filter(c => c.domain?.replace(/^\./u, '') === host
    || (c.domain?.startsWith('.') && host.endsWith(c.domain))).map(c => ({
    name: c.name, value: c.value, domain: c.domain, path: c.path || '/',
    expires: c.expires ?? c.expirationDate ?? -1,
    httpOnly: Boolean(c.httpOnly), secure: Boolean(c.secure),
    sameSite: sameSite[c.sameSite] || c.sameSite || 'Lax',
  }));
  if (!selected.length || selected.some(c => !c.name || typeof c.value !== 'string'
      || !Number.isFinite(c.expires) || !['None', 'Lax', 'Strict'].includes(c.sameSite))) throw new Error('INVALID_COOKIE_FILE');
  return { cookies: selected, origins: [] };
}

export async function openParser() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ javaScriptEnabled: false, serviceWorkers: 'block' });
  await context.route('**/*', route => route.abort());
  const page = await context.newPage();
  const parser = {
    sourceText(html) { return page.evaluate(sourceText, html); },
    async grades(html, origin, userScope, courseId = null) {
      const result = await page.evaluate(({ html, origin, userScope, courseId }) => {
        const document = new DOMParser().parseFromString(html, 'text/html');
        const norm = text => String(text || '').replace(/\s+/gu, ' ').trim();
        if (document.querySelector('#login,form[action*="/login/"]')) return { error: 'LOGIN_REQUIRED' };
        const links = [...document.querySelectorAll('table a[href]')].map(a => ({ a, url: new URL(a.getAttribute('href'), origin) }));
        if (!courseId) {
          if (document.body.id !== 'page-grade-report-overview-index') return { error: 'GRADE_SCOPE_UNAVAILABLE' };
          const courses = links.filter(({ url }) => url.origin === origin && url.pathname === '/course/user.php' && url.searchParams.get('mode') === 'grade');
          if (courses.some(({ url }) => url.searchParams.get('user') !== userScope)) return { error: 'PAGE_SCOPE_MISMATCH' };
          return { courses: courses.map(({ a, url }) => ({ courseId: url.searchParams.get('id'), title: norm(a.textContent) })) };
        }
        const actualCourse = document.body.dataset.courseId || [...document.body.classList].find(c => /^course-\d+$/u.test(c))?.slice(7);
        if (document.body.id !== 'page-grade-report-user-index' || actualCourse !== courseId) return { error: 'GRADE_SCOPE_UNAVAILABLE' };
        const reportUser = document.querySelector('#graded_users_selector')?.value;
        if (reportUser && reportUser !== userScope) return { error: 'PAGE_SCOPE_MISMATCH' };
        return { quizzes: links.filter(({ url }) => url.origin === origin && /^\/mod\/quiz\/(grade|view)\.php$/u.test(url.pathname))
          .map(({ a, url }) => {
            const row = a.closest('tr');
            const cell = row?.querySelector('.column-percentage,.percentage');
            const match = (cell ? norm(cell.textContent) : norm(row?.textContent)).match(/(\d+(?:[.,]\d+)?)\s*%/u);
            const percent = match ? Number(match[1].replace(',', '.')) : null;
            return { quizId: url.searchParams.get('id'), title: norm(a.textContent), percent: percent !== null && percent <= 100 ? percent : null };
          }) };
      }, { html, origin, userScope, courseId });
      if (result.error) throw new Error(result.error);
      const key = courseId ? 'quizzes' : 'courses';
      const id = courseId ? 'quizId' : 'courseId';
      result[key] = [...new Map(result[key].filter(item => /^\d+$/u.test(item[id] || '')).map(item => [item[id], item])).values()];
      return result[key];
    },
    async quizzes(html, origin, courseId) {
      const quizzes = await page.evaluate(({ html, origin, courseId }) => {
        const document = new DOMParser().parseFromString(html, 'text/html');
        const actualCourse = document.body.dataset.courseId || [...document.body.classList].find(c => /^course-\d+$/u.test(c))?.slice(7);
        if (actualCourse !== courseId || !document.body.id.startsWith('page-course-view-')) return null;
        return [...document.querySelectorAll('.activity a[href]')].map(a => ({ url: new URL(a.getAttribute('href'), origin), title: a.textContent.replace(/\s+/gu, ' ').trim(),
          topic: a.closest('.section')?.querySelector('.sectionname')?.textContent.replace(/\s+/gu, ' ').trim() || '' }))
          .filter(a => a.url.origin === origin && a.url.pathname === '/mod/quiz/view.php' && /^\d+$/u.test(a.url.searchParams.get('id') || ''))
          .map(a => ({ quizId: a.url.searchParams.get('id'), title: a.title, topic: a.topic }));
      }, { html, origin, courseId });
      if (!quizzes) throw new Error('COURSE_SCOPE_UNAVAILABLE');
      return [...new Map(quizzes.map(q => [q.quizId, q])).values()];
    },
    async materials(html, origin, courseId, quizId) {
      const result = await page.evaluate(({ html, origin, courseId, quizId }) => {
        const document = new DOMParser().parseFromString(html, 'text/html');
        const actualCourse = document.body.dataset.courseId || [...document.body.classList].find(c => /^course-\d+$/u.test(c))?.slice(7);
        const activities = [...document.querySelectorAll('.activity')];
        const target = activities.find(a => [...a.querySelectorAll('a[href]')].some(link => {
          const url = new URL(link.getAttribute('href'), origin);
          return url.pathname === '/mod/quiz/view.php' && url.searchParams.get('id') === quizId;
        }));
        if (!target || actualCourse !== courseId || document.body.id !== 'page-course-view-topics') return null;
        const section = target.closest('.section');
        const index = activities.indexOf(target);
        const resources = [];
        for (let i = index - 1; i >= 0; i--) {
          const activity = activities[i];
          if (activity.closest('.section') !== section) break;
          const link = [...activity.querySelectorAll('a[href]')].find(a => /\/mod\/(?:quiz|resource|page)\/view\.php/u.test(a.getAttribute('href')));
          if (!link) continue;
          const url = new URL(link.getAttribute('href'), origin);
          if (url.pathname === '/mod/quiz/view.php') break;
          if (url.origin === origin) resources.unshift({ url: url.href, title: link.textContent.replace(/\s+/gu, ' ').trim() });
        }
        return resources;
      }, { html, origin, courseId, quizId });
      if (!result) throw new Error('MATERIAL_SCOPE_UNAVAILABLE');
      if (result.length > 6) throw new Error('MATERIAL_LIMIT');
      return result;
    },
    async resourceFile(html, sourceUrl) {
      const result = await page.evaluate(({ html, sourceUrl }) => {
        const document = new DOMParser().parseFromString(html, 'text/html');
        if (document.querySelector('#login,form[action*="/login/"]')) return { error: 'LOGIN_REQUIRED' };
        const source = new URL(sourceUrl);
        const main = document.querySelector('#region-main');
        if (document.body.id !== 'page-mod-resource-view' || !main) return { error: 'MATERIAL_FILE_UNAVAILABLE' };
        const files = [...main.querySelectorAll('a[href],object[data],iframe[src],embed[src]')].map(node => {
          try { return new URL(node.getAttribute('href') || node.getAttribute('data') || node.getAttribute('src'), source); }
          catch { return null; }
        }).filter(url => url && url.origin === source.origin && !url.username && !url.password
          && /^\/pluginfile\.php\/\d+\/mod_resource\/content\/\d+\//u.test(url.pathname));
        const unique = [...new Set(files.map(url => url.href))];
        return unique.length === 1 ? { url: unique[0] } : { error: 'MATERIAL_FILE_UNAVAILABLE' };
      }, { html, sourceUrl });
      if (result.error) throw new Error(result.error);
      return result.url;
    },
    async materialText(html) {
      return page.evaluate(html => {
        const document = new DOMParser().parseFromString(html, 'text/html');
        if (document.querySelector('#login,form[action*="/login/"]')) throw new Error('LOGIN_REQUIRED');
        const node = document.querySelector('#page-content .generalbox,.modified,.page-content') || document.querySelector('#region-main');
        if (!node) return '';
        const clone = node.cloneNode(true);
        clone.querySelectorAll('script,style,nav,form,noscript').forEach(n => n.remove());
        clone.querySelectorAll('br').forEach(n => n.replaceWith('\n'));
        clone.querySelectorAll('p,div,li,h1,h2,h3,h4,h5,h6,tr,blockquote,section').forEach(n => n.append('\n'));
        clone.querySelectorAll('td,th').forEach(n => n.append('\t'));
        return (clone.textContent || '').replace(/[^\S\n]+/gu, ' ').replace(/\n{3,}/gu, '\n\n').trim();
      }, html);
    },
    async identify(html) {
      const identity = await page.evaluate(html => {
        const document = new DOMParser().parseFromString(html, 'text/html');
        return {
          login: Boolean(document.querySelector('#login,form[action*="/login/"]')),
          pageId: document.body.id,
          ids: [...new Set([...document.querySelectorAll('.page-context-header [data-userid],#region-main [data-userid]')].map(e => e.dataset.userid).filter(Boolean))],
        };
      }, html);
      if (identity.login) throw new Error('LOGIN_REQUIRED');
      if (identity.pageId !== 'page-user-profile' || identity.ids.length !== 1 || !/^\d+$/u.test(identity.ids[0])) throw new Error('USER_SCOPE_UNAVAILABLE');
      return identity.ids[0];
    },
    async parse(html, sourceUrl, verifiedUserScope = null) {
      const url = new URL(sourceUrl);
      const kind = /\/mod\/quiz\/(view|attempt|review)\.php$/u.exec(url.pathname)?.[1];
      if (!kind) throw new Error('UNSUPPORTED_PAGE');
      const parsed = await page.evaluate(({ html, sourceUrl, kind, verifiedUserScope }) => {
        const document = new DOMParser().parseFromString(html, 'text/html');
        const norm = value => String(value ?? '').normalize('NFC').replace(/\s+/gu, ' ').trim();
        const base = new URL(sourceUrl);
        const courseId = document.body.dataset.courseId || [...document.body.classList].find(c => /^course-\d+$/u.test(c))?.slice(7);
        const quizId = document.body.dataset.quizId || [...document.body.classList].find(c => /^cmid-\d+$/u.test(c))?.slice(5);
        const profile = document.querySelector('.usermenu a[href*="/user/profile.php"]');
        const userScope = document.body.dataset.userScope || (profile ? new URL(profile.getAttribute('href'), base).searchParams.get('id') : null) || verifiedUserScope;
        const attemptId = base.searchParams.get('attempt');
        const pageNumber = Number(base.searchParams.get('page') || 0);
        const questions = [...document.querySelectorAll('.que')].map(q => {
          const stem = q.querySelector('.qtext');
          const answerArea = q.querySelector('.answer');
          const radios = [...(answerArea?.querySelectorAll('input[type=radio]') || [])].filter(i => i.value !== '-1');
          const checkboxes = [...(answerArea?.querySelectorAll('input[type=checkbox]') || [])];
          const selects = [...(answerArea?.querySelectorAll('select') || [])];
          const texts = [...q.querySelectorAll('.formulation input[type=text],.formulation textarea')];
          const kinds = [radios.length, checkboxes.length, selects.length, texts.length].filter(Boolean).length;
          let type = radios.length ? 'choice' : checkboxes.length ? 'multiple' : selects.length ? 'matching' : texts.length === 1 ? 'text' : 'unsupported';
          let unsupportedReason = kinds !== 1 || texts.length > 1 ? 'UNSUPPORTED_CONTROLS' : null;
          const cleanText = (node, blanks = false) => {
            if (!node) return '';
            const clone = node.cloneNode(true);
            if (blanks) clone.querySelectorAll('input[type=text],textarea').forEach(n => n.replaceWith('…'));
            clone.querySelectorAll('.answernumber,.icon,.accesshide,.sr-only,.visually-hidden,input,script,style').forEach(n => n.remove());
            clone.querySelectorAll('br').forEach(n => n.replaceWith(' '));
            return norm(clone.textContent);
          };
          const optionText = input => {
            const refs = (input.getAttribute('aria-labelledby') || '').split(/\s+/u).filter(Boolean)
              .map(id => document.getElementById(id)).filter(Boolean);
            const label = [...q.querySelectorAll('label[for]')].find(l => l.htmlFor === input.id);
            return refs.length ? norm(refs.map(ref => cleanText(ref)).join(' ')) : cleanText(label || input.closest('.r0,.r1'));
          };
          if (q.querySelector('.qtext img,.qtext svg,.qtext math,.qtext canvas,.qtext video,.qtext audio,.answer img,.answer math,.answer svg')) unsupportedReason = 'MEDIA_REQUIRES_EXTRACTION';
          const choices = radios.length ? radios : checkboxes;
          const options = choices.map(input => ({ text: optionText(input), fieldName: input.name, value: input.value, selected: input.checked,
            feedback: input.checked ? ['correct', 'incorrect'].find(state => input.closest('.r0,.r1')?.classList.contains(state)) || 'unconfirmed' : 'unconfirmed' }));
          const rows = selects.map(select => ({
            text: cleanText(select.closest('tr')?.querySelector('.text')), fieldName: select.name,
            options: [...select.options].filter(o => o.value !== '' && o.value !== '0').map(o => ({ text: norm(o.textContent), value: o.value })),
            selectedValue: select.value,
            feedback: ['correct', 'incorrect'].find(state => select.closest('.control')?.classList.contains(state)) || 'unconfirmed',
          }));
          const control = q.querySelector('input[name$="_:sequencecheck"]');
          const identity = /^question-(\d+)-(\d+)$/u.exec(q.id);
          const flag = new URLSearchParams(q.querySelector('.questionflagpostdata')?.value || '');
          const bankQuestionId = identity && flag.get('qubaid') === identity[1] && flag.get('slot') === identity[2]
            && ['qubaid', 'slot', 'qid'].every(key => flag.getAll(key).length === 1)
            && /^[1-9]\d*$/u.test(flag.get('qid') || '') ? flag.get('qid') : undefined;
          if (unsupportedReason && !(unsupportedReason === 'MEDIA_REQUIRES_EXTRACTION' && bankQuestionId)) type = 'unsupported';
          return {
            slot: q.dataset.slot || /-(\d+)$/u.exec(q.id)?.[1] || '', page: pageNumber,
            bankQuestionId,
            type, unsupportedReason, text: cleanText(stem, type === 'text'), options, rows,
            textFormat: type === 'text' ? (q.classList.contains('numerical') ? 'numerical' : q.classList.contains('shortanswer') ? 'shortanswer' : null) : null,
            textAnswer: texts.length === 1 ? norm(texts[0].value) : null,
            textFieldSize: texts.length === 1 && Number.isInteger(texts[0].size) ? texts[0].size : null,
            textFieldName: texts.length === 1 ? texts[0].name : null,
            sequenceFieldName: control?.name || null, sequenceValue: control?.value || null,
            behaviour: ['deferredfeedback', 'adaptivenopenalty', 'adaptive'].find(mode => q.classList.contains(mode)) || null,
            feedback: ['correct', 'incorrect', 'partiallycorrect'].find(s => q.classList.contains(s)) || 'unconfirmed',
            displayedRightAnswer: cleanText(q.querySelector('.rightanswer')) || null,
          };
        });
        const links = [...document.querySelectorAll('a[href]')].map(a => new URL(a.getAttribute('href'), base)).filter(u => u.origin === base.origin);
        const reviews = [...new Set(links.filter(u => u.pathname === '/mod/quiz/review.php' && u.searchParams.has('attempt'))
          .map(u => `${u.origin}${u.pathname}?attempt=${encodeURIComponent(u.searchParams.get('attempt'))}&cmid=${encodeURIComponent(quizId)}`))];
        let active = links.find(u => u.pathname === '/mod/quiz/attempt.php' && u.searchParams.has('attempt'));
        if (!active) {
          const resume = [...document.forms].find(f => new URL(f.getAttribute('action') || '', base).pathname === '/mod/quiz/attempt.php' && f.method === 'get');
          const resumeId = resume?.querySelector('input[name=attempt]')?.value;
          if (resumeId) active = new URL(`/mod/quiz/attempt.php?attempt=${encodeURIComponent(resumeId)}&cmid=${encodeURIComponent(quizId)}`, base);
        }
        const pageUrls = links.filter(u => u.pathname === base.pathname && u.searchParams.get('attempt') === attemptId)
          .map(u => { u.hash = ''; u.searchParams.delete('lang'); return u.href; });
        const expectedSlots = [...document.querySelectorAll('.qnbutton')].map(q => /^quiznavbutton(\d+)$/u.exec(q.id)?.[1]).filter(Boolean);
        const form = document.querySelector('#responseform');
        const startForms = [...document.forms].filter(f => new URL(f.getAttribute('action') || '', base).pathname === '/mod/quiz/startattempt.php');
        const entryForms = startForms.filter(f => !f.querySelector('input[name="_qf__mod_quiz_preflight_check_form"]'));
        const start = entryForms.length === 1 ? entryForms[0] : null;
        const attemptRows = [...document.querySelectorAll('.quizattemptsummary tbody tr')];
        const attemptHeaders = [...document.querySelectorAll('.quizattemptsummary thead th')].map(th => norm(th.textContent));
        const attemptColumn = attemptHeaders.findIndex(text => /^(?:Попытка|Attempt)$/iu.test(text));
        const numbers = attemptRows.map(row => norm(row.querySelectorAll('th,td')[Math.max(0, attemptColumn)]?.textContent))
          .filter(text => /^\d+$/u.test(text)).map(Number);
        const info = norm(document.querySelector('.quizinfo')?.textContent);
        const limit = /(?:Разрешено попыток|Количество разрешённых попыток|Attempts allowed)\s*:\s*(\d+)/iu.exec(info);
        const unlimited = /(?:Разрешено попыток|Количество разрешённых попыток|Attempts allowed)\s*:\s*(?:неограниченно|не ограничено|unlimited)(?=\s|$|[.,])/iu.test(info);
        const used = numbers.length ? Math.max(...numbers) : attemptRows.length ? null : 0;
        const allowed = limit ? Number(limit[1]) : null;
        const attemptUsage = { used, allowed, unlimited, remaining: allowed !== null && used !== null ? Math.max(0, allowed - used) : null };
        return {
          login: Boolean(document.querySelector('#login,form[action*="/login/"]')),
          bodyId: document.body.id, courseId, quizId, userScope, attemptId, page: pageNumber,
          attemptUsage: kind === 'view' ? attemptUsage : null,
          attemptSummaries: kind === 'view' ? attemptRows.map(row => ({
            cells: [...row.querySelectorAll('td')].map(td => norm(td.textContent)),
            headers: attemptHeaders,
          })) : [],
          resultSummary: kind === 'review' ? [...document.querySelectorAll('.quizreviewsummary tr')].map(row => ({
            label: norm(row.querySelector('th')?.textContent), value: norm(row.querySelector('td')?.textContent),
          })) : [],
          formAttempt: form?.querySelector('input[name=attempt]')?.value || null,
          submissionForm: kind === 'attempt' && form ? {
            action: new URL(form.getAttribute('action') || '', base).href,
            method: form.method,
            sesskey: form.querySelector('input[name=sesskey]')?.value || null,
            slots: form.querySelector('input[name=slots]')?.value?.split(',') || [],
          } : null,
          questions, reviews, activeUrl: active ? active.href : null,
          activeAttempt: Boolean(active) || (kind === 'view' && Boolean(start) && /^(?:Продолжить (?:текущую )?попытку|Continue (?:the )?(?:last |current )?attempt)$/iu.test(norm(start.querySelector('button,input[type=submit]')?.textContent || start.querySelector('input[type=submit]')?.value))),
          startForm: kind === 'view' && start ? {
            action: new URL(start.getAttribute('action') || '', base).href, method: start.method,
            fields: [...start.querySelectorAll('input[type=hidden][name]')].map(input => [input.name, input.value]),
            preflightRequired: Boolean(document.querySelector('#mod_quiz_preflight_form,.quizsecuremoderequired,input[name="_qf__mod_quiz_preflight_check_form"]')),
          } : null,
          pageUrls: [...new Set(pageUrls)], expectedSlots,
        };
      }, { html, sourceUrl: url.href, kind, verifiedUserScope });
      if (parsed.login) throw new Error('LOGIN_REQUIRED');
      if (parsed.bodyId !== `page-mod-quiz-${kind}` || !parsed.courseId || !parsed.quizId || !parsed.userScope) throw new Error('PAGE_SCOPE_UNAVAILABLE');
      if (verifiedUserScope && parsed.userScope !== verifiedUserScope) throw new Error('PAGE_SCOPE_MISMATCH');
      if ((url.searchParams.has('cmid') && url.searchParams.get('cmid') !== parsed.quizId)
          || (kind === 'view' && url.searchParams.get('id') !== parsed.quizId)
          || (kind !== 'view' && !/^\d+$/u.test(parsed.attemptId || ''))
          || (kind === 'attempt' && parsed.formAttempt !== parsed.attemptId)) throw new Error('PAGE_SCOPE_MISMATCH');
      parsed.kind = kind;
      parsed.origin = url.origin;
      parsed.sourceUrl = url.href;
      for (const question of parsed.questions) {
        question.options = question.options.map(o => ({ ...o, id: optionId(o.text) }));
        question.rows = question.rows.map(row => ({ ...row, id: digest(['row-v1', normalize(row.text), row.options.map(o => normalize(o.text)).sort()]), options: row.options.map(o => ({ ...o, id: optionId(o.text) })) }));
        question.answer = question.type === 'text' ? question.textAnswer : question.type === 'matching'
          ? Object.fromEntries(question.rows.map(row => [row.id, row.options.find(o => o.value === row.selectedValue)?.id ?? null]))
          : question.options.filter(o => o.selected).map(o => o.id);
        question.revealedAnswer = null;
        if (question.displayedRightAnswer) {
          const text = question.displayedRightAnswer.replace(/^(?:Правильный ответ|Правильные ответы|Верный ответ|The correct answer is|The correct answers are)\s*:\s*/iu, '');
          const hasPrefix = text !== question.displayedRightAnswer;
          if (hasPrefix && question.type === 'text' && normalize(text)) question.revealedAnswer = normalize(text);
          if (hasPrefix && question.type === 'matching' && new Set(question.rows.map(r => r.id)).size === question.rows.length) {
            // Moodle renders pairs in stem order; keep punctuation inside labels intact.
            let remaining = text;
            const answer = {};
            for (const [index, row] of question.rows.entries()) {
              const suffix = index === question.rows.length - 1 ? '' : ', ';
              const matches = row.options.filter(o => {
                const pair = `${row.text} → ${o.text}${suffix}`;
                return suffix ? remaining.startsWith(pair) : remaining === pair;
              });
              if (matches.length !== 1) break;
              answer[row.id] = matches[0].id;
              remaining = remaining.slice(`${row.text} → ${matches[0].text}${suffix}`.length);
            }
            if (!remaining && Object.keys(answer).length === question.rows.length) question.revealedAnswer = answer;
          }
          if (hasPrefix && ['choice', 'multiple'].includes(question.type)) {
            const exact = question.options.filter(o => o.text === text);
            if (exact.length === 1) question.revealedAnswer = [exact[0].id];
            else if (question.type === 'multiple' && question.options.every(o => !/[,;]/u.test(o.text))) {
              const pieces = text.split(/[,;]\s*/u);
              const selected = pieces.map(t => question.options.find(o => o.text === normalize(t))?.id);
              if (selected.every(Boolean) && new Set(selected).size === selected.length) question.revealedAnswer = selected;
            }
          }
        }
        Object.assign(question, { origin: url.origin, courseId: parsed.courseId, userScope: parsed.userScope,
          quizId: parsed.quizId, attemptId: parsed.attemptId, pageKind: kind, sourceUrl: url.href });
      }
      return parsed;
    },
    close() { return browser.close(); },
  };
  // Keep parser shutdown ordered after all pending document reads.
  let tail = Promise.resolve();
  return Object.fromEntries(Object.entries(parser).map(([name, method]) => [name, (...args) => {
    const result = tail.then(() => method(...args));
    tail = result.catch(() => {});
    return result;
  }]));
}

export async function openMoodle({ authFile, origin, cookies, persist = true }) {
  const url = new URL(origin);
  if (url.origin !== origin || url.protocol !== 'https:' || url.username || url.password) throw new Error('INVALID_ORIGIN');
  const api = await request.newContext({ storageState: cookieState(cookies ?? JSON.parse(await readFile(authFile, 'utf8')), origin), timeout: 30000, maxRedirects: 0 });
  let parser;
  try { parser = await openParser(); } catch (error) { await api.dispose(); throw error; }
  let verifiedUserScope;
  try {
    const profile = await api.get(`${origin}/user/profile.php`, { maxRedirects: 0 });
    try {
      if ([301, 302, 303, 401, 403].includes(profile.status())) throw new Error('LOGIN_REQUIRED');
      if (!profile.ok()) throw new Error(`HTTP_${profile.status()}`);
      const body = await profile.body();
      if (body.length > 5 * 1024 * 1024) throw new Error('PAGE_TOO_LARGE');
      verifiedUserScope = await parser.identify(body.toString('utf8'));
    } finally { await profile.dispose(); }
  } catch (error) { await api.dispose(); await parser.close(); throw error; }
  const saveSession = async () => {
    const state = cookieState(await api.storageState(), origin);
    const temporary = `${authFile}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
    await rename(temporary, authFile);
  };
  try { if (persist) await saveSession(); }
  catch (error) { await api.dispose(); await parser.close(); throw error; }
  async function read(input) {
    let target = new URL(input, origin);
    const original = new URL(target);
    for (let redirects = 0; redirects < 5; redirects++) {
      if (target.origin !== origin || target.username || target.password || !/^\/mod\/quiz\/(view|attempt|review)\.php$/u.test(target.pathname)) throw new Error('UNEXPECTED_URL');
      if (target.searchParams.has('sesskey')) throw new Error('UNEXPECTED_URL');
      const response = await api.get(target.href, { maxRedirects: 0 });
      try {
        if (response.status() >= 300 && response.status() < 400) {
          const location = response.headers().location;
          if (!location) throw new Error('INVALID_REDIRECT');
          const next = new URL(location, target);
          if (next.pathname.includes('/login/')) throw new Error('LOGIN_REQUIRED');
          target = next;
          continue;
        }
        if ([401, 403].includes(response.status())) throw new Error('LOGIN_REQUIRED');
        if (!response.ok()) throw new Error(`HTTP_${response.status()}`);
        if (!response.headers()['content-type']?.includes('text/html')) throw new Error('UNSUPPORTED_MIME');
        // ponytail: Playwright buffers responses; 5 MB validation cap, use streaming fetch if large pages become necessary.
        const body = await response.body();
        if (body.length > 5 * 1024 * 1024) throw new Error('PAGE_TOO_LARGE');
        const parsed = await parser.parse(body.toString('utf8'), target.href, verifiedUserScope);
        if (target.pathname !== original.pathname || (original.searchParams.has('attempt') && parsed.attemptId !== original.searchParams.get('attempt'))
            || (original.searchParams.has('id') && parsed.quizId !== original.searchParams.get('id'))
            || (original.searchParams.has('cmid') && parsed.quizId !== original.searchParams.get('cmid'))) throw new Error('PAGE_SCOPE_MISMATCH');
        return parsed;
      } finally { await response.dispose(); }
    }
    throw new Error('REDIRECT_LIMIT');
  }
  async function readGrades(courseId = null) {
    if (courseId !== null && !/^\d+$/u.test(courseId)) throw new Error('INVALID_IDS');
    const pathname = courseId ? '/grade/report/user/index.php' : '/grade/report/overview/index.php';
    const target = new URL(pathname, origin);
    target.searchParams.set('userid', verifiedUserScope);
    if (courseId) target.searchParams.set('id', courseId);
    const response = await api.get(target.href, { maxRedirects: 0 });
    try {
      if ([301, 302, 303, 401, 403].includes(response.status())) throw new Error('GRADE_SCOPE_UNAVAILABLE');
      if (!response.ok()) throw new Error(`HTTP_${response.status()}`);
      if (!response.headers()['content-type']?.includes('text/html')) throw new Error('UNSUPPORTED_MIME');
      const body = await response.body();
      if (body.length > 5 * 1024 * 1024) throw new Error('PAGE_TOO_LARGE');
      return await parser.grades(body.toString('utf8'), origin, verifiedUserScope, courseId);
    } finally { await response.dispose(); }
  }
  return {
    origin, userScope: verifiedUserScope, saveSession,
    courses() { return readGrades(); },
    grades(courseId) { return readGrades(courseId); },
    read,
    collect(input) { return collectTest(read, input); },
    async quizzes(scope) {
      if (scope.origin !== origin || scope.userScope !== verifiedUserScope || !/^\d+$/u.test(scope.courseId)) throw new Error('PAGE_SCOPE_MISMATCH');
      const response = await api.get(`${origin}/course/view.php?id=${scope.courseId}`, { maxRedirects: 0 });
      try {
        if (!response.ok()) throw new Error('COURSE_SCOPE_UNAVAILABLE');
        const body = await response.body();
        if (body.length > 5 * 1024 * 1024) throw new Error('PAGE_TOO_LARGE');
        return await parser.quizzes(body.toString('utf8'), origin, scope.courseId);
      } finally { await response.dispose(); }
    },
    async postStart(plan) {
      const target = new URL(plan.url);
      if (target.origin !== origin || target.pathname !== '/mod/quiz/startattempt.php'
          || target.username || target.password || !plan.fields.sesskey) throw new Error('INVALID_START_URL');
      let response;
      try {
        response = await api.post(target.href, { form: plan.fields, maxRedirects: 0, maxRetries: 0 });
        const location = response.headers().location;
        if (![302, 303].includes(response.status()) || !location) throw new Error('UNKNOWN_START_OUTCOME');
        const attempt = new URL(location, target);
        if (attempt.origin !== origin || attempt.pathname !== '/mod/quiz/attempt.php'
            || !/^\d+$/u.test(attempt.searchParams.get('attempt') || '')
            || (attempt.searchParams.has('cmid') && attempt.searchParams.get('cmid') !== plan.fields.cmid)) throw new Error('UNKNOWN_START_OUTCOME');
        attempt.searchParams.set('cmid', plan.fields.cmid);
        return { attemptUrl: attempt.href };
      } catch { throw new Error('UNKNOWN_START_OUTCOME'); }
      finally { await response?.dispose(); }
    },
    async postSubmission(plan) {
      const target = new URL(plan.url);
      if (target.origin !== origin || target.pathname !== '/mod/quiz/processattempt.php'
          || target.username || target.password || !plan.fields.sesskey) throw new Error('INVALID_SUBMISSION_URL');
      let response;
      try {
        response = await api.post(target.href, { multipart: plan.fields, maxRedirects: 0, maxRetries: 0 });
        const location = response.headers().location;
        if (![302, 303].includes(response.status()) || !location) throw new Error('UNKNOWN_SUBMISSION_OUTCOME');
        const review = new URL(location, target);
        if (review.origin !== origin || review.pathname !== '/mod/quiz/review.php'
            || review.searchParams.get('attempt') !== plan.fields.attempt) throw new Error('UNKNOWN_SUBMISSION_OUTCOME');
        review.searchParams.set('cmid', plan.fields.cmid);
        review.searchParams.set('showall', '1');
        return { reviewUrl: review.href };
      } catch { throw new Error('UNKNOWN_SUBMISSION_OUTCOME'); }
      finally { await response?.dispose(); }
    },
    async materials(scope) {
      if (scope.origin !== origin || scope.userScope !== verifiedUserScope || !/^\d+$/u.test(scope.courseId) || !/^\d+$/u.test(scope.quizId)) throw new Error('PAGE_SCOPE_MISMATCH');
      const response = await api.get(`${origin}/course/view.php?id=${scope.courseId}`, { maxRedirects: 0 });
      try {
        if (!response.ok()) throw new Error('MATERIAL_SCOPE_UNAVAILABLE');
        const body = await response.body();
        if (body.length > 5 * 1024 * 1024) throw new Error('PAGE_TOO_LARGE');
        return await parser.materials(body.toString('utf8'), origin, scope.courseId, scope.quizId);
      } finally { await response.dispose(); }
    },
    async downloadMaterial(ref) {
      let url = new URL(ref.url);
      if (url.origin !== origin || !/^\/mod\/(resource|page)\/view\.php$/u.test(url.pathname) || !/^\d+$/u.test(url.searchParams.get('id') || '')) throw new Error('INVALID_MATERIAL');
      for (let i = 0; i < 5; i++) {
        if (url.origin !== origin || url.username || url.password || !/^\/(?:mod\/(resource|page)\/view\.php|pluginfile\.php\/)/u.test(url.pathname)) throw new Error('UNEXPECTED_URL');
        const response = await api.get(url.href, { maxRedirects: 0 });
        try {
          if (response.status() >= 300 && response.status() < 400) {
            const location = response.headers().location;
            if (!location) throw new Error('INVALID_REDIRECT');
            url = new URL(location, url);
            continue;
          }
          if (!response.ok()) throw new Error('MATERIAL_DOWNLOAD_FAILED');
          const buffer = await response.body();
          if (buffer.length > 10 * 1024 * 1024) throw new Error('MATERIAL_TOO_LARGE');
          const mime = response.headers()['content-type'] || '';
          if (mime.includes('text/html') && url.pathname === '/mod/resource/view.php') {
            url = new URL(await parser.resourceFile(buffer.toString('utf8'), url.href));
            continue;
          }
          const htmlText = mime.includes('text/html') ? await parser.materialText(buffer.toString('utf8')) : null;
          return { ...ref, buffer, mime, htmlText };
        } finally { await response.dispose(); }
      }
      throw new Error('REDIRECT_LIMIT');
    },
    async close({ save = true } = {}) {
      try { if (save) await saveSession(); }
      finally { await api.dispose(); await parser.close(); }
    },
  };
}

export async function collectTest(read, input) {
      const first = await read(input);
      if (first.kind === 'view') return first;
      const key = page => JSON.stringify([page.kind, page.origin, page.userScope, page.courseId, page.quizId, page.attemptId]);
      const identity = key(first);
      const questions = new Map();
      const submissionForms = [];
      const expected = new Set(first.expectedSlots);
      const queue = [first];
      const seen = new Set();
      while (queue.length) {
        const page = typeof queue[0] === 'string' ? await read(queue.shift()) : queue.shift();
        const pageUrl = new URL(page.sourceUrl);
        const pageKey = pageUrl.searchParams.get('page') || '0';
        if (seen.has(pageKey)) continue;
        seen.add(pageKey);
        if (seen.size > 100) throw new Error('PAGE_LIMIT');
        if (key(page) !== identity) throw new Error('PAGE_SCOPE_MISMATCH');
        if (page.submissionForm) submissionForms.push(page.submissionForm);
        page.expectedSlots.forEach(slot => expected.add(slot));
        for (const question of page.questions) {
          if (!question.slot || questions.has(question.slot)) throw new Error('DUPLICATE_SLOT');
          questions.set(question.slot, question);
        }
        if (expected.size && [...expected].every(slot => questions.has(slot))) break;
        for (const href of page.pageUrls) {
          const link = new URL(href);
          if (!seen.has(link.searchParams.get('page') || '0') && !queue.includes(href)) queue.push(href);
        }
      }
      if (!expected.size || expected.size !== questions.size || [...expected].some(slot => !questions.has(slot))) throw new Error('INCOMPLETE_TEST');
      return { ...first, questions: [...questions.values()], submissionForms, complete: true };
}
