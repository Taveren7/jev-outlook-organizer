import {Miniflare,convertV4MiniflareOptions} from 'miniflare';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import assert from 'node:assert/strict';
import {TYPE_NAMES} from '../../src/outlook-layout';import {sample} from '../../fixtures/examples';
const directory=mkdtempSync(join(tmpdir(),'jev-resilience-')),token='r'.repeat(40),receivedDateTime=new Date(Date.now()-60000).toISOString();
const layout={mailboxId:'box',inboxId:'inbox',folders:Object.fromEntries(Object.entries(TYPE_NAMES).map(([key,name])=>[key,{id:key,displayName:name,parentFolderId:'inbox'}]))};
const message:any={id:'synthetic-review','@odata.etag':'v1',receivedDateTime,parentFolderId:'inbox',categories:['Personal'],isRead:false,flag:{flagStatus:'notFlagged'},subject:'Synthetic order',from:{emailAddress:{address:'buyer@customer.test'}},toRecipients:[],ccRecipients:[],body:{contentType:'text',content:'Please review this order.'},hasAttachments:false};
message.bodyPreview='Synthetic short preview';message.webLink='https://outlook.office365.com/owa/?ItemID=synthetic';let summaryReads=0,summaryFails=false;
const clear=sample('soon','customer_sales','reply',.95);let answer={...clear,type:{...clear.type,confidence:.5}},calls=0,writes=0;
const options:any={modules:true,scriptPath:'dist/production.js',compatibilityDate:'2026-09-19',durableObjects:{COORDINATOR:{className:'MailboxCoordinator',useSQLite:true}},durableObjectsPersist:directory,bindings:{ADMIN_TOKEN:token,MS_TENANT_ID:'tenant',MS_CLIENT_ID:'client',MS_CLIENT_SECRET:'fake',MS_MAILBOX_ID:'box',TYPESAFE_API_KEY:'fake',MAILBOX_LAYOUT:JSON.stringify(layout),RELATIONSHIP_CONTEXT:JSON.stringify({version:1,domains:{customer:['customer.test']},defaults:{customer:'customer_sales'}}),MS_SECRET_EXPIRES_AT:new Date(Date.now()+7*86400000).toISOString()},outboundService:async(request:Request)=>{
 const u=new URL(request.url);if(u.hostname==='login.microsoftonline.com')return Response.json({access_token:'fake'});
 if(u.hostname==='api.typesafe.ai'){calls++;const input=await request.json() as any;assert.equal(input.state.business_context.sender_relationship,'customer');assert.equal(input.state.business_context.default_type,'customer_sales');if(calls===3)assert.deepEqual(input.state.owner_correction_history.same_sender_corrections,[{type:'supply_chain',count:1}]);else assert.equal(input.state.owner_correction_history,undefined);return Response.json({model:'synthetic',answers:answer,usage:{input_tokens:1,output_tokens:0}});}
 assert.equal(u.hostname,'graph.microsoft.com');if(u.pathname.endsWith('/mailFolders/inbox/messages'))return Response.json({value:message.parentFolderId==='inbox'?[message]:[]});
 if(request.method==='PATCH'){assert.equal(request.headers.get('If-Match'),message['@odata.etag']);const body=await request.json() as any;assert.deepEqual(Object.keys(body),['categories']);message.categories=body.categories;message['@odata.etag']+='p';writes++;return Response.json(message);}
 if(u.pathname.endsWith('/move')){const folder=/\/mailFolders\/([^/]+)\/messages/.exec(u.pathname)?.[1];assert.equal(folder,message.parentFolderId);message.parentFolderId=(await request.json() as any).destinationId;message['@odata.etag']+='m';writes++;return Response.json(message);}
 if(u.pathname.endsWith('/mailFolders/inbox'))return Response.json({id:'inbox',displayName:'Inbox',parentFolderId:'root'});
 const folder=Object.values(layout.folders).find(f=>u.pathname.endsWith('/mailFolders/'+f.id));if(folder)return Response.json(folder);
 if(u.pathname.endsWith('/messages/'+message.id)){if(u.searchParams.get('$select')==='subject,from,bodyPreview'){summaryReads++;assert.equal(request.method,'GET');if(summaryFails)return new Response('Synthetic private provider detail',{status:503});}return Response.json(message);}throw Error('Unexpected synthetic request');
}};
let mf=new Miniflare({...convertV4MiniflareOptions(options),resourcePersistencePath:directory});
const call=async(path:string,body?:unknown,expected=200)=>{const response=await mf.dispatchFetch('https://service/admin/'+path,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+token},...(body===undefined?{}:{body:JSON.stringify(body)})});assert.equal(response.status,expected,await response.clone().text());return response.json() as Promise<any>;};
const until=async()=>{const start=Date.now();let s:any;do{await new Promise(r=>setTimeout(r,50));s=await call('status');}while((s.busy||!s.jobs.some((j:any)=>j.stage==='done'))&&Date.now()-start<10000);assert.ok(!s.busy&&s.jobs.some((j:any)=>j.stage==='done'));};
try{
 assert.equal((await mf.dispatchFetch('https://service/admin/health')).status,401);
 const page=await mf.dispatchFetch('https://service/dashboard');assert.equal(page.status,200);assert.ok(page.headers.get('Content-Security-Policy')?.includes("frame-ancestors 'none'"));assert.ok(!(await page.text()).includes(token));
 await call('scan',{});await call('resume',{mode:'type-folders',dailyLimit:100});await until();await call('pause',{});assert.equal(calls,1);assert.equal(writes,1);assert.equal(message.parentFolderId,'inbox');
 const health=await call('health');assert.ok(health.alerts.some((a:any)=>a.code==='credential_expiring'));
 const anonymous=await mf.dispatchFetch('https://service/admin/review/message?id=synthetic-review');assert.equal(anonymous.status,401);assert.equal(summaryReads,0);
 await call('review?limit=0',undefined,400);await call('review?limit=101',undefined,400);
 const limited=await call('review?limit=1');assert.equal(limited.rows.length,1);assert.equal(limited.next,message.id);assert.equal((await call('review?limit=1&after='+encodeURIComponent(limited.next))).rows.length,0);
 const beforeDisplay=JSON.stringify({jobs:await call('jobs'),audit:await call('audit'),budget:(await call('status')).today,message});
 const summaryResponse=await mf.dispatchFetch('https://service/admin/review/message?id=synthetic-review',{headers:{Authorization:'Bearer '+token}});assert.equal(summaryResponse.headers.get('Cache-Control'),'no-store');
 assert.deepEqual(await summaryResponse.json(),{subject:'Synthetic order',senderName:'',senderAddress:'buyer@customer.test',snippet:'Synthetic short preview'});assert.equal(summaryReads,1);
 assert.deepEqual(await call('review/open?id=synthetic-review'),{url:message.webLink});
 await call('review/message?id=unknown',undefined,404);assert.equal(summaryReads,1);
 summaryFails=true;assert.deepEqual(await call('review/message?id=synthetic-review',undefined,502),{error:'message_summary_unavailable'});summaryFails=false;
 assert.equal(JSON.stringify({jobs:await call('jobs'),audit:await call('audit'),budget:(await call('status')).today,message}),beforeDisplay);assert.equal(calls,1);assert.equal(writes,1);
 const list=await call('review');assert.ok(list.rows[0].reasons.includes('uncertain_type'));answer=clear;
 const preview=await call('review/preview',{id:message.id,operation:'rerun',requestId:'runtime-review-00001'});assert.equal(preview.state,'ready');assert.equal(writes,1);assert.equal(calls,2);assert.equal((await call('status')).today.calls,2);
 await call('review/preview',{id:message.id,operation:'rerun',requestId:'runtime-review-00001'});assert.equal(calls,2);
 await mf.dispose();mf=new Miniflare({...convertV4MiniflareOptions(options),resourcePersistencePath:directory});
 assert.equal((await call('review/ticket?id=runtime-review-00001')).state,'ready');
 assert.equal((await call('review/apply',{ticketId:preview.id})).state,'applied');assert.equal(writes,3);assert.equal(message.parentFolderId,'customer_sales');assert.equal(message.isRead,false);assert.deepEqual(message.flag,{flagStatus:'notFlagged'});
 await call('review/apply',{ticketId:preview.id});assert.equal(writes,3);
 const undo=await call('review/preview',{id:message.id,operation:'undo',requestId:'runtime-review-00002'});assert.equal(undo.state,'ready');
 assert.equal((await call('review/apply',{ticketId:undo.id})).state,'applied');assert.equal(message.parentFolderId,'inbox');assert.equal(writes,5);assert.equal(message.isRead,false);assert.equal(calls,2);
 assert.equal((await call('review/preview',{id:message.id,operation:'undo',requestId:'runtime-review-00003'})).state,'blocked');
 assert.equal((await mf.dispatchFetch('https://service/admin/learning')).status,401);
 assert.ok((await call('review/types')).types.some((t:any)=>t.key==='supply_chain'));
 const manual=await call('review/preview',{id:message.id,operation:'correct',type:'supply_chain',learn:true,requestId:'runtime-correct-0001'});assert.equal(manual.state,'ready');assert.equal(calls,2);assert.equal((await call('learning')).activeCount,0);
 assert.equal((await call('review/apply',{ticketId:manual.id})).state,'applied');assert.equal(message.parentFolderId,'supply_chain');assert.equal((await call('learning')).activeCount,1);assert.equal(calls,2);
 await mf.dispose();mf=new Miniflare({...convertV4MiniflareOptions(options),resourcePersistencePath:directory});assert.equal((await call('learning')).activeCount,1);
 message.id='synthetic-future';message.parentFolderId='inbox';message.categories=['Personal'];message['@odata.etag']='future-v1';
 await call('scan',{});await call('resume',{mode:'type-folders',dailyLimit:100});
 const started=Date.now();let fresh:any;do{await new Promise(r=>setTimeout(r,50));fresh=await call('status');}while((fresh.busy||!fresh.jobs.some((j:any)=>j.stage==='done'&&j.count===2))&&Date.now()-started<10000);
 await call('pause',{});assert.equal(calls,3);assert.equal(message.isRead,false);assert.equal(message.parentFolderId,'customer_sales');
 const learnedJob=(await call('jobs')).find((j:any)=>j.id==='synthetic-future');assert.deepEqual(learnedJob.learningExampleIds,[manual.id]);assert.equal(learnedJob.classification.type.choice,'customer_sales');
 await call('learning/disable',{id:manual.id});assert.equal((await call('learning')).activeCount,0);
 console.log('Resilience runtime passed: authenticated dashboard/health, private relationships, persisted idempotent previews, shared model budget, verified rerun and undo, unread/flag preservation, and no undo replay. Synthetic providers only.');
}finally{await mf.dispose();rmSync(directory,{recursive:true,force:true});}
