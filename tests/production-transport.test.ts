import {test} from 'node:test';
import assert from 'node:assert/strict';
import {retryAfter,throttled} from '../src/production/transport';
import {RemoteError} from '../src/production/core';

test('provider cooldown honors seconds, dates and millisecond hints without shortening long Retry-After',()=>{
 const now=Date.parse('2026-09-20T12:00:00Z');
 assert.equal(retryAfter(new Headers({'retry-after':'90'}),now),90000);
 assert.equal(retryAfter(new Headers({'retry-after':'172800'}),now),172800000);
 assert.equal(retryAfter(new Headers({'retry-after':new Date(now+120000).toUTCString()}),now),120000);
 assert.equal(retryAfter(new Headers({'retry-after-ms':'2500'}),now),2500);
 assert.equal(retryAfter(new Headers({'retry-after':'invalid'}),now),60000);
});
test('SDK-wrapped rate limits preserve their cooldown without inspecting private messages',()=>{
 const cause=new RemoteError('jev_429',90000);const wrapped=new Error('private provider error',{cause});
 assert.equal(throttled(wrapped),cause);assert.equal(throttled(new RemoteError('graph_404')),undefined);
});
