import { accessToken, type GraphConfig, type Transport } from './graph';
import { TYPE_NAMES, ACTION_NAMES, ATTENTION_LABELS, REVIEW_LABELS } from './outlook-layout';

export interface BackfillItem {
  id: string; receivedAt: string; isRead: boolean; flagStatus: string; categories: string[];
  status: 'already_organized' | 'completed' | 'previously_reviewed' | 'needs_classification';
}
const managed = new Set<string>([...Object.values(TYPE_NAMES), ...Object.values(ACTION_NAMES),
  ...Object.values(ATTENTION_LABELS).map(x => x.name), REVIEW_LABELS.needsReview, REVIEW_LABELS.securityReview]);

// Age bounds select historical work; they never expire or archive existing tasks.
export async function inventoryInbox(config: GraphConfig, options: {
  days?: number; asOf?: string; reviewedIds?: ReadonlySet<string>; maxPages?: number;
} = {}, transport: Transport = fetch) {
  const days = options.days ?? 30, maxPages = options.maxPages ?? 100;
  const end = Date.parse(options.asOf ?? new Date().toISOString());
  if (!Number.isInteger(days) || days < 1 || days > 30 || !Number.isFinite(end)
    || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100) throw Error('Invalid cleanup bounds');
  const start = end - days * 86_400_000;
  const path = `/v1.0/users/${encodeURIComponent(config.MS_MAILBOX_ID)}/mailFolders/inbox/messages`;
  const first = new URL(`https://graph.microsoft.com${path}`);
  const allowedPaths = new Set([first.pathname.toLowerCase(),
    first.pathname.replace('/mailFolders/inbox/', "/mailFolders('inbox')/").toLowerCase()]);
  first.searchParams.set('$select', 'id,receivedDateTime,categories,isRead,flag');
  first.searchParams.set('$filter', `receivedDateTime ge ${new Date(start).toISOString()} and receivedDateTime le ${new Date(end).toISOString()}`);
  first.searchParams.set('$orderby', 'receivedDateTime desc'); first.searchParams.set('$top', '100');
  const token = await accessToken(config, transport);
  const seenPages = new Set<string>(), seenIds = new Set<string>();
  const items: BackfillItem[] = []; let next: string | null = first.href, pages = 0;
  while (next && pages < maxPages) {
    const url = new URL(next);
    // Pagination is an untrusted response: never send bearer tokens to another endpoint.
    if (url.origin !== first.origin || url.username || url.password || url.hash ||
      !allowedPaths.has(url.pathname.toLowerCase()) || seenPages.has(url.href)) throw Error('Unsafe or repeated pagination link');
    seenPages.add(url.href);
    const response = await transport(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${token}`, Prefer: 'IdType="ImmutableId"' } });
    if (!response.ok) throw Error(`Inbox inventory failed (${response.status}); no mail changed`);
    const data = await response.json() as { value?: unknown; '@odata.nextLink'?: unknown };
    if (!Array.isArray(data.value)) throw Error('Invalid inbox inventory');
    for (const raw of data.value) {
      const r = raw as Record<string, any>, received = Date.parse(r.receivedDateTime);
      if (typeof r.id !== 'string' || !r.id || !Number.isFinite(received) || typeof r.isRead !== 'boolean'
        || !Array.isArray(r.categories) || r.categories.some((x: unknown) => typeof x !== 'string')
        || !['notFlagged', 'flagged', 'complete'].includes(r.flag?.flagStatus)) throw Error('Invalid message metadata');
      if (received < start || received > end) throw Error('Server result outside cleanup window');
      if (seenIds.has(r.id)) continue; seenIds.add(r.id);
      const status = r.categories.some((c: string) => managed.has(c) || c.startsWith('JEV-')) ? 'already_organized'
        : r.flag.flagStatus === 'complete' ? 'completed'
        : options.reviewedIds?.has(r.id) ? 'previously_reviewed' : 'needs_classification';
      items.push({ id: r.id, receivedAt: new Date(received).toISOString(), categories: [...r.categories],
        isRead: r.isRead, flagStatus: r.flag.flagStatus, status });
    }
    if (data['@odata.nextLink'] !== undefined && typeof data['@odata.nextLink'] !== 'string') throw Error('Invalid pagination');
    next = data['@odata.nextLink'] as string | undefined ?? null; pages++;
  }
  items.sort((a,b) => b.receivedAt.localeCompare(a.receivedAt) || a.id.localeCompare(b.id));
  const counts = { already_organized: 0, completed: 0, previously_reviewed: 0, needs_classification: 0 };
  for (const item of items) counts[item.status]++;
  return { version: 1, mode: 'inventory-only', executable: false, mailboxWrites: 0, modelCalls: 0,
    asOf: new Date(end).toISOString(), since: new Date(start).toISOString(), days, pages, complete: next === null,
    counts, items };
}
