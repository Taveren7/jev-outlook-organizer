import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,cpSync,writeFileSync,symlinkSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import assert from 'node:assert/strict';
import {CONFIG} from '../../src/config';import {sample} from '../../fixtures/examples';
const directory=mkdtempSync(join(tmpdir(),'jev-custom-profile-'));let mf:Miniflare|undefined;
try{
 cpSync('src',join(directory,'src'),{recursive:true});symlinkSync(resolve('node_modules'),join(directory,'node_modules'),process.platform==='win32'?'junction':'dir');
 const config=structuredClone(CONFIG);config.ownerContext='Project coordinator';config.actionIndicator={name:'My Follow-up',color:'preset2',threshold:.95};config.timeZone='Asia/Tokyo';config.types={projects:{description:'Project deliveries and milestones.',folder:'My Projects',color:'preset4',routine:false},receipts:{description:'Purchase receipts.',folder:'Purchase Records',color:'preset7',routine:true}};config.attention.now.name='Urgent';config.actions.reply.name='Respond';config.review.needsReview.name='Check This';
 writeFileSync(join(directory,'organizer.config.json'),JSON.stringify(config));
 const wrangler=JSON.parse(readFileSync('wrangler.jsonc','utf8'));writeFileSync(join(directory,'wrangler.jsonc'),JSON.stringify(wrangler));
 const bundle=()=>{const result=spawnSync(process.execPath,[resolve('node_modules/wrangler/bin/wrangler.js'),'deploy','--dry-run','--outdir','dist'],{cwd:directory,encoding:'utf8'});assert.equal(result.status,0,result.stderr);};
 bundle();const script=join(directory,'dist/production.js');
 const imported=spawnSync(process.execPath,['--input-type=module','-e','await import('+JSON.stringify('file://'+script)+')'],{encoding:'utf8'});assert.equal(imported.status,0,imported.stderr);
 const token='z'.repeat(40),receivedDateTime=new Date(Date.now()-1000).toISOString();
 const message:any={id:'custom-test','@odata.etag':'v1',receivedDateTime,parentFolderId:'inbox',categories:['Personal'],flag:{flagStatus:'notFlagged'},isRead:false,subject:'Synthetic milestone',from:{emailAddress:{address:'sender@example.test'}},toRecipients:[],ccRecipients:[],body:{contentType:'text',content:'Please respond immediately about the delivery milestone.'},hasAttachments:true};
 const layout={mailboxId:'box',inboxId:'inbox',folders:{projects:{id:'projects-folder',displayName:'My Projects',parentFolderId:'inbox'},receipts:{id:'receipts-folder',displayName:'Purchase Records',parentFolderId:'inbox'}}};
 let modelCalls=0;const effects:string[]=[];
 const options:any={rootPath:directory,modulesRoot:directory,modules:true,scriptPath:script,compatibilityDate:'2026-09-19',durableObjects:{COORDINATOR:{className:'MailboxCoordinator',useSQLite:true}},durableObjectsPersist:join(directory,'state'),bindings:{ADMIN_TOKEN:token,MS_TENANT_ID:'tenant',MS_CLIENT_ID:'client',MS_CLIENT_SECRET:'fake',MS_MAILBOX_ID:'box',TYPESAFE_API_KEY:'fake',MAILBOX_LAYOUT:JSON.stringify(layout)},outboundService:async(request:Request)=>{
  const u=new URL(request.url);if(u.hostname==='login.microsoftonline.com')return Response.json({access_token:'fake'});
  if(u.hostname==='api.typesafe.ai'){const payload=await request.json() as any;assert.equal(payload.state.reviewer,'Project coordinator');assert.ok(JSON.stringify(payload.questions.type).includes('projects'));assert.ok(!JSON.stringify(payload.questions.type).includes('internal_maintenance'));modelCalls++;return Response.json({model:'synthetic',answers:{...sample('now','other','reply',.99),type:{type:'choice',choice:'projects',confidence:.99,probabilities:{projects:.99,receipts:.01}}},usage:{input_tokens:1,output_tokens:0}});}
  assert.equal(u.hostname,'graph.microsoft.com');
  if(u.pathname.endsWith('/mailFolders/inbox/messages'))return Response.json({value:[message]});
  if(request.method==='PATCH'){assert.equal(request.headers.get('If-Match'),message['@odata.etag']);message.categories=(await request.json() as any).categories;message['@odata.etag']+='p';effects.push('categories');return Response.json(message);}
  if(u.pathname.endsWith('/move')){const destination=(await request.json() as any).destinationId;assert.ok(['projects-folder','receipts-folder'].includes(destination));message.parentFolderId=destination;message['@odata.etag']+='m';effects.push('move');return Response.json(message);}
  if(u.pathname.endsWith('/mailFolders/receipts-folder'))return Response.json(layout.folders.receipts);
  if(u.pathname.endsWith('/mailFolders/projects-folder'))return Response.json(layout.folders.projects);
  if(u.pathname.endsWith('/messages/custom-test'))return Response.json(message);throw Error('Unexpected path');
 }};
 mf=new Miniflare({...convertV4MiniflareOptions(options),resourcePersistencePath:join(directory,'state')});
 const admin=async(path:string,body?:unknown)=>{const r=await mf!.dispatchFetch('https://worker/admin/'+path,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+token},...(body===undefined?{}:{body:JSON.stringify(body)})});assert.equal(r.status,200);return r.json() as Promise<any>;};
 assert.equal((await admin('status')).paused,true);await admin('scan',{});await admin('resume',{mode:'type-folders',dailyLimit:5});
 const started=Date.now();let status:any;do{await new Promise(r=>setTimeout(r,50));status=await admin('status');}while((status.busy||!status.jobs.some((j:any)=>j.stage==='done'))&&Date.now()-started<10000);
 await admin('pause',{});assert.ok(status.jobs.some((j:any)=>j.stage==='done'),JSON.stringify(status));
 assert.equal(modelCalls,1);assert.equal(message.parentFolderId,'projects-folder');assert.deepEqual(message.categories,['Personal','Urgent','Respond','Check This','My Follow-up']);assert.equal(message.isRead,false);assert.deepEqual(message.flag,{flagStatus:'notFlagged'});assert.deepEqual(effects,['categories','move']);
 const correction=await admin('review/preview',{id:message.id,operation:'correct',type:'receipts',learn:true,requestId:'custom-correction-0001'});assert.equal(correction.state,'ready');await admin('review/apply',{ticketId:correction.id});assert.equal(message.parentFolderId,'receipts-folder');assert.equal(modelCalls,1);assert.equal((await admin('learning')).activeCount,1);assert.equal(message.isRead,false);
 // Replacing the profile on the existing durable ledger must fail closed before any write.
 config.attention.now.name='Different Urgency';writeFileSync(join(directory,'organizer.config.json'),JSON.stringify(config));await mf.dispose();mf=undefined;
 bundle();
 mf=new Miniflare({...convertV4MiniflareOptions(options),resourcePersistencePath:join(directory,'state')});
 const changed=await admin('scan',{});assert.equal(changed.lastError.code,'profile_changed');assert.equal(effects.length,4);
 console.log('Custom-profile Cloudflare runtime: arbitrary Type schema, owner context, custom labels, exact folder routing, preserved unread/flags, no temporary Type badge, and profile-change protection passed (synthetic providers).');
}finally{if(mf)await mf.dispose();rmSync(directory,{recursive:true,force:true});}
