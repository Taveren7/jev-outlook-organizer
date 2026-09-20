import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TYPE_NAMES} from '../../src/outlook-layout';
import {sample} from '../../fixtures/examples';
const token='x'.repeat(40),receivedDateTime=new Date(Date.now()-3600000).toISOString();
const layout={mailboxId:'mailbox',inboxId:'inbox',folders:Object.fromEntries(Object.entries(TYPE_NAMES).map(([k,v])=>[k,{id:k,displayName:v,parentFolderId:'inbox'}]))};
let message:any={id:'test-message','@odata.etag':'v1',parentFolderId:'inbox',categories:['Keep Me'],isRead:false,flag:{flagStatus:'notFlagged'},receivedDateTime,subject:'synthetic',from:{emailAddress:{address:'sample@example.test'}},toRecipients:[],ccRecipients:[],body:{contentType:'text',content:'synthetic receipt'},hasAttachments:false};
let calls=0,writes=0;
const additional:any[]=[];let rejectModel=false;
let modelAnswer=sample('informational','pack_invoice_confirmation','reference',0.01);
const directory=mkdtempSync(join(tmpdir(),'jev-runtime-'));
const options:any={modules:true,scriptPath:'dist/production.js',compatibilityDate:'2026-09-19',durableObjects:{COORDINATOR:{className:'MailboxCoordinator',useSQLite:true}},durableObjectsPersist:directory,bindings:{ADMIN_TOKEN:token,MS_TENANT_ID:'tenant',MS_CLIENT_ID:'client',MS_CLIENT_SECRET:'fake',MS_MAILBOX_ID:'mailbox',TYPESAFE_API_KEY:'fake',MAILBOX_LAYOUT:JSON.stringify(layout)},outboundService:async(request:Request)=>{
 const u=new URL(request.url);
 if(u.hostname==='login.microsoftonline.com')return Response.json({access_token:'fake'});
 if(u.hostname==='api.typesafe.ai'){calls++;if(rejectModel)return new Response('synthetic throttle',{status:429,headers:{'Retry-After':'90'}});return Response.json({model:'test',answers:modelAnswer,usage:{input_tokens:1,output_tokens:0}});}
 if(u.hostname!=='graph.microsoft.com')throw Error('Unexpected network destination');
 if(u.pathname.endsWith('/mailFolders/inbox/messages'))return Response.json({value:[message,...additional]});
 const target=[message,...additional].find(m=>u.pathname.includes('/messages/'+m.id))??message;
 if(request.method==='PATCH'){assert.equal(request.headers.get('if-match'),target['@odata.etag']);assert.deepEqual(Object.keys(await request.clone().json()),['categories']);target.categories=(await request.json() as any).categories;target['@odata.etag']+='x';writes++;return Response.json(target);}
 if(u.pathname.endsWith('/move')){assert.equal(target.parentFolderId,'inbox');target.parentFolderId=(await request.json() as any).destinationId;target['@odata.etag']+='m';writes++;return Response.json(target);}
 const folder=Object.values(layout.folders).find(f=>u.pathname.endsWith('/mailFolders/'+f.id));if(folder)return Response.json(folder);
 if([message,...additional].some(m=>u.pathname.endsWith('/messages/'+m.id)))return Response.json(target);
 throw Error('Unexpected Graph path');
}};
let mf=new Miniflare({...convertV4MiniflareOptions(options),resourcePersistencePath:directory});
const request=async(path:string,body?:unknown)=>{const r=await mf.dispatchFetch('https://service/admin/'+path,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});assert.equal(r.status,200);return r.json() as Promise<any>;};
const until=async(predicate:(s:any)=>boolean)=>{const start=Date.now();let status:any;do{await new Promise(r=>setTimeout(r,50));status=await request('status');}while((status.busy||!predicate(status))&&Date.now()-start<10000);assert.ok(!status.busy&&predicate(status),JSON.stringify(status));return status;};
try{
 assert.equal((await request('status')).paused,true);
 await request('seed',{ids:['previous-review']});
 let scanned=await request('scan',{});assert.equal(scanned.lastError,null,JSON.stringify(scanned));assert.ok(scanned.lastScan>0);assert.equal(writes,0);
 await request('resume',{mode:'observe',dailyLimit:4});await until(s=>s.jobs.some((j:any)=>j.stage==='observed'));await request('pause',{});
 assert.equal(calls,1);assert.equal(writes,0);const jobs=await request('jobs');assert.equal(jobs.find((j:any)=>j.id==='test-message').stage,'observed');
 await request('promote',{id:'test-message',mode:'conservative'});await request('resume',{mode:'conservative',dailyLimit:4});await until(s=>s.jobs.some((j:any)=>j.stage==='done'));await request('pause',{});
 assert.equal(writes,3);assert.deepEqual(message.categories,['Keep Me','FYI','Reference']);assert.equal(message.isRead,false);assert.equal(message.parentFolderId,'pack_invoice_confirmation');
 await mf.dispose();mf=new Miniflare({...convertV4MiniflareOptions(options),resourcePersistencePath:directory});
 const persisted=await request('status');assert.equal(persisted.paused,true);assert.equal(persisted.today.calls,1);assert.ok(persisted.jobs.some((j:any)=>j.stage==='done'&&j.count===1));
 await request('resume',{mode:'conservative',dailyLimit:4});await request('run',{});await request('pause',{});assert.equal(calls,1);assert.equal(writes,3);
 // Two queued messages must finish on autonomous alarms in seconds despite an exhausted normal daily cap.
 additional.push(...['extra-one','extra-two'].map(id=>({...message,id,'@odata.etag':'v1',categories:[],parentFolderId:'inbox'})));
 await request('scan',{});const batch=await request('catchup',{});assert.equal(batch.catchup.messages,2);
 const started=Date.now();await request('resume',{mode:'conservative',dailyLimit:1});
 let accelerated:any;
 do{await new Promise(r=>setTimeout(r,50));accelerated=await request('status');}while(!accelerated.jobs.some((j:any)=>j.stage==='done'&&j.count===3)&&Date.now()-started<10000);
 await request('pause',{});assert.ok(accelerated.jobs.some((j:any)=>j.stage==='done'&&j.count===3),JSON.stringify(accelerated));assert.ok(Date.now()-started<10000);assert.equal(calls,3);assert.equal(accelerated.today.regularCalls,1);assert.equal(accelerated.today.catchupCalls,2);
 // All-Type filing keeps uncertain tasks visible, with flags intact and no duplicate Type badge.
 const task={...message,id:'active-task','@odata.etag':'v1',categories:['Keep Me'],parentFolderId:'inbox',flag:{flagStatus:'flagged'},receivedDateTime:new Date(Date.now()-1).toISOString()};additional.push(task);
 modelAnswer=sample('now','customer_sales','reply',0.98);modelAnswer={...modelAnswer,action:{...modelAnswer.action,confidence:0.5}};
 await request('scan',{});await request('resume',{mode:'type-folders',dailyLimit:100});await until(s=>s.jobs.some((j:any)=>j.stage==='done'&&j.count===4));await request('pause',{});
 assert.equal(task.parentFolderId,'customer_sales');assert.deepEqual(task.categories,['Keep Me','Now','Review','Needs Review','Needs Me']);assert.deepEqual(task.flag,{flagStatus:'flagged'});assert.equal(task.isRead,false);
 // A model rate limit must also stop *other* queued messages and survive an explicit run request.
 additional.push(...['throttle-one','throttle-two'].map(id=>({...message,id,'@odata.etag':'v1',categories:[],parentFolderId:'inbox',receivedDateTime:new Date(Date.now()-1).toISOString()})));
 await request('scan',{});rejectModel=true;await request('resume',{mode:'conservative',dailyLimit:100});
 let cooling:any;const coolingStart=Date.now();do{await new Promise(r=>setTimeout(r,50));cooling=await request('status');}while(!cooling.cooldownUntil&&Date.now()-coolingStart<5000);
 assert.ok(cooling.cooldownUntil>Date.now()+80000,JSON.stringify(cooling));const throttledCalls=calls;await request('run',{});assert.equal(calls,throttledCalls);await request('pause',{});
 console.log('Cloudflare runtime: paused startup, scan, observe, promote, guarded filing, restart persistence, no duplicate processing, continuous catch-up and provider-wide rate-limit cooldown passed (synthetic providers).');
}finally{await mf.dispose();rmSync(directory,{recursive:true,force:true});}
