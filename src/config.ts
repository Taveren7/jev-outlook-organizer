import input from '../organizer.config.json';
export interface Label {name:string;color:string}
export interface OrganizerConfig {
 version:1;ownerContext:string;organizationContext:string;timeZone:string;model:string;
 lookbackDays:number;dailyLimit:number;maxBodyCharacters:number;
 routing:{choiceConfidence:number;choiceProbability:number;securityHold:number;fileTruncatedMessages:boolean};
 types:Record<string,{description:string;folder:string;color:string;routine:boolean}>;
 attention:Record<'now'|'soon'|'informational'|'none',Label>;
 actions:Record<'reply'|'review_investigate'|'approve_decide'|'order_buy'|'delegate'|'reference'|'archive'|'other',Label>;
 review:Record<'needsReview'|'securityReview',Label>;
}
export function validateConfig(value:unknown):OrganizerConfig {
 const c=value as OrganizerConfig;
 const fail=()=>{throw Error('Invalid organizer configuration; see docs/configuration.md');};
 const record=(v:unknown)=>!!v&&typeof v==='object'&&!Array.isArray(v);
 const text=(v:unknown,max=200)=>typeof v==='string'&&v.trim()===v&&v.length>0&&v.length<=max&&!/[\x00-\x1f]/.test(v);
 const color=(v:unknown)=>typeof v==='string'&&/^(none|preset([0-9]|1[0-9]|2[0-4]))$/.test(v);
 const exactKeys=(v:object,keys:string[])=>Object.keys(v).sort().join()===keys.sort().join();
 if(!record(c)||c.version!==1||!text(c.ownerContext,2000)||!text(c.organizationContext,4000)||!text(c.model,100)||!text(c.timeZone,100))fail();
 if(!exactKeys(c,['version','ownerContext','organizationContext','timeZone','model','lookbackDays','dailyLimit','maxBodyCharacters','routing','types','attention','actions','review']))fail();
 try{new Intl.DateTimeFormat('en',{timeZone:c.timeZone});}catch{fail();}
 for(const [v,min,max] of [[c.lookbackDays,1,30],[c.dailyLimit,1,250],[c.maxBodyCharacters,1000,50000]])if(!Number.isInteger(v)||v!<min!||v!>max!)fail();
 if(!record(c.routing)||!exactKeys(c.routing,['choiceConfidence','choiceProbability','securityHold','fileTruncatedMessages'])||typeof c.routing.fileTruncatedMessages!=='boolean')fail();
 for(const v of [c.routing.choiceConfidence,c.routing.choiceProbability,c.routing.securityHold])if(typeof v!=='number'||!Number.isFinite(v)||v<0||v>1)fail();
 const labels:string[]=[];
 const checkLabel=(l:Label)=>{if(!record(l)||!exactKeys(l,['name','color'])||!text(l.name,60)||!color(l.color)||l.name.startsWith('JEV-'))fail();labels.push(l.name.toLowerCase());};
 for(const [group,keys] of [[c.attention,['now','soon','informational','none']],[c.actions,['reply','review_investigate','approve_decide','order_buy','delegate','reference','archive','other']],[c.review,['needsReview','securityReview']]] as const){
  if(!record(group)||Object.keys(group).sort().join()!==[...keys].sort().join())fail();for(const l of Object.values(group))checkLabel(l);
 }
 if(!record(c.types)||Object.keys(c.types).length<2||Object.keys(c.types).length>30)fail();
 for(const [key,v] of Object.entries(c.types)){
  if(!/^[a-z][a-z0-9_]{0,47}$/.test(key)||['constructor','prototype','__proto__'].includes(key)||!record(v)||!exactKeys(v,['description','folder','color','routine'])||!text(v.description,2000)||!text(v.folder,60)||/[\\/]/.test(v.folder)||['inbox','old folders','search folders'].includes(v.folder.toLowerCase())||typeof v.routine!=='boolean')fail();
  checkLabel({name:v.folder,color:v.color});
 }
 if(new Set(labels).size!==labels.length)fail();return c;
}
export const CONFIG=validateConfig(input);
export const PROFILE_ID=JSON.stringify(CONFIG);
