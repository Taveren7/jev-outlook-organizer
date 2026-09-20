import type {Job} from './core';
export function reviewReasons(job:Job,confidence=.8,probability=.8,security=.7):string[]{
 const reasons:string[]=[];if(job.stage==='protected')reasons.push('protected_prior_work');if(job.stage==='failed')reasons.push('failed');if(job.stage==='held')reasons.push(job.error??'held');
 if(job.stage==='done'&&job.plan&&!job.plan.destination&&job.classification){const c=job.classification;if(c.type.confidence<confidence||c.type.probabilities[c.type.choice]!<probability)reasons.push('uncertain_type');if(c.security_risk.noul>=security)reasons.push('security_review');if(job.limitations?.some(s=>s.includes('truncated')))reasons.push('truncated_input');}
 if(job.stage==='expired')reasons.push('outside_window');return reasons;
}
export function healthReport(input:{now:number;paused:boolean;lastScan:number;lastSuccess:number;dailyLimit:number;used:number;cooldownUntil:number;lastError:unknown;secretExpiresAt?:string;counts:Array<{stage:string;count:number}>;issues:Array<{code:string;count:number}>;oldestPending:number|null}){
 const alerts:Array<{code:string;severity:'warning'|'error';count?:number}>=[];
 const count=(stages:string[])=>input.counts.filter(x=>stages.includes(x.stage)).reduce((n,x)=>n+x.count,0);
 if(!input.paused&&(!input.lastScan||input.now-input.lastScan>15*60_000))alerts.push({code:'discovery_stale',severity:'error'});
 const failed=count(['failed','held']);if(failed)alerts.push({code:'unresolved_jobs',severity:'error',count:failed});
 const pending=count(['pending','retry','classifying','planned','patching','patched','moving','moved','stripping','repair_pending']);
 if(pending&&input.used>=input.dailyLimit)alerts.push({code:'regular_budget_exhausted',severity:'warning',count:pending});
 if(!input.paused&&input.oldestPending!==null&&input.now-input.oldestPending>3600_000)alerts.push({code:'queue_waiting_over_hour',severity:'warning',count:pending});
 if(input.lastError)alerts.push({code:'recent_service_error',severity:'error'});
 let credential:{status:string;daysRemaining?:number}={status:'expiry_not_configured'};
 if(input.secretExpiresAt){const expires=Date.parse(input.secretExpiresAt);if(!Number.isFinite(expires))alerts.push({code:'credential_expiry_invalid',severity:'warning'});else{const days=Math.ceil((expires-input.now)/86400_000);credential={status:days<=0?'expired':days<=30?'expiring':'current',daysRemaining:days};if(days<=30)alerts.push({code:days<=0?'credential_expired':'credential_expiring',severity:days<=0?'error':'warning'});}}
 return {observedAt:new Date(input.now).toISOString(),scope:'Durable organizer records, not a live Inbox inventory',state:input.paused?'paused':alerts.some(a=>a.severity==='error')?'needs_attention':alerts.length?'warning':'running',alerts,credential,pending,counts:input.counts,unresolvedErrors:input.issues,lastScan:input.lastScan,lastSuccess:input.lastSuccess,cooldownUntil:input.cooldownUntil,regularBudget:{used:input.used,limit:input.dailyLimit}};
}
