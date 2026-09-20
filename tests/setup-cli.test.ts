import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,copyFileSync,readFileSync,statSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import {spawnSync} from 'node:child_process';
test('local onboarding creates an ignored private credential file without echoing or replacing credentials',()=>{
 const cwd=mkdtempSync(join(tmpdir(),'jev-setup-'));
 try{
  copyFileSync('.env.example',join(cwd,'.env.example'));
  const run=()=>spawnSync(process.execPath,[resolve('node_modules/tsx/dist/cli.mjs'),resolve('scripts/setup.ts'),'init'],{cwd,encoding:'utf8'});
  const first=run();assert.equal(first.status,0,first.stderr);const saved=readFileSync(join(cwd,'.env'),'utf8');const token=/^ADMIN_TOKEN=(.+)$/m.exec(saved)?.[1];assert.ok(token&&token.length===64);assert.ok(!first.stdout.includes(token));assert.match(saved,/^MS_CLIENT_SECRET=$/m);
  if(process.platform!=='win32')assert.equal(statSync(join(cwd,'.env')).mode&0o777,0o600);
  const second=run();assert.equal(second.status,0,second.stderr);assert.equal(readFileSync(join(cwd,'.env'),'utf8'),saved);assert.ok(!second.stdout.includes(token));
 }finally{rmSync(cwd,{recursive:true,force:true});}
});
