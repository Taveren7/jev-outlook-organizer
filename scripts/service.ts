import {CONFIG} from '../src/config';
import {existsSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {parseArgs} from 'node:util';

try{
  if(existsSync('.env'))process.loadEnvFile('.env');
  const {values,positionals}=parseArgs({options:{limit:{type:'string'},mode:{type:'string'},file:{type:'string'},id:{type:'string'},after:{type:'string'}},allowPositionals:true});
  const command=positionals[0]??'status';
  if(!['status','pause','resume','scan','run','jobs','seed','promote','audit','catchup'].includes(command))throw Error('invalid_command');
  const base=new URL(process.env.JEV_SERVICE_URL!);
  if(base.protocol!=='https:'||!base.hostname.endsWith('.workers.dev')||base.username||base.password||base.search||base.hash)throw Error('invalid_url');
  const token=process.env.ADMIN_TOKEN;if(!token||token.length<32)throw Error('missing_token');
  const method=['status','jobs','audit'].includes(command)?'GET':'POST';
  const body=command==='resume'?{dailyLimit:Number(values.limit??CONFIG.dailyLimit),mode:values.mode??'observe'}:command==='seed'?JSON.parse(readFileSync(values.file!,'utf8')):command==='promote'?{id:values.id,mode:values.mode??'type-folders'}:{};
  const response=await fetch(new URL('/admin/'+command+(command==='audit'?'?after='+encodeURIComponent(values.after??'0'):''),base),{method,redirect:'error',signal:AbortSignal.timeout(120_000),headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(method==='POST'?{body:JSON.stringify(body)}:{})});
  if(!response.ok)throw Error(`service_${response.status}`);
  const result=await response.json();
  if(['jobs','audit'].includes(command)){
    mkdirSync('private/service',{recursive:true,mode:0o700});
    const path=`private/service/${command}-${Date.now()}.json`;writeFileSync(path,JSON.stringify(result,null,2),{mode:0o600});console.log(JSON.stringify({saved:path,rows:(result as unknown[]).length}));
  }else console.log(JSON.stringify(result,null,2));
}catch(error){const status=error instanceof Error?/^service_\d{3}$/.test(error.message)?error.message:'request_failed':'request_failed';console.error(`Service command failed (${status}); check local configuration and service status. Private details withheld.`);process.exitCode=1;}
