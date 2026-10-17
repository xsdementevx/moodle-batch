import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openConnection} from '../../batch/connection.js';
import {openService} from '../../batch/service.js';

test('expired auth keeps paired cache available and reconnects only to the same account', async () => {
  const root=await mkdtemp(join(tmpdir(),'batch-auth-'));
  const identity={origin:'https://moodle.example',userScope:'42'};
  const overview={schemaVersion:1,...identity,courses:[],progress:{},summary:{}};
  await writeFile(join(root,'overview.json'),JSON.stringify(overview));
  let valid=false,other=false,opens=0,scans=0,service;
  const closes=[];
  const open=async()=>{opens++;if(!valid)throw new Error('LOGIN_REQUIRED');return{...identity,userScope:other?'43':'42',close:async options=>closes.push(options),courses:async()=>[]};};
  const moodle=await openConnection({authFile:'fixture',root,origin:identity.origin,open});
  try{
    service=await openService({root,moodle,store:{},scan:async()=>{scans++;return overview;},runner:()=>assert.fail('must not dispatch while logged out')});
    assert.equal(service.state().authRequired,true);
    assert.ok(service.state().overview);
    await assert.rejects(service.start({requestId:'offline-request-1234',quizIds:['20'],maxAttempts:1,userScope:'42'}),/LOGIN_REQUIRED/);
    assert.equal(service.state().jobs.length,0);
    valid=true;await service.refresh();
    assert.equal(service.state().authRequired,false);assert.equal(scans,1);
    moodle.authRequired=true;other=true;
    await service.refresh();
    assert.equal(service.state().error,'USER_SCOPE_MISMATCH');assert.equal(scans,1);
    assert.ok(closes.every(options=>options.save===false),'expired and foreign sessions must not overwrite supplied cookies');
    other=false;await Promise.all([moodle.connect(),moodle.connect()]);
    assert.equal(opens,4,'concurrent reconnects share one authentication attempt');
  }finally{await service?.close();await moodle.close();await rm(root,{recursive:true,force:true});}
});

test('browser sessions recover auth and switch accounts without mixing cached jobs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'batch-browser-auth-'));
  const origin = 'https://moodle.example';
  const authFile = join(root, 'cookies.json');
  await writeFile(join(root, 'overview.json'), JSON.stringify({ schemaVersion: 1, origin, userScope: '42', courses: [], progress: {}, summary: {} }));
  let service, gate, entered;
  const disposed = [];
  const open = async options => {
    if (!options.cookies) throw new Error('LOGIN_REQUIRED');
    const value = options.cookies.cookies[0].value;
    if (value === 'invalid') throw new Error('LOGIN_REQUIRED');
    return { origin, userScope: value, saveSession: async () => writeFile(authFile, value),
      close: async options => disposed.push(options), courses: async () => [] };
  };
  const moodle = await openConnection({ root, origin, authFile, open });
  const cookies = value => [{ name: 'MoodleSession', value, domain: 'moodle.example', httpOnly: true, secure: true }];
  try {
    service = await openService({ root, moodle, store: {}, scan: async () => {
      entered?.(); await gate;
      return { schemaVersion: 1, origin, userScope: moodle.userScope, courses: [], progress: {}, summary: {} };
    }, runner: async () => ({ percent: 100 }) });
    await assert.rejects(service.session(undefined), /INVALID_COOKIE_FILE/);
    await assert.rejects(service.session(cookies('invalid')), /LOGIN_REQUIRED/);
    assert.equal(service.state().authRequired, true);
    await service.session(cookies('42'));
    assert.equal(service.state().authRequired, false);
    await service.start({ requestId: 'account-42-request-1234', quizIds: ['20'], maxAttempts: 1, userScope: '42' });
    while (service.state().jobs[0].status !== 'complete') await new Promise(done => setTimeout(done, 5));
    await service.session(cookies('43'));
    assert.equal(service.state().userScope, '43');
    assert.equal(service.state().overview, null);
    assert.deepEqual(service.state().jobs, []);
    await service.close();
    service = await openService({ root, moodle, store: {}, scan: async () => {
      entered?.(); await gate;
      return { schemaVersion: 1, origin, userScope: moodle.userScope, courses: [], progress: {}, summary: {} };
    } });
    assert.equal(service.state().overview, null, 'restart supports a newly connected account before its first scan');
    await service.session(cookies('42'));
    assert.equal(service.state().jobs.length, 1);
    assert.equal(service.state().overview.userScope, '42');
    let release;
    gate = new Promise(done => { release = done; });
    const scanning = new Promise(done => { entered = done; });
    const task = service.refresh(); await scanning;
    await assert.rejects(service.session(cookies('43')), /SESSION_BUSY/);
    assert.equal(service.state().userScope, '42');
    release(); await task;
    assert.ok(disposed.every(options => options.save === false));
  } finally { await service?.close(); await moodle.close(); await rm(root, { recursive: true, force: true }); }
});
