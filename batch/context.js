import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { digest, normalize } from './answers.js';

const run = promisify(execFile);
const wordScript = fileURLToPath(new URL('./read-word.ps1', import.meta.url));

export async function extractMaterial(material, cacheDir) {
  await mkdir(cacheDir, { recursive: true });
  const contentHash = createHash('sha256').update(material.buffer).digest('hex');
  const cacheFile = join(cacheDir, `${contentHash}.json`);
  try {
    const cached = JSON.parse(await readFile(cacheFile, 'utf8'));
    if (cached.extractorVersion === 3 && cached.contentHash === contentHash && typeof cached.text === 'string') return { ...material, buffer: undefined, ...cached, cacheHit: true };
  } catch { /* missing or invalid cache is rebuilt from the source bytes */ }
  let text, lineText;
  if (material.buffer.subarray(0, 5).toString() === '%PDF-') {
    const modulePath = process.env.PDFJS_PATH || join(process.env.USERPROFILE || '', '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/pdfjs-dist/legacy/build/pdf.mjs');
    let pdfjs;
    try { pdfjs = await import(pathToFileURL(modulePath).href); } catch { throw new Error('PDF_READER_UNAVAILABLE'); }
    const task = pdfjs.getDocument({ data: new Uint8Array(material.buffer), isEvalSupported: false, verbosity: 0 });
    try {
      const pdf = await task.promise;
      if (pdf.numPages > 300) throw new Error('MATERIAL_PAGE_LIMIT');
      const pages = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        pages.push(content.items.map(item => (item.str || '') + (item.hasEOL ? '\n' : ' ')).join(''));
        page.cleanup();
      }
      text = lineText = pages.join('\n');
    } finally { await task.destroy(); }
  } else if (material.mime.includes('msword') || material.mime.includes('wordprocessingml')
      || material.buffer.subarray(0, 8).toString('hex') === 'd0cf11e0a1b11ae1') {
    if (process.platform !== 'win32') throw new Error('WORD_READER_UNAVAILABLE');
    const path = resolve(cacheDir, `${contentHash}${material.mime.includes('wordprocessingml') ? '.docx' : '.doc'}`);
    await writeFile(path, material.buffer);
    const result = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', wordScript, '-InputPath', path],
      { windowsHide: true, timeout: 45000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' });
    text = result.stdout;
  } else if (material.htmlText !== null && material.htmlText !== undefined) text = material.htmlText;
  else if (material.mime.includes('text/plain')) text = material.buffer.toString('utf8');
  else throw new Error('UNSUPPORTED_MATERIAL');
  text = String(text).normalize('NFC').replace(/\r\n?/gu, '\n').split('\n').map(normalize).join('\n').replace(/\n{3,}/gu, '\n\n').trim();
  if (text.length > 500000) throw new Error('MATERIAL_TEXT_LIMIT');
  if (text.length < 100) throw new Error('MATERIAL_UNREADABLE');
  const cached = { extractorVersion: 3, contentHash, text, ...(lineText ? { lineText } : {}) };
  await writeFile(cacheFile, JSON.stringify(cached), { mode: 0o600 });
  return { ...material, buffer: undefined, ...cached, cacheHit: false };
}

export async function loadContext(moodle, scope, cacheDir) {
  let refs;
  try { refs = await moodle.materials(scope); } catch {
    return { status: 'missing', reason: 'MATERIAL_SCOPE_UNAVAILABLE', materials: [], text: '', contextHash: null };
  }
  const materials = [];
  for (const ref of refs) {
    try { materials.push(await extractMaterial(await moodle.downloadMaterial(ref), cacheDir)); }
    catch (error) { materials.push({ ...ref, status: 'unreadable', reason: /^[A-Z_]+$/u.test(error.message || '') ? error.message : 'MATERIAL_UNREADABLE' }); }
  }
  const ready = materials.filter(m => m.text);
  const text = ready.map(m => `${m.title}\n${m.text}`).join('\n\n');
  return { status: ready.length ? ready.length === materials.length ? 'ready' : 'partial' : 'missing', materials,
    text, contextHash: ready.length ? digest(['context-v2-structure', scope.origin, scope.userScope, scope.courseId,
      materials.map(m => [m.url, m.contentHash || null, m.status || 'ready'])]) : null };
}

export function contextManifest(context) {
  const describe = doc => ({ status: doc.status || 'unknown', characters: doc.text?.length || 0,
    materials: (doc.materials || []).map(m => ({ title: m.title?.slice(0, 300), status: m.text ? 'ready' : m.status || 'unreadable',
      characters: m.text?.length || 0, ...(m.reason ? { reason: m.reason } : {}) })) });
  return context.documents ? Object.fromEntries(Object.entries(context.documents).map(([id, doc]) => [id, describe(doc)])) : describe(context);
}
