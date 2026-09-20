import {CONFIG,PROFILE_ID} from '../config';
import type {DurableObjectState, DurableObjectNamespace} from '@cloudflare/workers-types';
import {inventoryInbox} from '../backfill';
import {classifyMessage} from '../jev';
import type {GraphConfig} from '../graph';
import {applyJob,managed,withinWindow,validateLayout,routingPlan,PauseError,RemoteError,POLICY_VERSION,type Job,type Mode} from './core';
import {ProductionGraph} from './graph';
import {Ledger} from './store';
import {productionFetch,throttled} from './transport';

export interface ProductionEnv extends GraphConfig {
  TYPESAFE_API_KEY:string; ADMIN_TOKEN:string; MAILBOX_LAYOUT:string;
  COORDINATOR:DurableObjectNamespace;
}
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store'}});
function safeError(error:unknown){
  if(error instanceof RemoteError)return error.code;
  const message=error instanceof Error?error.message:'';
  const status=/^Inbox inventory failed \((\d{3})\); no mail changed$/.exec(message)?.[1];
  if(status)return 'inventory_'+status;
  const known:Record<string,string>={'Microsoft authentication failed':'microsoft_authentication_failed','Invalid Microsoft token response':'microsoft_token_invalid','Unsafe or repeated pagination link':'pagination_rejected','Server result outside cleanup window':'inventory_outside_window','Invalid inbox inventory':'inventory_invalid','Invalid message metadata':'metadata_invalid','Too many subrequests.':'subrequest_limit','The operation was aborted due to timeout':'request_timeout','account_changed':'account_changed','layout_invalid':'layout_invalid','incomplete_inventory':'incomplete_inventory','profile_changed':'profile_changed'};
  return known[message]??'coordinator_failed';
}
export class MailboxCoordinator {
  private ledger:Ledger;
  private busy=false;
  constructor(private state:DurableObjectState,private env:ProductionEnv){this.ledger=new Ledger(state.storage.sql);}
  private running=()=>!this.ledger.get('paused',true);
  private save=async(job:Job)=>{this.ledger.save(job);};
  private layout(){
    const fingerprint=[this.env.MS_TENANT_ID,this.env.MS_CLIENT_ID,this.env.MS_MAILBOX_ID].join('/');
    if(this.ledger.get('account',fingerprint)!==fingerprint)throw Error('account_changed');
    if(this.ledger.get('profile',PROFILE_ID)!==PROFILE_ID)throw Error('profile_changed');
    this.ledger.set('profile',PROFILE_ID);
    this.ledger.set('account',fingerprint);return validateLayout(this.env.MAILBOX_LAYOUT,this.env.MS_MAILBOX_ID);
  }
  private status(){return {service:'jev-outlook',policy:POLICY_VERSION,paused:!this.running(),mode:this.ledger.get<Mode>('mode','observe'),busy:this.busy,processing:'continuous',catchup:this.ledger.get('catchup',null),cooldownUntil:this.ledger.get('cooldownUntil',0),scanPhase:this.ledger.get('scanPhase',null),dailyLimit:this.ledger.get('dailyLimit',100),today:this.ledger.budget(Date.now()),jobs:this.ledger.counts(),lastScan:this.ledger.get('lastScan',0),lastSuccess:this.ledger.get('lastSuccess',0),lastClassification:this.ledger.get('lastClassification',0),lastError:this.ledger.get('lastError',null),launchAt:this.ledger.get('launchAt',0)};}
  async fetch(request:Request):Promise<Response>{
    const url=new URL(request.url),path=url.pathname;
    if(request.method==='GET'&&path==='/status')return json(this.status());
    if(request.method==='GET'&&path==='/jobs')return json(this.ledger.jobs());
    if(request.method==='GET'&&path==='/audit')return json(this.ledger.audit(Math.max(0,Number(url.searchParams.get('after'))||0)));
    if(request.method!=='POST')return json({error:'not_found'},404);
    if(path==='/pause'){this.ledger.set('paused',true);await this.state.storage.deleteAlarm();return json(this.status());}
    if(path==='/catchup'){
      if(this.running()||this.busy)return json({error:'pause_first'},409);
      this.layout();this.ledger.startCatchup(Date.now());return json(this.status());
    }
    if(path==='/resume'){
      const body=await request.json() as {dailyLimit?:number;mode?:Mode};
      if(!Number.isInteger(body.dailyLimit)||body.dailyLimit!<1||body.dailyLimit!>250||!['observe','labels','conservative','type-folders'].includes(body.mode!))return json({error:'invalid_settings'},400);
      if(this.busy)return json({error:'busy'},409);
      this.layout();if(!this.env.TYPESAFE_API_KEY||!this.env.MS_CLIENT_SECRET)throw Error('missing_credentials');
      this.ledger.set('dailyLimit',body.dailyLimit);this.ledger.set('mode',body.mode);
      if(!this.ledger.get('launchAt',0))this.ledger.set('launchAt',Date.now());
      this.ledger.set('paused',false);await this.schedule();return json(this.status());
    }
    if(path==='/seed'){
      if(this.running()||this.busy)return json({error:'pause_first'},409);
      const body=await request.json() as {ids:unknown};
      if(!Array.isArray(body.ids)||body.ids.length>2000||body.ids.some(id=>typeof id!=='string'||!id||id.length>2048))return json({error:'invalid_ids'},400);
      for(const id of body.ids)if(!this.ledger.job(id))this.ledger.save({id,receivedAt:'',stage:'protected',attempts:0,due:0,updatedAt:Date.now(),error:'previously_reviewed'});
      return json(this.status());
    }
    if(path==='/promote'){
      if(this.running()||this.busy)return json({error:'pause_first'},409);
      const {id,mode='type-folders'}=await request.json() as {id:string;mode:Mode};
      if(!['labels','conservative','type-folders'].includes(mode))return json({error:'invalid_mode'},400);const job=this.ledger.job(id);
      if(!job||job.stage!=='observed'||!job.plan||!job.classification)return json({error:'not_observed'},400);
      job.plan=routingPlan(job.plan.before,job.classification,job.limitations??[],this.layout(),mode,Date.now());
      job.stage='planned';job.updatedAt=Date.now();this.ledger.save(job);return json({stage:job.stage});
    }
    if(path==='/scan'){if(this.busy)return json({error:'busy'},409);this.busy=true;try{await this.scan();}catch(error){this.ledger.set('lastError',{code:safeError(error),at:Date.now()});}finally{this.busy=false;}return json(this.status());}
    if(path==='/run'){await this.tick();return json(this.status());}
    return json({error:'not_found'},404);
  }
  private async scan(){
    this.ledger.set('scanPhase','layout');this.layout();
    this.ledger.set('scanPhase','inventory');
    const result=await inventoryInbox(this.env,{days:CONFIG.lookbackDays},productionFetch);
    this.ledger.set('scanPhase','recording');
    if(!result.complete)throw Error('incomplete_inventory');
    const now=Date.now();
    for(const item of result.items)if(!this.ledger.job(item.id))this.ledger.save({id:item.id,receivedAt:item.receivedAt,stage:item.status==='needs_classification'?'pending':'protected',attempts:0,due:now,updatedAt:now});
    this.ledger.set('lastScan',now);
    this.ledger.set('scanPhase','complete');
    this.ledger.set('scanDiagnostic',null);
    this.ledger.set('lastError',null);
  }
  async alarm(){await this.tick();}
  private async schedule(){
    if(!this.running())return;
    const now=Date.now(),cooldown=this.ledger.get('cooldownUntil',0);
    const next=this.ledger.next(now,this.ledger.get('launchAt',0),this.ledger.get('dailyLimit',100));
    const mode=this.ledger.get<Mode>('mode','observe');
    const ready=next&&!(next.plan&&mode==='observe');
    // One durable turn per message bounds subrequests/CPU and lets pause requests interleave.
    // Ready work runs immediately; the one-minute wake is only for an idle or budget-limited queue.
    await this.state.storage.setAlarm(Math.max(cooldown,ready?now:now+60_000));
  }
  private async tick(){
    if(this.busy||!this.running())return;this.busy=true;
    try{
      if(Date.now()<this.ledger.get('cooldownUntil',0))return;
      if(Date.now()-this.ledger.get('lastScan',0)>=300_000)await this.scan();
      if(!this.running())return;
      const job=this.ledger.next(Date.now(),this.ledger.get('launchAt',0),this.ledger.get('dailyLimit',100));
      if(job)await this.process(job);
      this.ledger.finishCatchup(Date.now());
    }catch(error){
      // Raw provider errors may contain mail content or credentials.
      this.ledger.set('lastError',{code:safeError(error),at:Date.now()});
      this.ledger.set('cooldownUntil',Date.now()+(throttled(error)?.retryAfterMs??60_000));
    }finally{
      this.busy=false;
      await this.schedule();
    }
  }
  private async process(job:Job){
    const mail=new ProductionGraph(this.env);
    try{
      if(job.stage==='classifying'){
        job.stage=job.attempts>=3?'failed':'retry';job.due=Date.now()+60_000;job.error='interrupted_classification';job.updatedAt=Date.now();await this.save(job);return;
      }
      if(['pending','retry'].includes(job.stage)){
        if(!withinWindow(job.receivedAt,Date.now())){job.stage='expired';await this.save({...job,updatedAt:Date.now()});return;}
        const layout=this.layout(),content=await mail.content(job.id),before=content.metadata;
        if(before.parentFolderId!==layout.inboxId||managed(before.categories)||before.flag.flagStatus==='complete'){job.stage='protected';await this.save({...job,updatedAt:Date.now()});return;}
        if(!this.running())throw new PauseError();
        if(!this.ledger.reserve(Date.now(),Date.parse(job.receivedAt)<this.ledger.get('launchAt',0),this.ledger.get('dailyLimit',100),job.receivedAt))return;
        job={...job,stage:'classifying',attempts:job.attempts+1,updatedAt:Date.now()};await this.save(job);
        const result=await classifyMessage(content.message,this.env.TYPESAFE_API_KEY,productionFetch);
        const mode=this.ledger.get<Mode>('mode','observe');
        job={...job,...result,policyVersion:POLICY_VERSION,plan:routingPlan(before,result.classification,result.limitations,layout,mode,Date.now()),stage:mode==='observe'?'observed':'planned',updatedAt:Date.now()};
        await this.save(job);
        this.ledger.set('lastClassification',Date.now());
        if(mode==='observe')return;
      }
      if(!this.running())throw new PauseError();
      if(this.ledger.get<Mode>('mode','observe')==='observe')return;
      const result=await applyJob(job,mail,this.save,this.running);
      if(result.stage==='done'){this.ledger.set('lastSuccess',Date.now());this.ledger.set('lastError',null);}
    }catch(error){
      if(error instanceof PauseError)return;
      const latest=this.ledger.job(job.id)??job;
      const throttle=throttled(error);
      const code=throttle?.code??(error instanceof RemoteError?error.code:'processing_failed');
      const recovery=['patching','patched','moving','moved','stripping'].includes(latest.stage);
      const failures=(latest as Job & {failures?:number}).failures??0;
      // Unknown external outcomes retain their intent for read-only reconciliation, never blind replay.
      const stage=recovery?(failures>=2?'held':latest.stage):latest.attempts>=3||failures>=2?'failed':'retry';
      const delay=Math.max(throttle?.retryAfterMs??(error instanceof RemoteError?error.retryAfterMs:60_000),60_000*2**failures);
      await this.save({...latest,stage,error:code,due:Date.now()+delay,updatedAt:Date.now(),failures:failures+1} as Job);
      if(throttle)this.ledger.set('cooldownUntil',Date.now()+throttle.retryAfterMs);
      this.ledger.set('lastError',{code,at:Date.now()});
    }
  }
}
