import {CONFIG} from '../config';
import { ACTION_NAMES, ATTENTION_LABELS, TYPE_NAMES, REVIEW_LABELS } from '../outlook-layout';
import { parseClassification, type Classification } from '../taxonomy';
import { decide } from '../policy';
import { assertLayoutState, type LayoutState } from '../layout-review';

export type Mode = 'observe' | 'labels' | 'conservative' | 'type-folders';
export interface Metadata extends LayoutState { receivedDateTime: string }
export interface Folder { id: string; displayName: string; parentFolderId: string }
export interface Layout { mailboxId: string; inboxId: string; folders: Record<keyof typeof TYPE_NAMES, Folder> }
export interface Plan { before: Metadata; categories: string[]; finalCategories: string[]; destination: Folder | null; disposition: string }
export type Stage = 'pending' | 'classifying' | 'retry' | 'planned' | 'patching' | 'patched' | 'moving' | 'moved' | 'stripping' | 'done' | 'observed' | 'held' | 'failed' | 'protected' | 'expired';
export interface Job {
  humanCorrection?:import('./learning').HumanCorrection; learningExampleIds?:string[];
  classifierContextVersion?:string;
  id: string; receivedAt: string; stage: Stage; attempts: number; due: number; updatedAt: number;
  plan?: Plan; checkpoint?: Metadata; classification?: Classification; model?: string; limitations?: string[];
  error?: string; after?: Metadata; policyVersion?: string; reviewId?:string; reviewOperation?:string;
}
export interface MailAdapter {
  metadata(id: string): Promise<Metadata>;
  folder(id: string): Promise<Folder>;
  categories(id: string, categories: string[], etag: string): Promise<void>;
  move(id: string, sourceId: string, destinationId: string): Promise<void>;
}
export const POLICY_VERSION = 'public-v1';
const owned = new Set<string>([...Object.values(TYPE_NAMES), ...Object.values(ACTION_NAMES), ...Object.values(ATTENTION_LABELS).map(v=>v.name),REVIEW_LABELS.needsReview,REVIEW_LABELS.securityReview,...(CONFIG.actionIndicator?[CONFIG.actionIndicator.name]:[])]);
export const managed = (categories: string[]) => categories.some(c => owned.has(c) || c.startsWith('JEV-'));
export const equalCategories = (a:string[],b:string[])=>JSON.stringify([...a].sort())===JSON.stringify([...b].sort());
const sameFlag=(a:Metadata,b:Metadata)=>JSON.stringify(a.flag)===JSON.stringify(b.flag);
export function withinWindow(receivedAt:string,now:number) {const n=Date.parse(receivedAt);return Number.isFinite(n)&&n<=now&&n>=now-CONFIG.lookbackDays*86_400_000;}
export function validateLayout(input:string,mailboxId:string): Layout {
  const v=JSON.parse(input) as Layout;
  if(Object.keys(v.folders??{}).sort().join()!==Object.keys(TYPE_NAMES).sort().join())throw Error('layout_invalid');
  if(v.mailboxId!==mailboxId || typeof v.inboxId!=='string' || !v.inboxId || !v.folders)throw Error('layout_invalid');
  const ids=new Set([v.inboxId]);
  for(const type of Object.keys(TYPE_NAMES) as Array<keyof typeof TYPE_NAMES>){const f=v.folders[type];if(!f||typeof f.id!=='string'||!f.id||f.displayName!==TYPE_NAMES[type]||f.parentFolderId!==v.inboxId||ids.has(f.id))throw Error('layout_invalid');ids.add(f.id);}
  return v;
}
export function routingPlan(before:Metadata,input:unknown,limitations:string[],layout:Layout,mode:Mode,now:number):Plan {
  if(before.parentFolderId!==layout.inboxId||before.flag.flagStatus==='complete'||managed(before.categories)||!withinWindow(before.receivedDateTime,now))throw Error('state_protected');
  const c=parseClassification(input),proposal=decide(c,limitations);
  const clearType=c.type.confidence>=CONFIG.routing.choiceConfidence&&c.type.probabilities[c.type.choice]!>=CONFIG.routing.choiceProbability;
  const held=before.flag.flagStatus==='flagged'||['manual_review','security_review'].includes(proposal.disposition);
  let categories:string[];
  if(held){
    // Do not present an uncertain Type as settled. Every uncertainty stays visible as a to-do.
    const typeMode=mode==='type-folders';
    const urgent=typeMode&&c.attention.choice==='now'&&c.attention.confidence>=0.8&&c.attention.probabilities.now>=0.8;
    const actionable=typeMode&&c.action.confidence>=0.8&&c.action.probabilities[c.action.choice]>=0.8&&!['reference','archive','other'].includes(c.action.choice);
    categories=[...before.categories,...(typeMode&&clearType?[TYPE_NAMES[c.type.choice]!]:[]),urgent?ATTENTION_LABELS.now.name:ATTENTION_LABELS.soon.name,actionable?ACTION_NAMES[c.action.choice]:ACTION_NAMES.review_investigate,REVIEW_LABELS.needsReview,...(proposal.disposition==='security_review'?[REVIEW_LABELS.securityReview]:[])];
  }else categories=[...before.categories,TYPE_NAMES[c.type.choice]!,ATTENTION_LABELS[c.attention.choice].name,ACTION_NAMES[c.action.choice]];
  if(CONFIG.actionIndicator && c.needs_owner.noul>=CONFIG.actionIndicator.threshold)categories.push(CONFIG.actionIndicator.name);
  categories=[...new Set(categories)];
  // Start with a deliberately small routine allowlist and stronger confidence than labeling.
  const routine=Object.keys(CONFIG.types).filter(key=>CONFIG.types[key]!.routine);
  const choices:Array<{confidence:number;choice:string;probabilities:Readonly<Record<string,number>>}>=[c.type,c.attention,c.action];
  const strong=choices.every(x=>x.confidence>=0.95&&x.probabilities[x.choice]!>=0.95);
  const file=mode==='conservative'&&!held&&!limitations.length&&strong&&c.security_risk.noul<=0.05&&c.needs_owner.noul<=0.1&&routine.includes(c.type.choice)&&['informational','none'].includes(c.attention.choice)&&['reference','archive'].includes(c.action.choice);
  // Type decides physical organization. Uncertainty about a task stays visible in its labels.
  // Truncated input and elevated security review still prevent automatic movement.
  const typeFile=mode==='type-folders'&&clearType&&c.security_risk.noul<CONFIG.routing.securityHold&&(CONFIG.routing.fileTruncatedMessages||!limitations.some(s=>s.includes('truncated')));
  const destination=file||typeFile?layout.folders[c.type.choice]:null;
  if(destination===undefined)throw Error('layout_invalid');
  // Routing uses the saved classification, not a temporary visible badge. Do not add a Type
  // immediately before moving just to remove it again: Outlook synchronization can restore it.
  if(typeFile)categories=categories.filter(x=>x!==TYPE_NAMES[c.type.choice]!);
  return {before,categories,finalCategories:destination?categories.filter(x=>x!==TYPE_NAMES[c.type.choice]!):categories,destination,disposition:proposal.disposition};
}
function preserved(before:Metadata,after:Metadata,categories:string[],parent:string){
  return before.id===after.id&&before.isRead===after.isRead&&sameFlag(before,after)&&after.parentFolderId===parent&&equalCategories(after.categories,categories);
}
export class PauseError extends Error {constructor(){super('paused');}}
export class RemoteError extends Error { constructor(public code:string,public retryAfterMs=60_000){super(code);} }

// Every intent is durably saved before its external effect. Moving intent is never blindly replayed.
export async function applyJob(job:Job,mail:MailAdapter,save:(job:Job)=>Promise<void>,running:()=>boolean,now:()=>number=Date.now):Promise<Job>{
  if(!job.plan)throw Error('missing_plan');const p=job.plan;
  const record=async(stage:Stage,checkpoint?:Metadata)=>{job={...job,stage,updatedAt:now(),...(checkpoint?{checkpoint}:{})};await save(job);};
  const active=()=>{if(!running())throw new PauseError();};
  const hold=async(code:string)=>{job={...job,error:code};await record('held');return job;};
  const fresh=()=>mail.metadata(job.id);
  active();let current=await fresh();
  if(job.stage==='moving'){
    if(!p.destination||!preserved(p.before,current,p.categories,p.destination.id))return hold('uncertain_move_requires_review');
    await record('moved',current);
  }
  if(job.stage==='patching'){
    if(preserved(p.before,current,p.categories,p.before.parentFolderId))await record('patched',current);
    else return hold('uncertain_category_write_requires_review');
  }
  if(job.stage==='stripping'){
    if(p.destination&&preserved(p.before,current,p.finalCategories,p.destination.id)){job={...job,after:current};await record('done',current);return job;}
    return hold('uncertain_type_removal_requires_review');
  }
  if(job.stage==='planned'){
    if(!withinWindow(current.receivedDateTime,now()))return hold('aged_out_before_write');
    try{assertLayoutState(p.before,current);}catch{return hold('user_state_changed');}
    active();await record('patching');active();await mail.categories(job.id,p.categories,current['@odata.etag']);
    current=await fresh();if(!preserved(p.before,current,p.categories,p.before.parentFolderId))return hold('category_verification_changed');
    await record('patched',current);
  }
  if(job.stage==='patched'){
    if(!job.checkpoint)throw Error('missing_checkpoint');current=await fresh();
    try{assertLayoutState(job.checkpoint,current);}catch{return hold('user_state_changed');}
    if(p.destination){
      if(!withinWindow(current.receivedDateTime,now()))return hold('aged_out_before_move');
      const f=await mail.folder(p.destination.id);
      if(f.id!==p.destination.id||f.displayName!==p.destination.displayName||f.parentFolderId!==p.destination.parentFolderId)return hold('destination_changed');
      current=await fresh();try{assertLayoutState(job.checkpoint,current);}catch{return hold('user_state_changed');}
      active();await record('moving',current);active();await mail.move(job.id,p.before.parentFolderId,f.id);
      current=await fresh();if(!preserved(p.before,current,p.categories,f.id))return hold('move_verification_changed');
      await record('moved',current);
    }else{job={...job,after:current};await record('done',current);return job;}
  }
  if(job.stage==='moved'){
    if(!p.destination||!job.checkpoint)throw Error('missing_checkpoint');current=await fresh();
    try{assertLayoutState(job.checkpoint,current);}catch{return hold('user_state_changed');}
    if(equalCategories(p.categories,p.finalCategories)){job={...job,after:current};await record('done',current);return job;}
    active();await record('stripping',current);active();await mail.categories(job.id,p.finalCategories,current['@odata.etag']);
    current=await fresh();if(!preserved(p.before,current,p.finalCategories,p.destination.id))return hold('final_verification_changed');
    job={...job,after:current};await record('done',current);
  }
  return job;
}
export function quotaDay(now:number){const parts=new Intl.DateTimeFormat('en-US',{timeZone:CONFIG.timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now);return ['year','month','day'].map(k=>parts.find(p=>p.type===k)!.value).join('-');}
