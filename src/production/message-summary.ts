// Live display data only. Never persist this response in jobs, reviews or audit records.
const text=(value:unknown,max:number)=>typeof value==='string'?value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,' ').replace(/\s+/g,' ').trim().slice(0,max):'';
export function messageSummary(item:any){
  return {subject:text(item?.subject,500),senderName:text(item?.from?.emailAddress?.name,200),senderAddress:text(item?.from?.emailAddress?.address,320),snippet:text(item?.bodyPreview,255)};
}
export function outlookWebLink(value:unknown){
  if(typeof value!=='string')throw Error('invalid_link');
  const link=new URL(value);
  if(link.protocol!=='https:'||link.username||link.password||link.port||!['outlook.office.com','outlook.office365.com','outlook.cloud.microsoft'].includes(link.hostname))throw Error('invalid_link');
  return link.href;
}
