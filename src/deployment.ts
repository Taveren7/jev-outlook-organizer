// Deployment preflight reads metadata only. Credentials and provider responses must not be logged.
export interface DeploymentTarget {accountId:string;workerName:string;serviceUrl:string;exists:boolean}
export interface DeploymentPlan {target:DeploymentTarget;profile:string;layout:string;createdAt:number;runtimeConfigHash?:string}
export function serviceUrl(value:string):URL {
 const url=new URL(value);
 if(url.protocol!=='https:'||!/^[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/.test(url.hostname)||url.port||url.pathname!=='/'||url.username||url.password||url.search||url.hash)throw Error('Invalid service URL.');
 return url;
}
export async function discoverTarget(accountId:string,workerName:string,token:string,request:typeof fetch=fetch):Promise<DeploymentTarget>{
 if(!/^[a-f0-9]{32}$/.test(accountId))throw Error('Set your CLOUDFLARE_ACCOUNT_ID from Wrangler whoami.');
 if(!/^[a-z][a-z0-9-]{2,62}$/.test(workerName))throw Error('Set your own valid WORKER_NAME.');
 if(!token)throw Error('Deployment check failed; log in to Cloudflare again.');
 const read=async(path:string)=>{
  const response=await request(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/${path}`,{redirect:'error',headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw Error('Deployment check failed; verify Cloudflare account access.');
  const body=await response.json() as any;
  if(body.success!==true||body.result===undefined)throw Error('Deployment check failed; invalid Cloudflare response.');
  return body;
 };
 const [scripts,domain]=await Promise.all([read('scripts'),read('subdomain')]);
 if(!Array.isArray(scripts.result)||scripts.result.some((s:any)=>!s||typeof s.id!=='string')||
    (scripts.result_info?.total_count!==undefined&&scripts.result_info.total_count!==scripts.result.length)||
    !/^[a-z0-9-]+$/.test(domain.result?.subdomain??''))throw Error('Deployment check failed; incomplete Cloudflare metadata.');
 return {accountId,workerName,serviceUrl:`https://${workerName}.${domain.result.subdomain}.workers.dev`,exists:scripts.result.some((s:any)=>s.id===workerName)};
}
export async function verifyPaused(target:DeploymentTarget,configuredUrl:string|undefined,adminToken:string,request:typeof fetch=fetch){
 if(configuredUrl&&serviceUrl(configuredUrl).origin!==target.serviceUrl)throw Error('Deployment target differs from JEV_SERVICE_URL; check the account and Worker name.');
 if(!target.exists)return;
 if(!configuredUrl)throw Error('Deployment target already exists. Set its JEV_SERVICE_URL and pause it before updating.');
 const response=await request(new URL('/admin/status',target.serviceUrl),{redirect:'error',headers:{Authorization:`Bearer ${adminToken}`},signal:AbortSignal.timeout(15000)});
 if(!response.ok)throw Error('Deployment check failed; could not authenticate to the target Worker.');
 const status=await response.json() as any;
 if(status.service!=='jev-outlook'||status.policy!=='public-v1'||status.paused!==true||status.busy!==false)throw Error('Pause the target public organizer and wait until it is idle before deployment.');
}
export function verifyDeploymentPlan(plan:DeploymentPlan,target:DeploymentTarget,profile:string,layout:string,now=Date.now(),runtimeConfigHash?:string){
 if(!plan||!Number.isFinite(plan.createdAt)||now<plan.createdAt||now-plan.createdAt>3600000||JSON.stringify(plan.target)!==JSON.stringify(target)||plan.profile!==profile||plan.layout!==layout||plan.runtimeConfigHash!==runtimeConfigHash)throw Error('Deployment preview is missing or stale; run npm run deploy again before applying.');
}
