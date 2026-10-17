import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openMoodle, cookieState } from './moodle.js';

// Keep the paired account's cached panel available while cookies need renewal.
export async function openConnection({ authFile, origin, root, open = openMoodle }) {
  let client, connecting;
  try { client = await open({ authFile, origin }); }
  catch (error) { if (error.message !== 'LOGIN_REQUIRED') throw error; }
  const identity = client || JSON.parse(await readFile(join(root, 'overview.json'), 'utf8'));
  if (identity.origin !== origin || !/^\d+$/u.test(identity.userScope || '')) {
    await client?.close(); throw new Error('USER_SCOPE_MISMATCH');
  }
  const moodle = { origin, userScope: identity.userScope, authRequired: !client };
  const install = next => {
    Object.assign(moodle, next, { connect, close, useSession, authRequired: false });
    client = next;
  };
  const connect = () => {
    if (!moodle.authRequired) return Promise.resolve();
    connecting ??= (async () => {
      // Never replace a newly supplied cookie file with the expired client's state.
      await client?.close({ save: false }); client = null;
      const next = await open({ authFile, origin });
      if (next.origin !== origin || next.userScope !== moodle.userScope) {
        await next.close({ save: false }); throw new Error('USER_SCOPE_MISMATCH');
      }
      install(next);
    })().finally(() => { connecting = null; });
    return connecting;
  };
  const useSession = async (cookies, beforeInstall = async () => {}) => {
    cookies = cookieState(cookies, origin);
    await connecting;
    const next = await open({ authFile, origin, cookies, persist: false });
    try {
      if (next.origin !== origin || !/^\d+$/u.test(next.userScope || '')) throw new Error('USER_SCOPE_MISMATCH');
      await beforeInstall(next.userScope);
      await next.saveSession();
    } catch (error) { await next.close({ save: false }); throw error; }
    await client?.close({ save: false });
    install(next);
  };
  const close = async () => { await connecting?.catch(() => {}); await client?.close({ save: !moodle.authRequired }); client = null; };
  if (client) install(client);
  else Object.assign(moodle, { connect, close, useSession });
  return moodle;
}
