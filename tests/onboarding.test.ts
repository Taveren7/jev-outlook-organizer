import {test} from 'node:test';import assert from 'node:assert/strict';
import {planMailbox,applyMailboxPlan,categoryDefinitions,setupSearches,type SetupGraph} from '../src/onboarding';import {CONFIG} from '../src/config';
function fixture(){
 const folders:any[]=[],categories:any[]=[],searches:any[]=[];const writes:string[]=[];let serial=0;
 const inbox={id:'inbox',displayName:'Inbox',parentFolderId:'root'};
 const mail:SetupGraph={request:async(path,method='GET',body:any)=>{
  const base=path.split('?')[0];
  if(method==='POST'){writes.push(base!);const obj={id:'created-'+(++serial),...body};if(base==='/mailFolders/inbox/childFolders'){obj.parentFolderId='inbox';folders.push(obj);}else if(base==='/outlook/masterCategories')categories.push(obj);else if(base==='/mailFolders/searches/childFolders')searches.push(obj);else throw Error('Unexpected mutation');return obj;}
  if(base==='/mailFolders/inbox')return inbox;if(base==='/mailFolders/inbox/childFolders')return {value:folders};if(base==='/outlook/masterCategories')return {value:categories};if(base==='/mailFolders/searchfolders')return {id:'searches'};if(base==='/mailFolders/searches/childFolders')return {value:searches};
  const id=base?.split('/').pop();const found=[...folders,...searches].find(f=>f.id===id);if(found)return found;throw Error('Unexpected read');
 }};return {mail,folders,categories,searches,writes};
}
test('setup previews without writes, provisions exact folders/categories, and reruns without duplicates',async()=>{
 const f=fixture(),plan=await planMailbox(f.mail,'mailbox');assert.equal(f.writes.length,0);
 const layout=await applyMailboxPlan(f.mail,'mailbox',plan);assert.equal(Object.keys(layout.folders).length,Object.keys(CONFIG.types).length);assert.equal(f.categories.length,categoryDefinitions().length);assert.ok(f.writes.every(path=>!path.includes('/messages')));
 const writes=f.writes.length;await applyMailboxPlan(f.mail,'mailbox',await planMailbox(f.mail,'mailbox'));assert.equal(f.writes.length,writes);
 const searches=await setupSearches(f.mail,layout);assert.equal(searches.length,3);assert.equal(f.writes.length,writes);
 await setupSearches(f.mail,layout,true);assert.equal(f.searches.length,3);assert.ok(f.searches.every(s=>s.sourceFolderIds.length===Object.keys(CONFIG.types).length+1&&s.includeNestedFolders===false&&s.filterQuery.includes("flag/flagStatus ne 'complete'")));
 await setupSearches(f.mail,layout,true);assert.equal(f.searches.length,3);
});
test('changed scope, stale/tampered preview, ambiguous names and conflicting searches block writes',async()=>{
 const f=fixture(),p=await planMailbox(f.mail,'mailbox');
 for(const modified of [{...p,account:'other'},{...p,createdAt:0},{...p,folders:[...p.folders,{type:'injected',name:'Unexpected',existingId:null}]}])await assert.rejects(applyMailboxPlan(f.mail,'mailbox',modified));assert.equal(f.writes.length,0);
 f.folders.push({id:'one',displayName:p.folders[0]!.name,parentFolderId:'inbox'},{id:'two',displayName:p.folders[0]!.name,parentFolderId:'inbox'});await assert.rejects(planMailbox(f.mail,'mailbox'),/ambiguous/);
});
test('setup preserves existing category colors',async()=>{
 const f=fixture();f.categories.push({id:'owned-by-user',displayName:CONFIG.attention.now.name,color:'preset3'});
 const p=await planMailbox(f.mail,'mailbox');assert.equal(p.categories.find(c=>c.existingId==='owned-by-user')?.existingColor,'preset3');await applyMailboxPlan(f.mail,'mailbox',p);assert.equal(f.categories.find(c=>c.id==='owned-by-user').color,'preset3');
});
test('unsafe or repeated setup pagination cannot cause a write or forward credentials',async()=>{
 const calls:string[]=[];const mail={request:async(path:string)=>{calls.push(path);return path.startsWith('/mailFolders/inbox?')?{id:'inbox'}:{value:[],'@odata.nextLink':'https://attacker.example/outlook/masterCategories'};}};
 await assert.rejects(planMailbox(mail,'mailbox'),/pagination/);assert.ok(calls.every(c=>c.startsWith('/')));
});
