import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inventoryInbox } from '../src/backfill';
const config = { MS_TENANT_ID:'tenant',MS_CLIENT_ID:'client',MS_CLIENT_SECRET:'secret',MS_MAILBOX_ID:'mailbox' };
const asOf='2026-09-20T00:00:00Z';
const item=(id:string,change:Record<string,unknown>={})=>({id,receivedDateTime:'2026-09-19T00:00:00Z',categories:[],isRead:false,flag:{flagStatus:'notFlagged'},...change});
function transport(pages:unknown[]) {
  const calls:Array<{url:string;init?:RequestInit}>=[];let page=0;
  const fetcher:typeof fetch=async (url,init)=>{calls.push({url:String(url),init});return Response.json(calls.length===1?{access_token:'token'}:pages[page++]);};
  return {calls,fetcher};
}
test('30-day inventory paginates without mail content or writes and separates prior work',async()=>{
  const {calls,fetcher}=transport([{value:[item('new'),item('tagged',{categories:['Now']}),item('read',{isRead:true})],
    '@odata.nextLink':"https://graph.microsoft.com/v1.0/users/mailbox/mailFolders('inbox')/messages?$skip=3"},
  {value:[item('reviewed'),item('done',{flag:{flagStatus:'complete'}}),item('new')]}]);
  const r=await inventoryInbox(config,{asOf,reviewedIds:new Set(['reviewed'])},fetcher);
  assert.equal(r.since,'2026-08-21T00:00:00.000Z');assert.equal(r.complete,true);assert.equal(r.items.length,5);
  assert.deepEqual(r.counts,{already_organized:1,completed:1,previously_reviewed:1,needs_classification:2});
  assert.ok(calls.slice(1).every(c=>c.init?.method==='GET'&&!/subject|sender|body|from/i.test(new URL(c.url).searchParams.get('$select')??'')));
});
test('unsafe pagination cannot receive the mailbox token',async()=>{
  for(const next of ['https://evil.example/path','https://graph.microsoft.com/v1.0/users/other/mailFolders/inbox/messages','https://user:pass@graph.microsoft.com/v1.0/users/mailbox/mailFolders/inbox/messages']){
    const {calls,fetcher}=transport([{value:[], '@odata.nextLink':next}]);
    await assert.rejects(inventoryInbox(config,{asOf},fetcher),/pagination/);assert.equal(calls.length,2);
  }
});
test('invalid bounds fail before authentication; age filtering never becomes expiration',async()=>{
  const {calls,fetcher}=transport([]);
  for(const days of [0,31,Infinity,1.5])await assert.rejects(inventoryInbox(config,{asOf,days},fetcher));
  assert.equal(calls.length,0);
  for(const receivedDateTime of ['2026-08-20T23:59:59Z','2026-09-20T00:00:01Z']){
    const t=transport([{value:[item('outside',{receivedDateTime})]}]);
    await assert.rejects(inventoryInbox(config,{asOf},t.fetcher),/outside/);
  }
});
test('page limit is explicitly incomplete, not a successful whole-inbox scan',async()=>{
  const {fetcher}=transport([{value:[item('a')],'@odata.nextLink':'https://graph.microsoft.com/v1.0/users/mailbox/mailFolders/inbox/messages?$skip=1'}]);
  const r=await inventoryInbox(config,{asOf,maxPages:1},fetcher);assert.equal(r.complete,false);assert.equal(r.pages,1);
});
