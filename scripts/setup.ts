import {existsSync,readFileSync,writeFileSync,mkdirSync,chmodSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {CONFIG,PROFILE_ID} from '../src/config';
import {discoverTarget,verifyPaused,verifyDeploymentPlan,serviceUrl,type DeploymentPlan} from '../src/deployment';
import {ProductionGraph} from '../src/production/graph';
import {validateLayout} from '../src/production/core';
import {planMailbox,applyMailboxPlan,setupSearches,type MailboxPlan} from '../src/onboarding';
import {classifyMessage} from '../src/jev';
import {routingPlan} from '../src/production/core';
import type {GraphConfig} from '../src/graph';
const [command='init',...args]=process.argv.slice(2);
const apply=args.includes('--apply');
const privateWrite=(path:string,value:unknown)=>{mkdirSync('private',{recursive:true,mode:0o700});writeFileSync(path,JSON.stringify(value,null,2)+'\n',{mode:0o600});chmodSync(path,0o600);};
function env(){if(existsSync('.env'))process.loadEnvFile('.env');return process.env;}
function graphConfig(){const e=env();for(const key of ['MS_TENANT_ID','MS_CLIENT_ID','MS_MAILBOX_ID'])if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(e[key]??''))throw Error('Microsoft IDs must be GUIDs; complete .env first.');if(!e.MS_CLIENT_SECRET)throw Error('Microsoft client secret value is missing.');return e as unknown as GraphConfig;}
function localLayout(){const bundle=JSON.parse(readFileSync('private/mailbox-layout.json','utf8'));if(bundle.profile!==PROFILE_ID)throw Error('Configuration changed; preview mailbox setup again.');return validateLayout(JSON.stringify(bundle.layout),graphConfig().MS_MAILBOX_ID);}
async function serviceStatus(){const e=env();if(!e.JEV_SERVICE_URL)return null;const u=serviceUrl(e.JEV_SERVICE_URL);const r=await fetch(new URL('/admin/status',u),{redirect:'error',headers:{Authorization:'Bearer '+e.ADMIN_TOKEN},signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error('Could not verify the existing service status.');return r.json() as Promise<any>;}
function wrangler(args:string[],input?:string,quiet=false){const result=spawnSync(process.execPath,[resolve('node_modules/wrangler/bin/wrangler.js'),...args],{encoding:'utf8',input,env:process.env});if(result.status!==0)throw Error('Wrangler failed. Check login/account and retry; private provider output withheld.');if(input===undefined&&!quiet)process.stdout.write(result.stdout);return result.stdout;}
try{
 if(command==='init'){
  if(!existsSync('.env')){writeFileSync('.env',readFileSync('.env.example','utf8').replace('ADMIN_TOKEN=','ADMIN_TOKEN='+randomBytes(32).toString('hex')),{mode:0o600});chmodSync('.env',0o600);console.log('Created private .env with a random admin token.');}else console.log('.env already exists; preserved.');
  console.log('1. Edit organizer.config.json (your context, categories, folders and colors).\n2. Complete Microsoft setup in docs/setup.md and fill .env with your own credentials.\n3. Run npm run config:check, then npm run doctor.\n4. Run npm run mailbox:setup to preview; add -- --apply after reviewing.\n5. Run npm run deploy to preview deployment; add -- --apply to deploy paused.\n6. Use npm run preview, then explicitly enable the service.');
 }else if(command==='config'){
  console.log(JSON.stringify({valid:true,types:Object.entries(CONFIG.types).map(([key,t])=>({key,folder:t.folder})),timeZone:CONFIG.timeZone,lookbackDays:CONFIG.lookbackDays,dailyLimit:CONFIG.dailyLimit,fileTruncatedMessages:CONFIG.routing.fileTruncatedMessages},null,2));
 }else if(command==='doctor'){
  const mail=new ProductionGraph(graphConfig());const inbox=await mail.request('/mailFolders/inbox?$select=id');await mail.request('/outlook/masterCategories?$top=1');
  const e=env();let negative='not-configured';if(e.MS_DENIED_MAILBOX_ID){if(e.MS_DENIED_MAILBOX_ID===e.MS_MAILBOX_ID)throw Error('The negative scope mailbox must differ.');const denied=new ProductionGraph({...graphConfig(),MS_MAILBOX_ID:e.MS_DENIED_MAILBOX_ID});try{await denied.request('/mailFolders/inbox/messages?$top=1&$select=id');throw Error('Out-of-scope mailbox was accessible.');}catch(error){if(!(error instanceof Error)||error.message!=='graph_403')throw Error('Negative scope check did not return 403.');negative='denied-403';}}
  if(!e.TYPESAFE_API_KEY)throw Error('Jev API key missing.');if(args.includes('--jev'))await classifyMessage({id:'synthetic',subject:'Synthetic setup check',from:'sender@example.test',to:['owner@example.test'],cc:[],receivedAt:new Date().toISOString(),bodyText:'For your records: this is a synthetic subscription receipt. No action is required.',hasAttachments:false},e.TYPESAFE_API_KEY);
  console.log(JSON.stringify({microsoftRead:!!inbox.id,categoryPermission:'read-verified',writePermission:'verified-only-during-explicit-mailbox-setup',negativeScope:negative,jev:args.includes('--jev')?'synthetic-request-passed':'key-present; use --jev for a billable synthetic test'}));
 }else if(command==='mailbox'){
  const mail=new ProductionGraph(graphConfig());const status=await serviceStatus();if(status&&(!status.paused||status.busy))throw Error('Pause the service before changing mailbox setup.');
  if(args.includes('--search-folders')){console.log(JSON.stringify(await setupSearches(mail,localLayout(),apply),null,2));}
  else if(!apply){const plan=await planMailbox(mail,graphConfig().MS_MAILBOX_ID);privateWrite('private/mailbox-plan.json',plan);console.log(JSON.stringify({previewOnly:true,folders:plan.folders.map(f=>({name:f.name,operation:f.existingId?'reuse':'create'})),categories:plan.categories.map(c=>({name:c.name,operation:c.existingId?'preserve-existing':'create',color:c.existingColor??c.color})),next:'Review, then npm run mailbox:setup -- --apply within one hour.'},null,2));}
  else{const plan=JSON.parse(readFileSync('private/mailbox-plan.json','utf8')) as MailboxPlan;const layout=await applyMailboxPlan(mail,graphConfig().MS_MAILBOX_ID,plan);privateWrite('private/mailbox-layout.json',{profile:PROFILE_ID,layout});console.log('Folder mapping and category definitions verified. No messages moved. Optional cross-folder views: npm run mailbox:setup -- --search-folders');}
 }else if(command==='deploy'){
  const e=env(),layout=localLayout();for(const k of ['ADMIN_TOKEN','TYPESAFE_API_KEY','MS_CLIENT_SECRET'])if(!e[k])throw Error('Complete .env first.');if(e.ADMIN_TOKEN!.length<32)throw Error('Admin token must be at least 32 characters.');
  if(!/^[a-z][a-z0-9-]{2,62}$/.test(e.WORKER_NAME??''))throw Error('Set your own valid WORKER_NAME.');
  // Capture Wrangler's credential in memory only; never print it or write it to a plan.
  const credential=JSON.parse(wrangler(['auth','token','--json'],undefined,true));
  if(!['oauth','api_token'].includes(credential.type)||typeof credential.token!=='string')throw Error('Deployment check requires Wrangler login or a Cloudflare API token.');
  const target=await discoverTarget(e.CLOUDFLARE_ACCOUNT_ID??'',e.WORKER_NAME!,credential.token);
  await verifyPaused(target,e.JEV_SERVICE_URL,e.ADMIN_TOKEN!);
  const plan:DeploymentPlan={target,profile:PROFILE_ID,layout:JSON.stringify(layout),createdAt:Date.now()};
  if(!apply){privateWrite('private/deployment-plan.json',plan);console.log(JSON.stringify({previewOnly:true,workerName:e.WORKER_NAME,serviceUrl:target.serviceUrl,operation:target.exists?'update':'create',categories:Object.keys(layout.folders).length,startup:'paused',secrets:['MS_TENANT_ID','MS_CLIENT_ID','MS_CLIENT_SECRET','MS_MAILBOX_ID','TYPESAFE_API_KEY','ADMIN_TOKEN','MAILBOX_LAYOUT'],next:'npm run deploy -- --apply'},null,2));}
  else{
   if(!existsSync('private/deployment-plan.json'))throw Error('Deployment preview is missing; run npm run deploy first.');
   verifyDeploymentPlan(JSON.parse(readFileSync('private/deployment-plan.json','utf8')),target,PROFILE_ID,JSON.stringify(layout));
   const wranglerConfig=JSON.parse(readFileSync('wrangler.jsonc','utf8'));wranglerConfig.name=e.WORKER_NAME;wranglerConfig.account_id=target.accountId;writeFileSync('wrangler.local.jsonc',JSON.stringify(wranglerConfig,null,2)+'\n',{mode:0o600});
   // A new service starts paused. Existing services were verified paused above.
   wrangler(['deploy','-c','wrangler.local.jsonc']);
   const secrets=Object.fromEntries(['MS_TENANT_ID','MS_CLIENT_ID','MS_CLIENT_SECRET','MS_MAILBOX_ID','TYPESAFE_API_KEY','ADMIN_TOKEN'].map(k=>[k,e[k]]));secrets.MAILBOX_LAYOUT=JSON.stringify(layout);
   wrangler(['secret','bulk','-c','wrangler.local.jsonc'],JSON.stringify(secrets));
   await verifyPaused({...target,exists:true},target.serviceUrl,e.ADMIN_TOKEN!);
   console.log('Paused status verified at '+target.serviceUrl);
   console.log('Secrets uploaded through stdin. Set JEV_SERVICE_URL in .env to the printed workers.dev URL, then run npm run service -- status. The new service remains paused.');
  }
 }else if(command==='preview'){
  if(!args.includes('--latest'))throw Error('Use --latest to explicitly send the latest Inbox message to Jev for review.');
  const mail=new ProductionGraph(graphConfig()),layout=localLayout();const r=await mail.request('/mailFolders/inbox/messages?$top=1&$orderby=receivedDateTime desc&$select=id');const id=r.value?.[0]?.id;if(!id){console.log('Inbox is empty.');}else{const {metadata,message}=await mail.content(id),e=env();if(!e.TYPESAFE_API_KEY)throw Error('Jev key missing.');const result=await classifyMessage(message,e.TYPESAFE_API_KEY);const plan=routingPlan(metadata,result.classification,result.limitations,layout,'type-folders',Date.now());privateWrite('private/latest-preview.json',{id,...result,plan});console.log(JSON.stringify({mailboxWrites:0,classification:result.classification,limitations:result.limitations,destination:plan.destination?.displayName??'Keep in Inbox',labels:plan.finalCategories},null,2));}
 }else throw Error('Unknown setup command.');
}catch(error){const local=error instanceof Error&&/^(Microsoft IDs|Microsoft client secret|Configuration changed|Invalid service URL|Could not verify|Wrangler failed|Deployment |The negative|Out-of-scope|Negative scope|Jev API|Jev key|Pause |Complete |Admin token|Set your|Use --latest|Unknown setup)/.test(error.message);console.error(local?(error as Error).message:'Setup could not complete. Check configuration/permissions and docs/setup.md; private provider details withheld.');process.exitCode=1;}
