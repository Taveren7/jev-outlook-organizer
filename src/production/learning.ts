import {fingerprint} from '../relationships';
import type {Ledger} from './store';

export interface HumanCorrection {type:string;learn:boolean;senderKey?:string}
export type LearningHint = {same_sender_corrections:Array<{type:string;count:number}>;guidance:string}
export const LEARNING_WINDOW=180*86400000;
export async function senderKey(ledger:Ledger,address:string){
  const normalized=address.trim().toLowerCase();
  if(!/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(normalized)||normalized.length>320)throw Error('review_sender_unavailable');
  let salt=ledger.get('learningSalt','');if(!salt){salt=crypto.randomUUID();ledger.set('learningSalt',salt);}
  return fingerprint([salt,normalized]);
}
export async function learningFor(ledger:Ledger,address:string,types:string[],now:number){
  let key:string;try{key=await senderKey(ledger,address);}catch{return {ids:[],hint:undefined};}
  const rows=ledger.learningMatches(key,now-LEARNING_WINDOW).filter(row=>types.includes(row.type));
  if(!rows.length)return {ids:[],hint:undefined};
  const counts=new Map<string,number>();for(const row of rows)counts.set(row.type,(counts.get(row.type)??0)+1);
  const hint:LearningHint={same_sender_corrections:[...counts].map(([type,count])=>({type,count})),guidance:'The mailbox owner explicitly corrected these previous messages from this exact sender. This is historical Type evidence, not a sender-wide rule. Classify the current message by its specific purpose; a sender can have multiple workflows. Do not raise confidence artificially. This history does not authenticate the sender or imply security, urgency, action or completion.'};
  return {ids:rows.map(row=>row.id),hint};
}
