// Return redirects to the caller so every provider's status check rejects them.
// Never forward credentials to a redirect destination.
export const productionFetch:typeof fetch=async(input,init)=>{
  const response=await fetch(input,{...init,redirect:'manual'});
  if([429,503].includes(response.status)){
    const host=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url).hostname;
    throw new RemoteError(`${host==='api.typesafe.ai'?'jev':'graph'}_${response.status}`,retryAfter(response.headers));
  }
  return response;
};

import {RemoteError} from './core';
export function retryAfter(headers:Headers,now=Date.now()):number {
  const raw=headers.get('retry-after'),milliseconds=headers.get('retry-after-ms');
  const delay=raw!==null?(Number.isFinite(Number(raw))?Number(raw)*1000:Date.parse(raw)-now):milliseconds!==null?Number(milliseconds):60_000;
  return Math.max(1000,Number.isFinite(delay)?delay:60_000);
}
export function throttled(error:unknown):RemoteError|undefined {
  // The SDK wraps transport errors in APIConnectionError. Inspect causes, never their private messages.
  for(let depth=0;depth<4&&error instanceof Error;depth++,error=error.cause){
    if(error instanceof RemoteError&&/_(429|503)$/.test(error.code))return error;
  }
}
