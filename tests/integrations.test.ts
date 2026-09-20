import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readMessage, latestInboxMessageId, recentInboxReferences, normalizeMessage, type MailInput } from '../src/graph';
import { classifyMessage, prepareState } from '../src/jev';
import { sample } from '../fixtures/examples';

const config = { MS_TENANT_ID: 'tenant', MS_CLIENT_ID: 'client', MS_CLIENT_SECRET: 'fake-secret', MS_MAILBOX_ID: 'owner@example.test' };
export const message: MailInput = { id: 'sample', subject: 'Replacement filter', from: 'sender@example.test', to: ['owner@example.test'], cc: [], receivedAt: '2026-09-19T12:00:00Z', bodyText: 'Please order the replacement filter.', hasAttachments: false };
const graphMessage = { id: message.id, subject: message.subject, from: { emailAddress: { address: message.from } }, toRecipients: message.to.map(address => ({ emailAddress: { address } })), ccRecipients: [], receivedDateTime: message.receivedAt, body: { contentType: 'text', content: message.bodyText }, hasAttachments: false };

test('Graph uses a configured mailbox, text body, escaped ID and read-only request', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const result = await readMessage(config, 'id/with+symbols=', async (input, init) => {
    calls.push({ url: String(input), init });
    return Response.json(calls.length === 1 ? { access_token: 'fake-token' } : graphMessage);
  });
  assert.deepEqual(result, message);
  assert.equal(calls[0]!.init!.method, 'POST');
  assert.equal(calls[1]!.init!.method, 'GET');
  assert.match(calls[1]!.url, /users\/owner%40example.test\/messages\/id%2Fwith%2Bsymbols%3D/);
  assert.match(new Headers(calls[1]!.init!.headers).get('Prefer')!, /outlook.body-content-type="text"/);
});
test('Graph stops on authentication failure and does not expose upstream error bodies', async () => {
  let calls = 0;
  await assert.rejects(readMessage(config, 'id', async () => { calls++; return new Response('private upstream data', { status: 401 }); }), /^Error: Microsoft authentication failed$/);
  assert.equal(calls, 1);
});
test('non-text and incomplete Graph messages are rejected', () => {
  assert.throws(() => normalizeMessage({ ...graphMessage, body: { contentType: 'html', content: '<p>text</p>' } }));
  assert.throws(() => normalizeMessage({ ...graphMessage, hasAttachments: undefined }));
});
test('inbox probe requests only the newest immutable ID and handles an empty Inbox', async () => {
  for (const entries of [[], [{ id: 'newest' }]]) {
    let calls = 0;
    const id = await latestInboxMessageId(config, async (input, init) => {
      if (++calls === 1) return Response.json({ access_token: 'fake-token' });
      const url = new URL(String(input));
      assert.equal(init?.method, 'GET');
      assert.equal(url.searchParams.get('$select'), 'id');
      assert.equal(url.searchParams.get('$top'), '1');
      assert.equal(url.searchParams.get('$orderby'), 'receivedDateTime desc');
      assert.match(url.pathname, /\/mailFolders\/inbox\/messages$/);
      assert.equal(new Headers(init?.headers).get('Prefer'), 'IdType="ImmutableId"');
      return Response.json({ value: entries });
    });
    assert.equal(id, entries[0]?.id ?? null);
  }
});
test('inbox probe rejects forbidden and malformed responses', async () => {
  for (const response of [new Response('private', { status: 403 }), Response.json({}), Response.json({ value: [{ id: 12 }] })]) {
    let calls = 0;
    await assert.rejects(latestInboxMessageId(config, async () => ++calls === 1 ? Response.json({ access_token: 'fake-token' }) : response));
  }
});
test('review references are bounded, request no content, and validate Outlook links', async () => {
  for (const count of [0, 21, 1.5]) {
    let contacted = false;
    await assert.rejects(recentInboxReferences(config, count, async () => { contacted = true; throw new Error('Must not contact Graph'); }));
    assert.equal(contacted, false);
  }
  for (const webLink of ['https://outlook.office.com/mail/item/1', 'https://untrusted.example/mail', 'javascript:alert(1)']) {
    let calls = 0;
    const promise = recentInboxReferences(config, 10, async (input, init) => {
      if (++calls === 1) return Response.json({ access_token: 'fake-token' });
      const url = new URL(String(input));
      assert.equal(init?.method, 'GET');
      assert.equal(url.searchParams.get('$select'), 'id,receivedDateTime,webLink');
      assert.equal(url.searchParams.get('$top'), '10');
      return Response.json({ value: [{ id: 'one', receivedDateTime: message.receivedAt, webLink }] });
    });
    if (webLink.startsWith('https://outlook.office.com/')) assert.equal((await promise)[0]?.id, 'one');
    else await assert.rejects(promise);
  }
});
test('older review batches use a bounded date filter and reject invalid cutoffs before network access', async () => {
  for (const before of ['invalid', '2026-09-19T00:00:00Z or true', '2026-99-19T00:00:00Z']) {
    let contacted = false;
    await assert.rejects(recentInboxReferences(config, 20, async () => { contacted = true; throw new Error('Must not contact Graph'); }, before));
    assert.equal(contacted, false);
  }
  let calls = 0;
  const refs = await recentInboxReferences(config, 20, async (input) => {
    if (++calls === 1) return Response.json({ access_token: 'fake-token' });
    const url = new URL(String(input));
    assert.equal(url.searchParams.get('$top'), '20');
    assert.equal(url.searchParams.get('$filter'), 'receivedDateTime lt 2026-09-19T05:05:09.000Z');
    assert.equal(url.searchParams.get('$orderby'), 'receivedDateTime desc');
    return Response.json({ value: [] });
  }, '2026-09-19T05:05:09Z');
  assert.deepEqual(refs, []);
});
test('Jev receives all five native questions in one request without Microsoft credentials or message ID', async () => {
  const classification = sample('soon', 'internal_maintenance', 'order_buy', 0.99);
  let calls = 0;
  const result = await classifyMessage(message, 'fake-jev-key', async (url, init) => {
    calls++;
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
    const payload = JSON.parse(String(init!.body));
    assert.deepEqual(Object.keys(payload.questions), ['attention', 'type', 'action', 'needs_owner', 'security_risk']);
    assert.equal(payload.questions.needs_owner.type, 'noul');
    assert.equal(payload.questions.type.type, 'choice');
    assert.equal(payload.state.email.id, undefined);
    assert.equal(String(init!.body).includes('fake-secret'), false);
    return Response.json({ model: 'jev-test', answers: classification, usage: { input_tokens: 100, output_tokens: 0 } });
  });
  assert.equal(calls, 1);
  assert.deepEqual(result.classification, classification);
});
test('truncation and unseen attachments are explicit limitations', () => {
  const p = prepareState({ ...message, bodyText: 'x'.repeat(12001), hasAttachments: true });
  assert.equal(p.state.email.body_text.length, 12000);
  assert.equal(p.limitations.length, 2);
});
test('invalid provider payload is rejected before policy', async () => {
  await assert.rejects(classifyMessage(message, 'fake-key', async () => Response.json({ model: 'jev', answers: {}, usage: { input_tokens: 1, output_tokens: 0 } })));
});
