import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {sample} from '../fixtures/examples';
import {TYPE_NAMES} from '../src/outlook-layout';
import {routingPlan,applyJob,validateLayout,withinWindow,type Layout,type Metadata,type Job,type MailAdapter} from '../src/production/core';
import {Ledger} from '../src/production/store';
import worker from '../src/production';
import {MailboxCoordinator,type ProductionEnv} from '../src/production/coordinator';

const now=Date.parse('2026-09-20T17:00:00Z');
const layout:Layout={mailboxId:'box',inboxId:'inbox',folders:Object.fromEntries(Object.entries(TYPE_NAMES).map(([k,v])=>[k,{id:k,displayName:v,parentFolderId:'inbox'}])) as Layout['folders']};
const before:Metadata={id:'message','@odata.etag':'v1',isRead:false,categories:['Personal'],flag:{flagStatus:'notFlagged'},parentFolderId:'inbox',receivedDateTime:new Date(now-3600_000).toISOString()};
function fixture(){
  let state=structuredClone(before),saved:Job|undefined;const effects:string[]=[];
  const mail:MailAdapter={metadata:async()=>structuredClone(state),folder:async id=>structuredClone(layout.folders[id as keyof typeof TYPE_NAMES]!),categories:async(_id,cats,etag)=>{assert.equal(etag,state['@odata.etag']);effects.push('patch');state={...state,categories:cats,'@odata.etag':state['@odata.etag']+'x'};},move:async(_id,source,dest)=>{assert.equal(source,state.parentFolderId);effects.push('move');state={...state,parentFolderId:dest,'@odata.etag':'moved'};}};
  const job:Job={id:before.id,receivedAt:before.receivedDateTime,stage:'planned',attempts:1,due:0,updatedAt:now,plan:routingPlan(before,sample('informational','pack_invoice_confirmation','reference',0.01),[],layout,'conservative',now)};
  return {mail,job,effects,state:()=>state,change:(patch:Partial<Metadata>)=>{state={...state,...patch};},save:async(j:Job)=>{saved=structuredClone(j);},saved:()=>saved!};
}
test('routine filing removes only duplicate Type, preserving read state, flags and unrelated categories',async()=>{
  const f=fixture(),done=await applyJob(f.job,f.mail,f.save,()=>true,()=>now);
  assert.equal(done.stage,'done');assert.deepEqual(f.effects,['patch','move','patch']);
  assert.deepEqual(f.state().categories,['Personal','FYI','Reference']);assert.equal(f.state().isRead,false);assert.equal(f.state().parentFolderId,'pack_invoice_confirmation');
});
test('type-folder mode routes all ten clear Types independently of uncertain task decisions',()=>{
  for(const type of Object.keys(TYPE_NAMES) as Array<keyof typeof TYPE_NAMES>){
    const base=sample('soon',type,'reply',0.5,0.3);const c={...base,attention:{...base.attention,confidence:0.5},action:{...base.action,confidence:0.5}};
    const plan=routingPlan(before,c,['Attachments not analyzed'],layout,'type-folders',now);
    assert.equal(plan.destination?.id,type);assert.deepEqual(plan.categories,plan.finalCategories);assert.ok(!plan.categories.includes(TYPE_NAMES[type]!));assert.deepEqual(plan.finalCategories,['Personal','Soon','Review','Needs Review']);
  }
});
test('clear urgent requests and flags remain visible in their Type folder',()=>{
  const flagged={...before,flag:{flagStatus:'flagged',dueDateTime:{dateTime:'2026-09-21T00:00:00',timeZone:'UTC'}}};
  const plan=routingPlan(flagged,sample('now','customer_sales','reply',0.98),['Attachments not analyzed'],layout,'type-folders',now);
  assert.equal(plan.destination?.id,'customer_sales');assert.deepEqual(plan.finalCategories,['Personal','Now','Reply','Needs Review','Needs Me']);assert.deepEqual(plan.before.flag,flagged.flag);
});
test('unclear Type, high risk and truncated input still block Type filing',()=>{
  for(const change of ['confidence','probability','security','truncated']){
    let c=sample('informational','automated','reference',0.01);
    if(change==='confidence')c={...c,type:{...c.type,confidence:0.79}};
    if(change==='probability')c={...c,type:{...c.type,probabilities:Object.fromEntries(Object.keys(TYPE_NAMES).map(key=>[key,key==='automated'?0.79:0.21/9])) as typeof c.type.probabilities}};
    if(change==='security')c={...c,security_risk:{...c.security_risk,noul:0.7}};
    const plan=routingPlan(before,c,change==='truncated'?['body truncated']:[],layout,'type-folders',now);
    assert.equal(plan.destination,null);
    if(['confidence','probability'].includes(change))assert.ok(!plan.categories.includes('Automated'));
  }
});
test('uncertainty, attachments, human requests and flagged tasks stay in Inbox as to-dos',()=>{
  for(const [c,limitations,state] of [[sample('none','automated','archive',0.4),[],before],[sample('none','automated','archive',0),['attachments'],before],[sample('none','automated','archive',0),[],{...before,flag:{flagStatus:'flagged'}}]] as const){
    const p=routingPlan(state,c,[...limitations],layout,'conservative',now);assert.equal(p.destination,null);assert.ok(p.categories.includes('Soon'));assert.ok(p.categories.includes('Needs Review'));assert.ok(!p.categories.includes('Automated'));
  }
  const p=routingPlan(before,sample('soon','customer_sales','reply',0.98),[],layout,'conservative',now);assert.equal(p.destination,null);assert.ok(p.categories.includes('Reply'));
  const human=routingPlan(before,sample('informational','supply_chain','reference',0.01),[],layout,'conservative',now);assert.equal(human.destination,null);
});
test('security hold remains visible, invalid classifications fail closed, completed and old messages are protected',()=>{
  const p=routingPlan(before,sample('none','automated','archive',0.01,0.95),[],layout,'conservative',now);assert.ok(p.categories.includes('Security Review'));assert.ok(p.categories.includes('Needs Review'));assert.equal(p.destination,null);
  assert.throws(()=>routingPlan(before,{},[],layout,'conservative',now));
  for(const patch of [{flag:{flagStatus:'complete'}},{categories:['Soon']},{parentFolderId:'old'},{receivedDateTime:'2026-01-01'}] as Partial<Metadata>[]){assert.throws(()=>routingPlan({...before,...patch},sample('none','automated','archive',0),[],layout,'conservative',now));}
  assert.equal(withinWindow(new Date(now+1).toISOString(),now),false);
  assert.throws(()=>validateLayout(JSON.stringify({...layout,mailboxId:'wrong'}),'box'));
});
test('fresh user edits or a pause prevent writes',async()=>{
  for(const patch of [{isRead:true},{flag:{flagStatus:'complete'}},{categories:['Corrected']},{parentFolderId:'another'},{'@odata.etag':'edited'}] as Partial<Metadata>[]){const f=fixture();f.change(patch);assert.equal((await applyJob(f.job,f.mail,f.save,()=>true,()=>now)).stage,'held');assert.deepEqual(f.effects,[]);}
  const f=fixture();await assert.rejects(applyJob(f.job,f.mail,f.save,()=>false,()=>now),/paused/);assert.deepEqual(f.effects,[]);
});
test('lost move response is reconciled without a duplicate move',async()=>{
  const f=fixture(),move=f.mail.move;f.mail.move=async(...args)=>{await move(...args);throw Error('lost response');};
  await assert.rejects(applyJob(f.job,f.mail,f.save,()=>true,()=>now));assert.equal(f.saved().stage,'moving');
  const done=await applyJob(f.saved(),f.mail,f.save,()=>true,()=>now);assert.equal(done.stage,'done');assert.equal(f.effects.filter(x=>x==='move').length,1);
});
test('uncertain move with no observable effect is held rather than retried',async()=>{
  const f=fixture();f.mail.move=async()=>{throw Error('lost response');};await assert.rejects(applyJob(f.job,f.mail,f.save,()=>true,()=>now));
  assert.equal((await applyJob(f.saved(),f.mail,f.save,()=>true,()=>now)).stage,'held');assert.deepEqual(f.effects,['patch']);
});
test('lost category response recovers, but a subsequent manual change stops recovery',async()=>{
  const f=fixture(),patch=f.mail.categories;f.mail.categories=async(...args)=>{await patch(...args);throw Error('lost response');};await assert.rejects(applyJob(f.job,f.mail,f.save,()=>true,()=>now));assert.equal(f.saved().stage,'patching');
  f.change({categories:['My correction']});assert.equal((await applyJob(f.saved(),f.mail,f.save,()=>true,()=>now)).stage,'held');assert.equal(f.effects.length,1);
});
test('ledger persists reservations, prioritizes new mail and reserves capacity against backfill',()=>{
  const db=new DatabaseSync(':memory:');const sql={exec:(query:string,...args:any[])=>({toArray:()=>{const s=db.prepare(query);return s.columns().length?s.all(...args):(s.run(...args),[]);}})};
  // Cloudflare exec executes immediately, including statements whose results are not consumed.
  const immediate={exec:(query:string,...args:any[])=>{const rows=sql.exec(query,...args).toArray();return {toArray:()=>rows};}};
  const ledger=new Ledger(immediate);const old={...fixture().job,stage:'pending' as const,receivedAt:new Date(now-1000).toISOString()};ledger.save(old);ledger.save({...old,id:'new',receivedAt:new Date(now+1000).toISOString()});
  assert.equal(ledger.next(now,now,4)?.id,'new');assert.equal(ledger.reserve(now,true,4),true);assert.equal(ledger.reserve(now,true,4),true);assert.equal(ledger.reserve(now,true,4),false);
  const reopened=new Ledger(immediate);assert.equal(reopened.budget(now).calls,2);assert.equal(reopened.reserve(now,false,4),true);assert.equal(reopened.reserve(now,false,4),true);assert.equal(reopened.reserve(now,false,4),false);assert.equal(reopened.next(now,now,4),undefined);
  assert.equal(reopened.reserve(now+86400_000,false,4),true);db.close();
});
test('production administration requires a bearer secret and public health exposes no configuration',async()=>{
  const env={ADMIN_TOKEN:'a'.repeat(40)} as ProductionEnv;
  const denied=await worker.fetch(new Request('https://worker/admin/resume',{method:'POST'}),env);assert.equal(denied.status,401);
  const health=await worker.fetch(new Request('https://worker/health'),env);assert.deepEqual(await health.json(),{service:'jev-outlook',version:1});
});

test('one-time catch-up bypasses daily pacing without spending capacity reserved for future arrivals',()=>{
  const db=new DatabaseSync(':memory:');const sql={exec:(query:string,...args:any[])=>{const statement=db.prepare(query);const rows=statement.columns().length?statement.all(...args):(statement.run(...args),[]);return {toArray:()=>rows};}};
  const ledger=new Ledger(sql),job={...fixture().job,stage:'pending' as const};ledger.save(job);
  assert.equal(ledger.reserve(now,true,1),true);assert.equal(ledger.next(now,now,1),undefined);
  const catchup=ledger.startCatchup(now);assert.equal(catchup.messages,1);assert.equal(catchup.allowance,2);
  assert.equal(ledger.next(now,now,1)?.id,job.id);
  assert.equal(ledger.reserve(now,true,1,job.receivedAt),true);
  const reopened=new Ledger(sql);assert.equal(reopened.startCatchup(now+100).remaining,1);
  assert.equal(reopened.reserve(now,true,1,job.receivedAt),true);
  assert.equal(reopened.reserve(now,true,1,job.receivedAt),false);
  assert.equal(reopened.budget(now).regularCalls,1);assert.equal(reopened.budget(now).catchupCalls,2);
  assert.equal(reopened.reserve(now+86400_000,false,1,new Date(now+86400_000).toISOString()),true);
  reopened.save({...job,stage:'done'});reopened.finishCatchup(now+1000);assert.ok(reopened.get<any>('catchup',null).completedAt);db.close();
});

test('owner action indicator has an inclusive threshold independent of urgency and keeps filing holds',()=>{
 for(const score of [.899,.9,1]){
  const c=sample('informational','customer_sales','reference',score);
  const plan=routingPlan(before,c,[],layout,'type-folders',now);
  assert.equal(plan.finalCategories.includes('Needs Me'),score>=.9);
  assert.deepEqual(plan.before,before);
 }
 const held=routingPlan(before,sample('now','customer_sales','reply',.99,.8),['body truncated'],layout,'type-folders',now);
 assert.equal(held.destination,null);assert.ok(held.categories.includes('Needs Me'));assert.ok(held.categories.includes('Security Review'));
 for(const state of [{...before,flag:{flagStatus:'complete'}},{...before,categories:['Needs Me']}])assert.throws(()=>routingPlan(state,sample('now','customer_sales','reply',1),[],layout,'type-folders',now),/state_protected/);
});
