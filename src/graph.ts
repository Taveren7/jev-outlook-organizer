export interface GraphConfig {
  MS_TENANT_ID: string;
  MS_CLIENT_ID: string;
  MS_CLIENT_SECRET: string;
  MS_MAILBOX_ID: string;
}
export interface MailInput {
  id: string;
  subject: string;
  from: string;
  to: string[];
  cc: string[];
  receivedAt: string;
  bodyText: string;
  hasAttachments: boolean;
}
export type Transport = typeof fetch;
export interface InboxReference {
  id: string;
  receivedAt: string;
  webLink: string;
}

// Deliberately no mailbox write methods. Token requests are the only POST.
export async function accessToken(config: GraphConfig, transport: Transport): Promise<string> {
  const tokenResponse = await transport(`https://login.microsoftonline.com/${encodeURIComponent(config.MS_TENANT_ID)}/oauth2/v2.0/token`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: config.MS_CLIENT_ID, client_secret: config.MS_CLIENT_SECRET, scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' }),
  });
  if (!tokenResponse.ok) throw new Error('Microsoft authentication failed');
  const token = await tokenResponse.json() as { access_token?: unknown };
  if (typeof token.access_token !== 'string' || !token.access_token) throw new Error('Invalid Microsoft token response');
  return token.access_token;
}

export async function latestInboxMessageId(config: GraphConfig, transport: Transport = fetch): Promise<string | null> {
  const token = await accessToken(config, transport);
  const url = new URL(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(config.MS_MAILBOX_ID)}/mailFolders/inbox/messages`);
  url.searchParams.set('$select', 'id');
  url.searchParams.set('$top', '1');
  url.searchParams.set('$orderby', 'receivedDateTime desc');
  const response = await transport(url, {
    method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10_000),
    headers: { Authorization: `Bearer ${token}`, Prefer: 'IdType="ImmutableId"' },
  });
  if (!response.ok) throw new Error('Microsoft inbox read failed');
  const data = await response.json() as { value?: Array<{ id?: unknown }> };
  if (!Array.isArray(data.value)) throw new Error('Invalid inbox response');
  if (data.value.length === 0) return null;
  if (typeof data.value[0]?.id !== 'string' || !data.value[0].id) throw new Error('Invalid message ID');
  return data.value[0].id;
}

export async function recentInboxReferences(config: GraphConfig, count = 10, transport: Transport = fetch, before?: string): Promise<InboxReference[]> {
  if (!Number.isInteger(count) || count < 1 || count > 20) throw new Error('Review batch must contain 1 to 20 messages');
  if (before !== undefined && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(before) || !Number.isFinite(Date.parse(before)))) throw new Error('Invalid review cutoff');
  const token = await accessToken(config, transport);
  const url = new URL(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(config.MS_MAILBOX_ID)}/mailFolders/inbox/messages`);
  url.searchParams.set('$select', 'id,receivedDateTime,webLink');
  url.searchParams.set('$top', String(count));
  url.searchParams.set('$orderby', 'receivedDateTime desc');
  if (before !== undefined) url.searchParams.set('$filter', `receivedDateTime lt ${new Date(before).toISOString()}`);
  const response = await transport(url, {
    method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10_000),
    headers: { Authorization: `Bearer ${token}`, Prefer: 'IdType="ImmutableId"' },
  });
  if (!response.ok) throw new Error('Microsoft inbox read failed');
  const data = await response.json() as { value?: Array<{ id?: unknown; receivedDateTime?: unknown; webLink?: unknown }> };
  if (!Array.isArray(data.value) || data.value.length > count) throw new Error('Invalid inbox response');
  return data.value.map(item => {
    if (typeof item.id !== 'string' || !item.id || typeof item.receivedDateTime !== 'string' || !Number.isFinite(Date.parse(item.receivedDateTime)) || typeof item.webLink !== 'string') throw new Error('Invalid inbox reference');
    const link = new URL(item.webLink);
    if (link.protocol !== 'https:' || !['outlook.office.com', 'outlook.office365.com', 'outlook.cloud.microsoft'].includes(link.hostname) || link.username || link.password) throw new Error('Unexpected Outlook message link');
    return { id: item.id, receivedAt: new Date(item.receivedDateTime).toISOString(), webLink: link.href };
  });
}

export async function readMessage(config: GraphConfig, messageId: string, transport: Transport = fetch): Promise<MailInput> {
  const token = await accessToken(config, transport);
  const url = new URL(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(config.MS_MAILBOX_ID)}/messages/${encodeURIComponent(messageId)}`);
  url.searchParams.set('$select', 'id,subject,from,toRecipients,ccRecipients,receivedDateTime,body,hasAttachments');
  const response = await transport(url, {
    method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10_000),
    headers: { Authorization: `Bearer ${token}`, Prefer: 'outlook.body-content-type="text", IdType="ImmutableId"' },
  });
  if (!response.ok) throw new Error('Microsoft message read failed');
  return normalizeMessage(await response.json());
}

export function normalizeMessage(value: unknown): MailInput {
  if (!value || typeof value !== 'object') throw new Error('Invalid message');
  const v = value as Record<string, any>;
  // Require text from Graph instead of attempting lossy HTML regex cleanup.
  if (typeof v.id !== 'string' || typeof v.subject !== 'string' || typeof v.body?.content !== 'string' || v.body?.contentType?.toLowerCase() !== 'text' || typeof v.hasAttachments !== 'boolean' || typeof v.receivedDateTime !== 'string') throw new Error('Incomplete message or non-text body');
  const address = (a: any): string => {
    if (typeof a?.emailAddress?.address !== 'string') throw new Error('Invalid recipient');
    return a.emailAddress.address;
  };
  if (!Array.isArray(v.toRecipients) || !Array.isArray(v.ccRecipients)) throw new Error('Invalid recipients');
  return { id: v.id, subject: v.subject, from: address(v.from), to: v.toRecipients.map(address), cc: v.ccRecipients.map(address), receivedAt: v.receivedDateTime, bodyText: v.body.content, hasAttachments: v.hasAttachments };
}
