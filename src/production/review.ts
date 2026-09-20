import {applyJob,managed,routingPlan,withinWindow,type Job,type Layout,type Metadata,type Plan} from './core';
import {assertLayoutState} from '../layout-review';
import {fingerprint} from '../relationships';
import type {ProductionGraph} from './graph';
import type {Ledger} from './store';
export interface ReviewTicket {id:string;messageId:string;operation:'rerun'|'undo'|'retry';createdAt:number;expiresAt:number;revision:string;sourceHash:string;state:string;source:Job;before?:Metadata;proposal?:Job;error?:string;finishedAt?:number}
export interface ReviewContext {ledger:Ledger;mail:ProductionGraph;layout:Layout;revision:string;policyVersion:string;securityHold:number;now:()=>number;classify:(message:any)=>Promise<any>;reserve:()=>boolean;paused:()=>boolean;save:(job:Job)=>Promise<void>}
export function sameState(expected:Metadata,current:Metadata){if(expected.receivedDateTime!==current.receivedDateTime)throw Error('review_state_changed');try{assertLayoutState({...expected,'@odata.etag':current['@odata.etag']},current);}catch{throw Error('review_state_changed');}}
export function rerunPlan(source:Job,current:Metadata,result:any,layout:Layout,now:number,securityHold=.7):Plan {
 if(source.stage!=='done'||!source.after||!source.plan||source.plan.destination||!source.classification||source.classification.security_risk.noul>=securityHold||source.limitations?.some(s=>s.includes('truncated')))throw Error('review_protected');
 sameState(source.after,current);
 const plan=routingPlan({...current,categories:source.plan.before.categories},result.classification,result.limitations,layout,'type-folders',now);return {...plan,before:current};
}
function guard(c:ReviewContext){if(!c.paused())throw Error('review_pause_required');}
export async function previewReview(c:ReviewContext,input:any):Promise<ReviewTicket>{
 guard(c);
 if(!input||!['rerun','undo','retry'].includes(input.operation)||typeof input.id!=='string'||!input.id||input.id.length>2048||typeof input.requestId!=='string'||!/^[-a-zA-Z0-9_]{16,80}$/.test(input.requestId))throw Error('review_invalid_request');
 const prior=c.ledger.review(input.requestId) as ReviewTicket|undefined;
 if(prior){if(prior.messageId!==input.id||prior.operation!==input.operation)throw Error('review_request_conflict');return prior;}
 const source=c.ledger.job(input.id);if(!source)throw Error('review_job_missing');
 const createdAt=c.now(),ticket:ReviewTicket={id:input.requestId,messageId:input.id,operation:input.operation,createdAt,expiresAt:createdAt+3600_000,revision:c.revision,sourceHash:await fingerprint(source),source,state:'preparing'};
 guard(c);c.ledger.saveReview(ticket);
 try{
  const {metadata:current,message}=ticket.operation==='rerun'?await c.mail.content(input.id):{metadata:await c.mail.metadata(input.id),message:undefined};
  guard(c);if(!withinWindow(current.receivedDateTime,c.now())||current.flag.flagStatus==='complete')throw Error('review_protected');ticket.before=current;
  let proposal:Job;
  if(ticket.operation==='rerun'){
   // Validate original state and exclusions BEFORE a billable classification.
   if(!source.classification)throw Error('review_protected');rerunPlan(source,current,{classification:source.classification,limitations:source.limitations??[]},c.layout,c.now(),c.securityHold);
   if(!c.reserve())throw Error('review_budget_exhausted');
   const result=await c.classify(message);guard(c);
   const fresh=await c.mail.metadata(input.id);sameState(current,fresh);
   const plan=rerunPlan(source,fresh,result,c.layout,c.now(),c.securityHold);
   proposal={...source,...result,plan,after:undefined,checkpoint:undefined,error:undefined,stage:'planned',policyVersion:c.policyVersion,updatedAt:c.now(),due:c.now(),reviewId:ticket.id,reviewOperation:'rerun'};
   if(!plan.destination){ticket.state='ineligible';ticket.proposal=proposal;c.ledger.saveReview(ticket);return ticket;}
  }else if(ticket.operation==='undo'){
   if(source.stage!=='done'||!source.after||!source.plan||source.reviewOperation==='undo'||source.plan.before.parentFolderId!==c.layout.inboxId)throw Error('review_protected');
   sameState(source.after,current);
   const destination=current.parentFolderId===c.layout.inboxId?null:await c.mail.folder(c.layout.inboxId);
   if(destination&&destination.id!==c.layout.inboxId)throw Error('review_destination_changed');
   const plan:Plan={before:current,categories:[...source.plan.before.categories],finalCategories:[...source.plan.before.categories],destination,disposition:'reviewed_undo'};
   proposal={...source,plan,after:undefined,checkpoint:undefined,error:undefined,stage:'planned',updatedAt:c.now(),due:c.now(),reviewId:ticket.id,reviewOperation:'undo'};
  }else{
   if(source.stage!=='failed'||source.after||current.parentFolderId!==c.layout.inboxId||managed(current.categories))throw Error('review_protected');
   proposal={id:source.id,receivedAt:current.receivedDateTime,stage:'pending',attempts:0,due:c.now(),updatedAt:c.now(),reviewId:ticket.id,reviewOperation:'retry'};
  }
  guard(c);ticket.before=proposal.plan?.before??current;ticket.proposal=proposal;ticket.state='ready';c.ledger.saveReview(ticket);return ticket;
 }catch(error){ticket.state='blocked';ticket.error=error instanceof Error&&/^review_[a-z_]+$/.test(error.message)?error.message:'review_unavailable_or_state_changed';c.ledger.saveReview(ticket);return ticket;}
}
export async function applyReview(c:ReviewContext,id:string):Promise<ReviewTicket>{
 guard(c);const ticket=c.ledger.review(id) as ReviewTicket|undefined;if(!ticket)throw Error('review_missing');
 // Idempotent retrieval only: interrupted effects recover from the job ledger, never replay here.
 if(['applied','queued','applying','recovery_required'].includes(ticket.state))return ticket;
 if(ticket.state!=='ready'||!ticket.proposal||!ticket.before||ticket.expiresAt<c.now()||ticket.revision!==c.revision)throw Error('review_expired_or_changed');
 const source=c.ledger.job(ticket.messageId);if(!source||await fingerprint(source)!==ticket.sourceHash)throw Error('review_source_changed');
 const current=await c.mail.metadata(ticket.messageId);sameState(ticket.before,current);if(!withinWindow(current.receivedDateTime,c.now()))throw Error('review_expired_or_changed');
 guard(c);
 const proposal={...ticket.proposal,...(ticket.proposal.plan?{plan:{...ticket.proposal.plan,before:current}}:{}),updatedAt:c.now()};
 ticket.state='applying';c.ledger.saveReview(ticket);await c.save(proposal);
 if(ticket.operation==='retry'){ticket.state='queued';c.ledger.saveReview(ticket);return ticket;}
 try{
  const done=await applyJob(proposal,c.mail,c.save,c.paused,c.now);
  ticket.state=done.stage==='done'?'applied':'blocked';ticket.error=done.error;ticket.finishedAt=c.now();c.ledger.saveReview(ticket);return ticket;
 }catch{ticket.state='recovery_required';ticket.error='review_operation_interrupted';c.ledger.saveReview(ticket);return ticket;}
}
