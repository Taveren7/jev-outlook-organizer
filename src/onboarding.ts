import {CONFIG,PROFILE_ID} from './config';
import {TYPE_NAMES} from './outlook-layout';
import type {Layout,Folder} from './production/core';
export interface SetupGraph {request(path:string,method?:string,body?:unknown):Promise<any>}
export interface MailboxPlan {version:1;createdAt:number;account:string;profile:string;inbox:Folder;folders:Array<{type:string;name:string;existingId:string|null}>;categories:Array<{name:string;color:string;existingId:string|null;existingColor:string|null}>}
export const categoryDefinitions=()=>[...Object.values(CONFIG.types).map(t=>({name:t.folder,color:t.color})),...Object.values(CONFIG.attention),...Object.values(CONFIG.actions),...Object.values(CONFIG.review)];
export async function listAll(mail:SetupGraph,path:string,account:string){
 const rows:any[]=[];let current:string|undefined=path;const seen=new Set<string>();
 for(let page=0;current&&page<100;page++){
  if(seen.has(current))throw Error('setup_pagination');seen.add(current);const r=await mail.request(current);
  if(!Array.isArray(r.value))throw Error('setup_inventory');rows.push(...r.value);
  // Reuse only the continuation query on the originally selected resource. The Graph adapter
  // keeps the account/host fixed. Reject unrelated hosts or a changed resource suffix.
  current=undefined;if(r['@odata.nextLink']){
   const u=new URL(r['@odata.nextLink']);const suffix=path.split('?')[0]!;
   const normalized=decodeURIComponent(u.pathname).replace(/\/mailFolders\('([^']+)'\)/g,'/mailFolders/$1');
   if(u.origin!=='https://graph.microsoft.com'||u.username||u.password||u.hash||normalized!=='/v1.0/users/'+encodeURIComponent(account)+suffix)throw Error('setup_pagination');current=suffix+u.search;
  }
 }
 if(current)throw Error('setup_incomplete');return rows;
}
function match(rows:any[],name:string){const found=rows.filter(r=>typeof r.displayName==='string'&&r.displayName.toLowerCase()===name.toLowerCase());if(found.length>1||found[0]&&found[0].displayName!==name)throw Error('setup_ambiguous_name');return found[0];}
export async function planMailbox(mail:SetupGraph,account:string):Promise<MailboxPlan>{
 const inbox=await mail.request('/mailFolders/inbox?$select=id,displayName,parentFolderId');
 const folders=await listAll(mail,`/mailFolders/${encodeURIComponent(inbox.id)}/childFolders?$top=100`,account);
 const categories=await listAll(mail,'/outlook/masterCategories?$top=100',account);
 return {version:1,createdAt:Date.now(),account,profile:PROFILE_ID,inbox,
  folders:Object.entries(TYPE_NAMES).map(([type,name])=>({type,name,existingId:match(folders,name)?.id??null})),
  categories:categoryDefinitions().map(({name,color})=>{const current=match(categories,name);return {name,color,existingId:current?.id??null,existingColor:current?.color??null};})};
}
export async function applyMailboxPlan(mail:SetupGraph,account:string,plan:MailboxPlan):Promise<Layout>{
 if(plan.version!==1||plan.account!==account||plan.profile!==PROFILE_ID||plan.createdAt>Date.now()||Date.now()-plan.createdAt>3600000)throw Error('setup_plan_expired_or_changed');
 const fresh=await planMailbox(mail,account);
 if(plan.inbox.id!==fresh.inbox.id||JSON.stringify(plan.folders)!==JSON.stringify(fresh.folders)||JSON.stringify(plan.categories)!==JSON.stringify(fresh.categories))throw Error('setup_state_changed_preview_again');
 const folders:Layout['folders']={};
 for(const row of plan.folders){
  const f=row.existingId?await mail.request(`/mailFolders/${encodeURIComponent(row.existingId)}?$select=id,displayName,parentFolderId`):await mail.request(`/mailFolders/${encodeURIComponent(plan.inbox.id)}/childFolders`,'POST',{displayName:row.name});
  if(typeof f.id!=='string'||f.displayName!==row.name||f.parentFolderId!==plan.inbox.id)throw Error('setup_folder_verification');folders[row.type]={id:f.id,displayName:f.displayName,parentFolderId:f.parentFolderId};
 }
 for(const row of plan.categories)if(!row.existingId){const c=await mail.request('/outlook/masterCategories','POST',{displayName:row.name,color:row.color});if(c.displayName!==row.name||c.color!==row.color)throw Error('setup_category_verification');}
 const verified=await planMailbox(mail,account);
 if(verified.folders.some(f=>f.existingId!==folders[f.type]?.id)||verified.categories.some(c=>!c.existingId))throw Error('setup_verification');
 return {mailboxId:account,inboxId:plan.inbox.id,folders};
}
export async function setupSearches(mail:SetupGraph,layout:Layout,apply=false){
 const parent=await mail.request('/mailFolders/searchfolders?$select=id');
 const existing=await listAll(mail,`/mailFolders/${encodeURIComponent(parent.id)}/childFolders?$top=100`,layout.mailboxId);
 const sources=[layout.inboxId,...Object.values(layout.folders).map(f=>f.id)];const results=[];
 for(const label of [CONFIG.attention.now.name,CONFIG.attention.soon.name,CONFIG.review.needsReview.name]){
  const filterQuery=`(categories/any(c:c eq '${label.replaceAll("'","''")}')) and flag/flagStatus ne 'complete'`;
  const found=match(existing,label);
  const check=(f:any)=>{if(f.includeNestedFolders!==false||f.filterQuery!==filterQuery||JSON.stringify([...f.sourceFolderIds].sort())!==JSON.stringify([...sources].sort()))throw Error('setup_search_changed');};
  if(found)check(await mail.request(`/mailFolders/${encodeURIComponent(found.id)}`));
  if(!found&&apply){const f=await mail.request(`/mailFolders/${encodeURIComponent(parent.id)}/childFolders`,'POST',{'@odata.type':'microsoft.graph.mailSearchFolder',displayName:label,includeNestedFolders:false,sourceFolderIds:sources,filterQuery});check(await mail.request(`/mailFolders/${encodeURIComponent(f.id)}`));}
  results.push({name:label,operation:found?'reuse':apply?'created':'would-create'});
 }
 return results;
}
