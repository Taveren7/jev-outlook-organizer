import {test} from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';
import {parseRelationships,relationshipContext} from '../src/relationships';import {healthReport} from '../src/production/health';
import {previewReview,applyReview,type ReviewContext} from '../src/production/review';import {Ledger} from '../src/production/store';
import {routingPlan,applyJob,type Job,type Layout,type Metadata} from '../src/production/core';import {TYPE_NAMES} from '../src/outlook-layout';import {sample} from '../fixtures/examples';
const now=Date.parse('2026-09-20T18:00:00Z'),types=Object.keys(TYPE_NAMES);
const mailInput={id:'m',subject:'Synthetic',from:'Buyer@CUSTOMER.test',to:['owner@internal.test'],cc:[],bodyText:'Please review our order.',hasAttachments:false,receivedAt:new Date(now-1000).toISOString()};
test('relationship rules are private exact matches with sender exceptions and validated custom Types',()=>{
 const raw=JSON.stringify({version:1,domains:{customer:['customer.test'],supplier:['supplier.test'],internal:['internal.test']},defaults:{customer:'projects',supplier:'purchases'},senders:[{address:'buyer@customer.test',relationship:'supplier'}]});
 const config=parseRelationships(raw,['projects','purchases'])!;assert.equal(relationshipContext(mailInput,config).sender_relationship,'supplier');
 assert.equal(relationshipContext({...mailInput,from:'someone@customer.test'},config).default_type,'projects');
 for(const address of ['a@customer.test.evil.test','a@sub.customer.test','Customer.test <a@evil.test>'])assert.equal(relationshipContext({...mailInput,from:address},config).sender_relationship,'unknown');
 assert.equal(parseRelationships(undefined,types),undefined);
 for(const c of [{version:1,domains:{customer:['customer.test'],supplier:['customer.test']},defaults:{}},{version:1,domains:{customer:['@customer.test']},defaults:{}},{version:1,domains:{},defaults:{customer:'missing'}},{version:1,domains:[],defaults:{}},{version:1,domains:{customer:['bad..test']},defaults:{}}])assert.throws(()=>parseRelationships(JSON.stringify(c),types));
});
test('health keeps unresolved jobs visible after a successful scan clears lastError',()=>{
 const h=healthReport({now,paused:false,lastScan:now,lastSuccess:now,dailyLimit:100,used:100,cooldownUntil:0,lastError:null,secretExpiresAt:new Date(now+7*86400000).toISOString(),counts:[{stage:'failed',count:2},{stage:'pending',count:3}],issues:[{code:'graph_403',count:2}],oldestPending:now-7200000});
 assert.equal(h.state,'needs_attention');assert.ok(h.alerts.some(x=>x.code==='unresolved_jobs'));assert.ok(h.alerts.some(x=>x.code==='regular_budget_exhausted'));assert.ok(h.alerts.some(x=>x.code==='credential_expiring'));assert.equal(h.unresolvedErrors[0]?.code,'graph_403');
});
function fixture(){
 const db=new DatabaseSync(':memory:');const sql={exec:(q:string,...args:any[])=>{const rows=db.prepare(q).all(...args);return {toArray:()=>rows};}};const ledger=new Ledger(sql);
 const layout:Layout={mailboxId:'box',inboxId:'inbox',folders:Object.fromEntries(Object.entries(TYPE_NAMES).map(([k,v])=>[k,{id:k,displayName:v,parentFolderId:'inbox'}])) as Layout['folders']};
 const initial:Metadata={id:'m','@odata.etag':'v1',parentFolderId:'inbox',isRead:false,categories:['Personal'],flag:{flagStatus:'flagged'},receivedDateTime:new Date(now-1000).toISOString()};
 let state=structuredClone(initial),paused=true,reservations=0,calls=0,changed=false;const effects:string[]=[];
 const answer=sample('soon','customer_sales','reply',.8),uncertain={...answer,type:{...answer.type,confidence:.5}};
 const plan=routingPlan(initial,uncertain,[],layout,'type-folders',now);state={...state,categories:plan.categories,'@odata.etag':'v2'};
 const source:Job={id:'m',receivedAt:initial.receivedDateTime,stage:'done',attempts:1,due:now,updatedAt:now,classification:uncertain,limitations:[],plan,after:structuredClone(state)};ledger.save(source);
 const mail:any={metadata:async()=>structuredClone(state),content:async()=>({metadata:structuredClone(state),message:mailInput}),folder:async(id:string)=>id==='inbox'?{id:'inbox',displayName:'Inbox',parentFolderId:'root'}:layout.folders[id as keyof typeof TYPE_NAMES],categories:async(_id:string,categories:string[],etag:string)=>{assert.equal(etag,state['@odata.etag']);effects.push('patch');state={...state,categories,'@odata.etag':state['@odata.etag']+'p'};},move:async(_id:string,from:string,to:string)=>{assert.equal(state.parentFolderId,from);effects.push('move');state={...state,parentFolderId:to,'@odata.etag':state['@odata.etag']+'m'};}};
 const context:ReviewContext={ledger,mail,layout,revision:'revision1',policyVersion:'test',securityHold:.7,now:()=>now,paused:()=>paused,reserve:()=>{reservations++;return true;},classify:async()=>{calls++;if(changed)state.categories=['Manual correction'];return {classification:answer,limitations:[],model:'synthetic'};},save:async j=>{ledger.save(j);}};
 return {context,ledger,mail,effects,source,state:()=>state,setState:(patch:Partial<Metadata>)=>{state={...state,...patch};},pause:(v:boolean)=>{paused=v;},changeDuringModel:()=>{changed=true;},calls:()=>calls,reservations:()=>reservations};
}
const request=(operation='rerun',requestId='synthetic-request-0001')=>({id:'m',operation,requestId});
test('rerun preview is billable once, writes nothing, then applies once with preserved manual state',async()=>{
 const f=fixture(),ticket=await previewReview(f.context,request());assert.equal(ticket.state,'ready');assert.equal(f.calls(),1);assert.equal(f.reservations(),1);assert.deepEqual(f.effects,[]);
 assert.equal((await previewReview(f.context,request())).id,ticket.id);assert.equal(f.calls(),1);
 const done=await applyReview(f.context,ticket.id);assert.equal(done.state,'applied');assert.deepEqual(f.effects,['patch','move']);assert.equal(f.state().isRead,false);assert.equal(f.state().flag.flagStatus,'flagged');assert.equal(f.state().parentFolderId,'customer_sales');
 assert.equal((await applyReview(f.context,ticket.id)).state,'applied');assert.equal(f.effects.length,2);assert.equal(f.ledger.job('m')?.reviewId,ticket.id);
 const undo=await previewReview(f.context,request('undo','synthetic-request-0002'));assert.equal(undo.state,'ready');assert.equal((await applyReview(f.context,undo.id)).state,'applied');assert.equal(f.state().parentFolderId,'inbox');assert.deepEqual(f.state().categories,f.source.after!.categories);assert.equal(f.state().isRead,false);
});
test('manual changes, completed flags, stale configuration, old previews and pause protect reruns',async()=>{
 for(const patch of [{categories:['Manual']},{isRead:true},{flag:{flagStatus:'complete'}},{parentFolderId:'elsewhere'}]){const f=fixture();f.setState(patch);const p=await previewReview(f.context,request());assert.equal(p.state,'blocked');assert.equal(f.calls(),0);}
 for(const mutation of ['revision','expired','state','source','etag']){const f=fixture(),p=await previewReview(f.context,request());if(mutation==='revision')f.context.revision='new';if(mutation==='expired')f.context.now=()=>now+3600001;if(mutation==='state')f.setState({categories:['Edited']});if(mutation==='etag')f.setState({'@odata.etag':'changed-during-review'});if(mutation==='source')f.ledger.save({...f.source,updatedAt:now+1});await assert.rejects(applyReview(f.context,p.id));assert.equal(f.effects.length,0);}
 const f=fixture();f.pause(false);await assert.rejects(previewReview(f.context,request()));assert.equal(f.calls(),0);
});
test('truncation/security/protected records cannot be rerun and changed model inputs never apply',async()=>{
 for(const modify of [(j:Job)=>({...j,limitations:['body truncated']}),(j:Job)=>({...j,classification:{...j.classification!,security_risk:{type:'noul' as const,noul:.8}}}),(j:Job)=>({...j,stage:'protected' as const})]){const f=fixture();f.ledger.save(modify(f.source));assert.equal((await previewReview(f.context,request())).state,'blocked');assert.equal(f.calls(),0);}
 const f=fixture();f.changeDuringModel();assert.equal((await previewReview(f.context,request())).state,'blocked');assert.equal(f.effects.length,0);
});
test('budget denial does not call model; unsuccessful previews remain idempotent',async()=>{
 const f=fixture();f.context.reserve=()=>false;const p=await previewReview(f.context,request());assert.equal(p.error,'review_budget_exhausted');assert.equal(f.calls(),0);await previewReview(f.context,request());assert.equal(f.calls(),0);
});
test('lost move responses recover by reading state, never by replaying the move',async()=>{
 const f=fixture(),p=await previewReview(f.context,request()),move=f.mail.move;f.mail.move=async(...args:any[])=>{await move(...args);throw Error('Lost response');};
 assert.equal((await applyReview(f.context,p.id)).state,'recovery_required');assert.equal(f.ledger.job('m')?.stage,'moving');await applyReview(f.context,p.id);assert.equal(f.effects.filter(x=>x==='move').length,1);
 const done=await applyJob(f.ledger.job('m')!,f.mail,f.context.save,()=>true,()=>now);assert.equal(done.stage,'done');assert.equal(f.effects.filter(x=>x==='move').length,1);
});
test('retry requires a failed unmodified unclassified message and only queues bounded work',async()=>{
 const f=fixture();f.setState({categories:['Personal']});f.ledger.save({id:'m',stage:'failed',receivedAt:f.state().receivedDateTime,attempts:3,due:now,updatedAt:now,error:'processing_failed'});
 const p=await previewReview(f.context,request('retry'));assert.equal(p.state,'ready');assert.equal((await applyReview(f.context,p.id)).state,'queued');assert.equal(f.ledger.job('m')?.attempts,0);assert.equal(f.ledger.job('m')?.stage,'pending');assert.equal(f.calls(),0);assert.equal(f.effects.length,0);
});
test('provider extension fields do not enter persisted classifications',async()=>{
 const {parseClassification}=await import('../src/taxonomy');const input={...sample('soon','customer_sales','reply',.8),unexpected:'synthetic private text'};const result=parseClassification(input);assert.ok(!('unexpected' in result));
});
