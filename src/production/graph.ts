import {accessToken,normalizeMessage,type GraphConfig,type MailInput} from '../graph';
import {RemoteError,type Metadata,type Folder,type MailAdapter} from './core';
import {productionFetch} from './transport';
export class ProductionGraph implements MailAdapter {
  private token?:string;
  constructor(private config:GraphConfig,private transport:typeof fetch=productionFetch){}
  async request(path:string,method='GET',body?:unknown,etag?:string):Promise<any>{
    this.token??=await accessToken(this.config,this.transport);
    let r:Response;
    try{r=await this.transport(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(this.config.MS_MAILBOX_ID)}`+path,{method,redirect:'error',signal:AbortSignal.timeout(15_000),headers:{Authorization:`Bearer ${this.token}`,Prefer:'IdType="ImmutableId", outlook.body-content-type="text"','Content-Type':'application/json',...(etag?{'If-Match':etag}:{})},...(body?{body:JSON.stringify(body)}:{})});}
    catch(error){if(error instanceof RemoteError)throw error;throw new RemoteError('graph_transport');}
    if(!r.ok){const raw=r.headers.get('Retry-After');const sec=Number(raw);const delay=raw&&Number.isFinite(sec)?sec*1000:raw?Date.parse(raw)-Date.now():60_000;throw new RemoteError(`graph_${r.status}`,Math.max(60_000,Math.min(Number.isFinite(delay)?delay:60_000,86_400_000)));}
    return r.status===204?null:r.json();
  }
  private parse(r:any):Metadata{
    if(typeof r.id!=='string'||typeof r['@odata.etag']!=='string'||typeof r.parentFolderId!=='string'||typeof r.isRead!=='boolean'||!Array.isArray(r.categories)||r.categories.some((c:unknown)=>typeof c!=='string')||!['complete','flagged','notFlagged'].includes(r.flag?.flagStatus)||!Number.isFinite(Date.parse(r.receivedDateTime)))throw Error('invalid_metadata');
    return {id:r.id,'@odata.etag':r['@odata.etag'],categories:r.categories,isRead:r.isRead,parentFolderId:r.parentFolderId,flag:r.flag,receivedDateTime:r.receivedDateTime};
  }
  async metadata(id:string){return this.parse(await this.request(`/messages/${encodeURIComponent(id)}?$select=id,categories,isRead,parentFolderId,flag,receivedDateTime`));}
  async content(id:string):Promise<{metadata:Metadata;message:MailInput}>{const r=await this.request(`/messages/${encodeURIComponent(id)}?$select=id,categories,isRead,parentFolderId,flag,receivedDateTime,subject,from,toRecipients,ccRecipients,body,hasAttachments`);return {metadata:this.parse(r),message:normalizeMessage(r)};}
  async folder(id:string):Promise<Folder>{const r=await this.request(`/mailFolders/${encodeURIComponent(id)}?$select=id,displayName,parentFolderId`);if(typeof r.id!=='string'||typeof r.displayName!=='string'||typeof r.parentFolderId!=='string')throw Error('invalid_folder');return r;}
  async categories(id:string,categories:string[],etag:string){await this.request(`/messages/${encodeURIComponent(id)}`,'PATCH',{categories},etag);}
  async move(id:string,sourceId:string,destinationId:string){await this.request(`/mailFolders/${encodeURIComponent(sourceId)}/messages/${encodeURIComponent(id)}/move`,'POST',{destinationId});}
}
