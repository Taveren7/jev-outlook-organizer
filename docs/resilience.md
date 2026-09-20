# Review, recovery and dashboard

Open your Worker URL with `/dashboard`. The page keeps the administration token only in memory; it never puts it in a URL or browser storage. Closing/refreshing clears it. All health and review data requires authentication. The dashboard checks health every 30 seconds while open. It sends no external alerts, email or webhooks.

Health shows recorded job counts, unresolved error codes, pending work, regular budget usage, provider cooldown and the last successful scan/update. A successful scan does not hide failed/held jobs. Stale discovery, old queued work, exhausted regular capacity and unresolved operations are visible. Set `MS_SECRET_EXPIRES_AT` to an ISO date to get a warning within 30 days of the Microsoft secret expiry. This is an operator-supplied reminder date, not an Entra expiry lookup or automatic rotation. Job records are historical service state, not a fresh Inbox inventory.

## Preview and apply

Pause the organizer before review operations. In the dashboard, open the message in Outlook to inspect it, select an operation and choose Preview. Previewing a reclassification sends that message to Jev and can incur usage. Apply is a separate explicit action, with fresh state and configuration checks. Resume the background service when finished. CLI equivalents:

```sh
npm run service -- health
npm run service -- review-list
npm run service -- pause
npm run service -- review-preview --id '<message-id>' --operation rerun --request-id '<unique-request-id-at-least-16-characters>'
npm run service -- review-ticket --ticket '<returned-ticket-id>'
npm run service -- review-apply --ticket '<returned-ticket-id>'
```

CLI review responses are saved to owner-only `private/service/` files; console output gives the ticket, state and file path. `review-list --after '<next-cursor>'` paginates the full ledger. Save and reuse the same request ID if a preview response is lost: the service returns the same ticket instead of charging for another model call. In the dashboard, a page refresh clears the local view; retrieve a lost ticket with the CLI before starting a new preview.

- **Reclassify:** one previously completed organizer job still in Inbox, with a saved matching after-state. Protected/completed mail, truncated inputs, previous security holds, moved messages and manual edits are excluded. Original unrelated categories are preserved. The new classification must pass the existing filing rules before Apply becomes available. A blocked or still-uncertain preview changes no mail.
- **Undo last change:** restore the saved prior categories and, for a previously filed message, its original Inbox location. It requires an exact match to the recorded after-state, preserving subsequent manual edits. It does not mark mail unread/read or change flags. Repeated application is idempotent, and undoing an undo is blocked.
- **Retry failed job:** queue another bounded classification cycle for a failed, unclassified Inbox message. Existing managed labels, prior write results and completion are protected. It consumes the normal budget when the resumed service processes it; it is not an unlimited or automatic retry.

Previews expire after one hour and are bound to the source job and current policy/layout/relationship configuration. ETag-only synchronization drift is accepted before preparing the operation; subsequent writes retain the strict production guards. Every application writes through the same durable intent/checkpoint ledger. An interrupted write enters recovery; repeating Apply does not blindly repeat the mutation. Resume the service to reconcile the saved intent, and inspect any held result. Read state and native flags must still match. Review and undo are limited to the configured recent-mail window.

Rerun attempts share the regular daily model budget and provider cooldown. There is no separate hidden operator allowance. Existing historical operator-only changes outside the cloud ledger remain protected on mismatch; this release does not import or replay them automatically.

## Private relationships

Keep relationship data in an ignored, owner-only file such as `private/relationships.json`. The public setup creates an empty example and uploads it as the Worker secret `RELATIONSHIP_CONTEXT`. No real domains or addresses belong in the public repository.

```json
{
  "version": 1,
  "domains": {
    "customer": ["customer.example"],
    "supplier": ["supplier.example"],
    "internal": ["internal.example"]
  },
  "defaults": {
    "customer": "customer_sales",
    "supplier": "supply_chain",
    "internal": "internal_production"
  },
  "senders": []
}
```

Default Type keys must exist in your configured taxonomy. For custom Types, use your own keys or omit the defaults. Optional exact-address exceptions use `{"address":"person@example.test","relationship":"supplier"}` in `senders`. Addresses/domains must be lowercase; domain entries omit `@`. Matches are exact: lookalikes, subdomains and addresses quoted inside a body do not match. Conflicting domain assignments are rejected. An exact sender exception overrides its domain relationship.

Relationships provide model context and fallback workflow suggestions. Specific accounting, maintenance, IT and transaction-document content still takes precedence. They never force confidence or authenticate a sender. Changed relationship configuration affects future classifications and invalidates pending review previews; it does not replay existing jobs. A fingerprint, not the domain list, is recorded with classification results.

## Remaining work

Automatic long-thread extraction, correction-based quality evaluation, configuration/schema migration, automatic completion-label cleanup, tested backup restoration and full convergence of the two engines are separate follow-up work. This release provides the first three resilience priorities: reviewed operations, dashboard health and private relationship configuration. No automated mailbox changes are enabled merely by upgrading.
