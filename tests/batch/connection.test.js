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
