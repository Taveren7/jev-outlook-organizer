import {test} from 'node:test';
import assert from 'node:assert/strict';
import {discoverTarget,verifyPaused,verifyDeploymentPlan,serviceUrl,type DeploymentTarget} from '../src/deployment';
const account='a'.repeat(32),token='synthetic-cloudflare-token',admin='synthetic-admin-token';
const target:DeploymentTarget={accountId:account,workerName:'my-organizer',serviceUrl:'https://my-organizer.example.workers.dev',exists:false};
function cloudflare(scripts:unknown,domain:unknown={subdomain:'example'},status=200){
 return (async(input:any,init:any)=>{
  const url=new URL(input);assert.equal(url.origin,'https://api.cloudflare.com');assert.equal(init.redirect,'error');assert.equal(init.headers.Authorization,`Bearer ${token}`);
  assert.equal(init.method,undefined);assert.ok(url.pathname.startsWith(`/client/v4/accounts/${account}/workers/`));
  return Response.json({success:status===200,result:url.pathname.endsWith('/scripts')?scripts:domain},{status});
 }) as typeof fetch;
}
test('deployment discovery binds the exact account, Worker name and workers.dev origin',async()=>{
 assert.deepEqual(await discoverTarget(account,target.workerName,token,cloudflare([])),target);
 assert.equal((await discoverTarget(account,target.workerName,token,cloudflare([{id:target.workerName}]))).exists,true);
 await assert.rejects(()=>discoverTarget('invalid',target.workerName,token,cloudflare([])));
 await assert.rejects(()=>discoverTarget(account,target.workerName,token,cloudflare([],{},403)));
 await assert.rejects(()=>discoverTarget(account,target.workerName,token,cloudflare([{name:target.workerName}])));
 await assert.rejects(()=>discoverTarget(account,target.workerName,token,cloudflare([],{subdomain:'example/redirect'})));
});
test('existing Worker cannot be treated as a first deployment or checked through another service',async()=>{
 const existing={...target,exists:true};let calls=0;
 const paused=(async(input:any,init:any)=>{calls++;assert.equal(String(input),target.serviceUrl+'/admin/status');assert.equal(init.headers.Authorization,`Bearer ${admin}`);assert.equal(init.redirect,'error');return Response.json({service:'jev-outlook',policy:'public-v1',paused:true,busy:false});}) as typeof fetch;
 await verifyPaused(target,undefined,admin,paused);assert.equal(calls,0);
 await assert.rejects(()=>verifyPaused(existing,undefined,admin,paused));
 await assert.rejects(()=>verifyPaused(existing,'https://other.example.workers.dev',admin,paused));
 await assert.rejects(()=>verifyPaused(existing,'https://my-organizer.other.workers.dev',admin,paused));assert.equal(calls,0);
 await verifyPaused(existing,target.serviceUrl+'/',admin,paused);assert.equal(calls,1);
 for(const body of [{service:'jev-outlook',policy:'public-v1',paused:false,busy:false},{service:'jev-outlook',policy:'public-v1',paused:true,busy:true},{paused:true,busy:false},{service:'jev-outlook',policy:'private-v1',paused:true,busy:false}]){
  await assert.rejects(()=>verifyPaused(existing,target.serviceUrl,admin,(async()=>Response.json(body)) as typeof fetch));
 }
 await assert.rejects(()=>verifyPaused(existing,target.serviceUrl,admin,(async()=>new Response('',{status:401})) as typeof fetch));
});
test('deployment plan expires and rejects a changed account, target, profile or layout',()=>{
 const plan={target,profile:'profile',layout:'layout',createdAt:1000};
 verifyDeploymentPlan(plan,target,'profile','layout',2000);
 for(const changed of [{...target,exists:true},{...target,accountId:'b'.repeat(32)},{...target,workerName:'different'}])assert.throws(()=>verifyDeploymentPlan(plan,changed,'profile','layout',2000));
 assert.throws(()=>verifyDeploymentPlan(plan,target,'changed','layout',2000));
 assert.throws(()=>verifyDeploymentPlan(plan,target,'profile','changed',2000));
 assert.throws(()=>verifyDeploymentPlan(plan,target,'profile','layout',3601001));
 assert.throws(()=>verifyDeploymentPlan(plan,target,'profile','layout',999));
});
test('administration URL rejects lookalike domains, preview hosts, paths and credentials',()=>{
 for(const url of ['http://my-organizer.example.workers.dev','https://my-organizer.example.workers.dev.evil.test','https://example.workers.dev','https://preview.my-organizer.example.workers.dev','https://my-organizer.example.workers.dev/admin','https://my-organizer.example.workers.dev?token=x','https://my-organizer.example.workers.dev#x','https://user@my-organizer.example.workers.dev','https://my-organizer.example.workers.dev:8443'])assert.throws(()=>serviceUrl(url));
 assert.equal(serviceUrl(target.serviceUrl).origin,target.serviceUrl);
});
