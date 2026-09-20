import {authorized} from './auth';
import type {ProductionEnv} from './production/coordinator';
export {MailboxCoordinator} from './production/coordinator';
const coordinator=(env:ProductionEnv)=>env.COORDINATOR.get(env.COORDINATOR.idFromName('primary'));
export default {
  async fetch(request:Request,env:ProductionEnv):Promise<Response>{
    const url=new URL(request.url);
    if(request.method==='GET'&&url.pathname==='/health')return Response.json({service:'jev-outlook',version:1});
    if(!url.pathname.startsWith('/admin/')||!await authorized(request,env.ADMIN_TOKEN))return Response.json({error:'unauthorized'},{status:401});
    if(!['GET','POST'].includes(request.method))return new Response(null,{status:405});
    const body=request.method==='POST'?await request.text():undefined;
    if(body&&body.length>262144)return Response.json({error:'too_large'},{status:413});
    try{return await coordinator(env).fetch('https://coordinator/'+url.pathname.slice(7)+url.search,{method:request.method,body,headers:{'Content-Type':'application/json'}}) as unknown as Response;}
    catch{return Response.json({error:'service_unavailable'},{status:503,headers:{'Cache-Control':'no-store'}});}
  },
  async scheduled(_event:unknown,env:ProductionEnv){await coordinator(env).fetch('https://coordinator/run',{method:'POST'});},
};
