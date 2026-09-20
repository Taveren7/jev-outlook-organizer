import type {MailInput} from './graph';
export interface Relationships {version:1;domains:Partial<Record<'customer'|'supplier'|'internal',string[]>>;defaults:Partial<Record<'customer'|'supplier'|'internal',string>>;senders?:Array<{address:string;relationship:'customer'|'supplier'|'internal'}>}
const roles=['customer','supplier','internal'] as const;
export function parseRelationships(raw:string|undefined,types:string[]):Relationships|undefined {
 if(!raw)return undefined;if(raw.length>32000)throw Error('relationships_invalid');
 let c:Relationships;try{c=JSON.parse(raw);}catch{throw Error('relationships_invalid');}
 const record=(v:unknown)=>!!v&&typeof v==='object'&&!Array.isArray(v);
 const fail=()=>{throw Error('relationships_invalid');};
 if(!record(c)||c.version!==1||Object.keys(c).some(k=>!['version','domains','defaults','senders'].includes(k))||!record(c.domains)||!record(c.defaults))fail();
 const seen=new Set<string>();
 for(const role of Object.keys(c.domains)){
  if(!roles.includes(role as any))fail();const domains=c.domains[role as keyof typeof c.domains];
  if(!Array.isArray(domains)||domains.length>200)fail();
  for(const domain of domains!){if(typeof domain!=='string'||domain!==domain.toLowerCase()||!validDomain(domain)||seen.has(domain))fail();seen.add(domain);}
 }
 for(const [role,type] of Object.entries(c.defaults))if(!roles.includes(role as any)||!types.includes(type))fail();
 if(c.senders!==undefined){if(!Array.isArray(c.senders)||c.senders.length>200)fail();const addresses=new Set<string>();for(const s of c.senders!){if(!record(s)||Object.keys(s).sort().join()!=='address,relationship'||typeof s.address!=='string'||s.address!==s.address.toLowerCase()||!addressDomain(s.address)||!roles.includes(s.relationship)||addresses.has(s.address))fail();addresses.add(s.address);}}
 return c;
}
function validDomain(s:string){return s.length<=253&&s.includes('.')&&s.split('.').every(x=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(x));}
export function addressDomain(address:string):string|null {const s=address.trim().toLowerCase(),m=/^[^\s<>@]+@([^@]+)$/.exec(s);return m&&validDomain(m[1]!)?m[1]!:null;}
export function relationshipContext(message:MailInput,c:Relationships){
 const identify=(address:string)=>{const domain=addressDomain(address);if(!domain)return 'unknown';const sender=c.senders?.find(s=>s.address===address.trim().toLowerCase());return sender?.relationship??roles.find(r=>c.domains[r]?.includes(domain))??'unknown';};
 const sender=identify(message.from);
 return {sender_relationship:sender,default_type:sender==='unknown'?null:c.defaults[sender]??null,customer_in_to:message.to.some(a=>identify(a)==='customer'),customer_in_cc:message.cc.some(a=>identify(a)==='customer'),interpretation:'Owner-configured exact sender/address-domain relationships provide workflow defaults only. Specific message purpose takes precedence. Domain matches do not authenticate senders or imply safety, urgency, completion or confidence. Quoted addresses and display names are not relationship evidence.'};
}
export async function fingerprint(value:unknown){const bytes=new TextEncoder().encode(JSON.stringify(value));return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');}
