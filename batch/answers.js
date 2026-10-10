import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const normalize = value => String(value ?? '').normalize('NFC').replace(/\s+/gu, ' ').trim();
export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const optionId = text => digest(['option-v1', normalize(text)]);

export function questionKey(question) {
  const { origin, userScope, courseId, contextHash = '', type, text, options = [], rows = [] } = question;
  if (!origin || new URL(origin).origin !== origin || !userScope || !courseId || (!normalize(text) && type !== 'matching')) throw new Error('INVALID_QUESTION_SCOPE');
  const media = question.unsupportedReason === 'MEDIA_REQUIRES_EXTRACTION' && /^[1-9]\d*$/u.test(question.bankQuestionId || '');
  if (!['choice', 'multiple', 'matching', 'text'].includes(type) || (question.unsupportedReason && !media)) throw new Error('UNSUPPORTED_QUESTION');
  const texts = options.map(option => normalize(option.text));
  if (['choice', 'multiple'].includes(type) && (texts.length < 2 || texts.some(t => !t)
      || (type === 'multiple' && new Set(texts).size !== texts.length)
      || (type === 'choice' && !texts.some(text => texts.filter(t => t === text).length === 1))
      || options.some(option => option.id !== optionId(option.text)))) throw new Error('AMBIGUOUS_OPTIONS');
  const canonicalRows = rows.map(row => [normalize(row.text), row.options.map(option => normalize(option.text)).sort()]);
  if (type === 'matching' && (!rows.length || new Set(rows.map(row => row.id)).size !== rows.length
      || canonicalRows.some(([label, values]) => !label || !values.length || values.some(v => !v) || new Set(values).size !== values.length)
      || rows.some(row => row.id !== digest(['row-v1', normalize(row.text), row.options.map(o => normalize(o.text)).sort()])
        || row.options.some(option => option.id !== optionId(option.text))))) throw new Error('AMBIGUOUS_ROWS');
  return digest(['question-v2', origin, userScope, courseId, contextHash, type, normalize(text), texts.sort(), canonicalRows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))), ...(media ? [question.bankQuestionId] : [])]);
}

export function answerSignature(question, answer) {
  if (question.type === 'text') {
    if (typeof answer !== 'string' || !normalize(answer)) throw new Error('INVALID_ANSWER');
    return JSON.stringify(normalize(answer));
  }
  if (question.type === 'matching') {
    if (!answer || typeof answer !== 'object' || Array.isArray(answer) || Object.keys(answer).length !== question.rows.length
        || question.rows.some(row => !row.options.some(option => option.id === answer[row.id]))) throw new Error('INVALID_ANSWER');
    return JSON.stringify(question.rows.map(row => [row.id, answer[row.id]]).sort(([a], [b]) => a.localeCompare(b)));
  }
  if (!Array.isArray(answer) || (question.type === 'choice' && answer.length !== 1)
      || (question.type === 'choice' && question.options.filter(option => option.id === answer[0]).length !== 1)
      || new Set(answer).size !== answer.length || answer.some(id => !question.options.some(option => option.id === id))) throw new Error('INVALID_ANSWER');
  return JSON.stringify([...answer].sort());
}

function decodeAnswer(question, signature) {
  const answer = JSON.parse(signature);
  return question.type === 'matching' ? Object.fromEntries(answer) : answer;
}

export function isExcludedAnswer(question, answer) {
  const signature = answerSignature(question, answer);
  return Boolean(question.memory?.excludedAnswers?.some(item => answerSignature(question, item) === signature)
    || (question.type === 'multiple' && Object.entries(question.memory?.multipleOptions || {}).some(([id, included]) => answer.includes(id) !== included))
    || (question.type === 'matching' && question.rows.some(row => {
      const memory = question.memory?.matchingRows?.[row.id];
      return memory && ((memory.answer && memory.answer !== answer[row.id]) || memory.excludedAnswers.includes(answer[row.id]));
    })));
}

export function openAnswers(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path, { timeout: 5000 });
  db.exec(`CREATE TABLE IF NOT EXISTS observations (
    question_key TEXT NOT NULL, quiz_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
    slot TEXT NOT NULL, evidence TEXT NOT NULL, answer TEXT NOT NULL,
    outcome TEXT NOT NULL, snapshot TEXT NOT NULL, source_url TEXT NOT NULL,
    PRIMARY KEY(question_key, quiz_id, attempt_id, slot, evidence)
  );`);
  const insert = db.prepare(`INSERT INTO observations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(question_key, quiz_id, attempt_id, slot, evidence) DO UPDATE SET
    answer=excluded.answer, outcome=excluded.outcome, snapshot=excluded.snapshot, source_url=excluded.source_url
    WHERE excluded.outcome != 'unconfirmed' OR observations.outcome = 'unconfirmed'`);
  const read = db.prepare('SELECT quiz_id, answer, outcome, evidence, snapshot FROM observations WHERE question_key = ?');
  return {
    importReview(questions) {
      let imported = 0;
      let skipped = 0;
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const question of questions) {
          if (question.pageKind !== 'review' || !question.attemptId || !question.quizId || !question.slot) throw new Error('REVIEW_PROVENANCE_REQUIRED');
          const url = new URL(question.sourceUrl);
          if (url.origin !== question.origin || !url.pathname.endsWith('/mod/quiz/review.php')
              || url.searchParams.get('attempt') !== question.attemptId || url.searchParams.get('cmid') !== question.quizId) throw new Error('REVIEW_PROVENANCE_REQUIRED');
          let key;
          try { key = questionKey(question); } catch { skipped++; continue; }
          const evidence = [{ kind: 'selected', answer: question.answer, outcome: question.feedback }];
          if (question.revealedAnswer !== null && question.revealedAnswer !== undefined) evidence.push({ kind: 'revealed', answer: question.revealedAnswer, outcome: 'correct' });
          for (const item of evidence) {
            if (!['correct', 'incorrect', 'partiallycorrect', 'unconfirmed'].includes(item.outcome)) continue;
            let signature;
            try { signature = answerSignature(question, item.answer); } catch { skipped++; continue; }
            insert.run(key, question.quizId, question.attemptId, String(question.slot), item.kind, signature,
              item.outcome, JSON.stringify(question), question.sourceUrl);
            imported++;
          }
          if (question.type === 'multiple') for (const option of question.options) {
            if (!option.selected || !question.answer?.includes(option.id) || !['correct', 'incorrect'].includes(option.feedback)) continue;
            insert.run(key, question.quizId, question.attemptId, String(question.slot), `option:${option.id}`,
              JSON.stringify(option.id), option.feedback, JSON.stringify(question), question.sourceUrl);
            imported++;
          }
          if (question.type === 'matching') for (const row of question.rows) {
            if (!['correct', 'incorrect'].includes(row.feedback)) continue;
            const selected = row.options.filter(o => o.value === row.selectedValue);
            if (selected.length !== 1 || selected[0].id !== question.answer?.[row.id]) continue;
            insert.run(key, question.quizId, question.attemptId, String(question.slot), `row:${row.id}`,
              JSON.stringify(selected[0].id), row.feedback, JSON.stringify(question), question.sourceUrl);
            imported++;
          }
        }
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      return { imported, skipped, total: db.prepare('SELECT count(*) AS count FROM observations').get().count };
    },
    lookup(question) {
      let key;
      try { key = questionKey(question); } catch { return { status: 'unsupported', answer: null, excludedAnswers: [], observations: 0 }; }
      let all = read.all(key);
      if (/^[1-9]\d*$/u.test(question.bankQuestionId || '')) {
        const identified = all.map(record => ({ ...record, bankQuestionId: JSON.parse(record.snapshot).bankQuestionId })).filter(r => r.bankQuestionId);
        // Identical wording can belong to different Moodle keys. Never share their feedback.
        if (identified.length) all = identified.filter(r => r.bankQuestionId === question.bankQuestionId);
      }
      const records = all.filter(r => !r.evidence.startsWith('row:') && !r.evidence.startsWith('option:'));
      let positive = [...new Set(records.filter(r => r.outcome === 'correct').map(r => r.answer))];
      const negative = [...new Set(records.filter(r => ['incorrect', 'partiallycorrect'].includes(r.outcome)).map(r => r.answer))];
      let conflict = false;
      const multipleOptions = {};
      if (question.type === 'multiple') for (const option of question.options) {
        const outcomes = new Set(all.filter(r => r.evidence === `option:${option.id}`).map(r => r.outcome === 'correct'));
        if (outcomes.size > 1) conflict = true;
        else if (outcomes.size === 1) multipleOptions[option.id] = [...outcomes][0];
      }
      // Moodle can award full marks despite selected distractors (zero negative weight).
      // Explicit option marks take precedence; untouched options remain unknown.
      if (question.type === 'multiple' && Object.keys(multipleOptions).length) {
        positive = positive.filter(signature => {
          const answer = decodeAnswer(question, signature);
          return Object.entries(multipleOptions).every(([id, included]) => answer.includes(id) === included);
        });
      }
      conflict ||= positive.some(answer => negative.includes(answer));
      if (!conflict && question.type === 'text' && positive.length > 1
          && new Set(positive.map(signature => JSON.parse(signature).toLowerCase())).size === 1) {
        // Keep an exact accepted spelling; do not infer that Moodle ignores case.
        positive = [positive.find(answer => records.some(r => r.quiz_id === question.quizId && r.outcome === 'correct' && r.answer === answer)) || positive[0]];
      }
      conflict ||= question.type !== 'multiple' && positive.length > 1;
      if (!conflict && question.type === 'multiple' && positive.length > 1) {
        // Reuse an exact accepted set compatible with all explicit marks, never a new combination.
        positive.sort((a, b) => JSON.parse(a).length - JSON.parse(b).length || a.localeCompare(b));
        positive = positive.slice(0, 1);
      }
      if (!conflict && question.type === 'multiple' && question.options.every(option => Object.hasOwn(multipleOptions, option.id))) {
        const signature = answerSignature(question, question.options.filter(option => multipleOptions[option.id]).map(option => option.id));
        if (negative.includes(signature)) conflict = true;
        else if (!positive.includes(signature)) positive.push(signature);
      }
      const matchingRows = {};
      if (question.type === 'matching') for (const row of question.rows) {
        const observations = all.filter(r => r.evidence === `row:${row.id}`);
        const correct = [...new Set([...observations.filter(r => r.outcome === 'correct').map(r => JSON.parse(r.answer)),
          ...positive.map(signature => decodeAnswer(question, signature)[row.id])])];
        const wrong = [...new Set(observations.filter(r => r.outcome === 'incorrect').map(r => JSON.parse(r.answer)))];
        if (correct.length > 1 || correct.some(id => wrong.includes(id))) conflict = true;
        if (correct.length || wrong.length) matchingRows[row.id] = { answer: correct.length === 1 ? correct[0] : null, excludedAnswers: wrong };
      }
      if (!conflict && question.type === 'matching' && question.rows.every(row => matchingRows[row.id]?.answer)) {
        const signature = answerSignature(question, Object.fromEntries(question.rows.map(row => [row.id, matchingRows[row.id].answer])));
        if (negative.includes(signature)) conflict = true;
        else if (!positive.includes(signature)) positive.push(signature);
      }
      return {
        status: conflict ? 'conflict' : positive.length === 1 ? 'known' : question.unsupportedReason ? 'unsupported' : 'unresolved',
        answer: !conflict && positive.length === 1 ? decodeAnswer(question, positive[0]) : null,
        excludedAnswers: conflict ? [] : negative.map(signature => decodeAnswer(question, signature)),
        observations: all.length,
        ...(Object.keys(multipleOptions).length ? { multipleOptions: conflict ? {} : multipleOptions } : {}),
        ...(Object.keys(matchingRows).length ? { matchingRows: conflict ? {} : matchingRows } : {}),
      };
    },
    close() { db.close(); },
  };
}
