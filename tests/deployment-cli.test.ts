import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,copyFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {PROFILE_ID} from '../src/config';
import {TYPE_NAMES} from '../src/outlook-layout';
test('deployment CLI requires a reviewed target and uploads secrets without exposing them',()=>{
 const cwd=mkdtempSync(join(tmpdir(),'jev-deploy-'));
 const mailbox='00000000-0000-0000-0000-000000000003',admin='synthetic-admin-'.repeat(3),key='synthetic-secret-key';
 const url='https://my-organizer.example.workers.dev';
 try{
  mkdirSync(join(cwd,'private'));mkdirSync(join(cwd,'node_modules/wrangler/bin'),{recursive:true});
  copyFileSync('wrangler.jsonc',join(cwd,'wrangler.jsonc'));
  writeFileSync(join(cwd,'private/mailbox-layout.json'),JSON.stringify({profile:PROFILE_ID,layout:{mailboxId:mailbox,inboxId:'inbox',folders:Object.fromEntries(Object.entries(TYPE_NAMES).map(([k,v])=>[k,{id:k,displayName:v,parentFolderId:'inbox'}]))}}));
  // Fake CLI and HTTPS transport. No provider or contributor credentials are used.
  writeFileSync(join(cwd,'node_modules/wrangler/bin/wrangler.js'),`const fs=require('node:fs');const args=process.argv.slice(2);fs.appendFileSync('calls.jsonl',JSON.stringify(args)+'\\n');if(args[0]==='auth')console.log(JSON.stringify({type:'oauth',token:'synthetic-cloudflare-token'}));if(args[0]==='secret'){let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>fs.writeFileSync('uploaded.json',s));}`);
  writeFileSync(join(cwd,'transport.mjs'),`globalThis.fetch=async(input,init)=>{const u=new URL(input);if(u.hostname==='api.cloudflare.com')return Response.json({success:true,result:u.pathname.endsWith('/scripts')?(process.env.FAKE_EXISTS==='1'?[{id:'my-organizer'}]:[]):{subdomain:'example'}});if(u.origin===${JSON.stringify(url)}&&u.pathname==='/admin/status')return Response.json({service:'jev-outlook',policy:'public-v1',paused:process.env.FAKE_RUNNING!=='1',busy:false});throw Error('Unexpected synthetic URL');};`);
  const env={...process.env,MS_TENANT_ID:'00000000-0000-0000-0000-000000000001',MS_CLIENT_ID:'00000000-0000-0000-0000-000000000002',MS_MAILBOX_ID:mailbox,MS_CLIENT_SECRET:key,TYPESAFE_API_KEY:key,ADMIN_TOKEN:admin,CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32),WORKER_NAME:'my-organizer',JEV_SERVICE_URL:''};
  const run=(apply=false,extra:Record<string,string>={})=>spawnSync(process.execPath,['--import',pathToFileURL(join(cwd,'transport.mjs')).href,'--import',pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href,resolve('scripts/setup.ts'),'deploy',...(apply?['--apply']:[])],{cwd,env:{...env,...extra},encoding:'utf8'});
  assert.notEqual(run(true).status,0);
  assert.notEqual(run(false,{FAKE_EXISTS:'1'}).status,0);
  assert.notEqual(run(false,{FAKE_EXISTS:'1',JEV_SERVICE_URL:'https://other.example.workers.dev'}).status,0);
  assert.notEqual(run(false,{FAKE_EXISTS:'1',JEV_SERVICE_URL:url,FAKE_RUNNING:'1'}).status,0);
  assert.ok(!readFileSync(join(cwd,'calls.jsonl'),'utf8').includes('["deploy"'));
  const preview=run();assert.equal(preview.status,0,preview.stderr);
  const applied=run(true);assert.equal(applied.status,0,applied.stderr);
  for(const secret of [key,admin,'synthetic-cloudflare-token'])assert.ok(!(preview.stdout+preview.stderr+applied.stdout+applied.stderr).includes(secret));
  const uploaded=JSON.parse(readFileSync(join(cwd,'uploaded.json'),'utf8'));assert.equal(uploaded.ADMIN_TOKEN,admin);assert.equal(uploaded.MS_MAILBOX_ID,mailbox);
  const calls=readFileSync(join(cwd,'calls.jsonl'),'utf8').trim().split('\n').map(s=>JSON.parse(s));assert.equal(calls.filter(c=>c[0]==='deploy').length,1);assert.equal(calls.filter(c=>c[0]==='secret').length,1);
  const config=JSON.parse(readFileSync(join(cwd,'wrangler.local.jsonc'),'utf8'));assert.equal(config.account_id,env.CLOUDFLARE_ACCOUNT_ID);assert.equal(config.name,env.WORKER_NAME);
 }finally{rmSync(cwd,{recursive:true,force:true});}
});
