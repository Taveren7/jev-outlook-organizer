# Review, recovery and dashboard

Open your Worker URL with `/dashboard`. The page keeps the administration token only in memory; it never puts it in a URL or browser storage. Closing/refreshing clears it. All health and review data requires authentication. The dashboard checks health every 30 seconds while open. It sends no external alerts, email or webhooks.

Health shows recorded job counts, unresolved error codes, pending work, regular budget usage, provider cooldown and the last successful scan/update. A successful scan does not hide failed/held jobs. Stale discovery, old queued work, exhausted regular capacity and unresolved operations are visible. Set `MS_SECRET_EXPIRES_AT` to an ISO date to get a warning within 30 days of the Microsoft secret expiry. This is an operator-supplied reminder date, not an Entra expiry lookup or automatic rotation. Job records are historical service state, not a fresh Inbox inventory.

## Preview and apply

The review list loads 20 records at a time, showing each message’s subject, sender name/address and up to 255 characters of plain-text preview fetched live from Microsoft. These summaries stay in page memory, are not stored in the durable ledger/audit or browser storage, and use authenticated, non-cacheable responses. Viewing them makes no mailbox writes, preserves unread state and uses no Jev calls. Unavailable messages show a retry control. Summary text is displayed literally; email HTML, links, images and attachments are not loaded. The decision beside a summary is historical and may differ from the current message.

Use **Open Microsoft 365 work email** to sign in with your organization’s email address; no personal Outlook.com account is required. If Microsoft selects a personal account, choose **Sign in with a different account**, then **Work or school account** if your address belongs to both a personal and organizational account. After signing into the correct mailbox in the same browser, **Open message in Outlook** uses Microsoft’s message link. Opening a message there follows your Outlook reading settings. See [Microsoft’s work-account sign-in guide](https://support.microsoft.com/en-us/outlook/how-to-sign-in-to-outlook-on-the-web).

Pause the organizer before review operations. Inspect the summary (or open the full message in Outlook), select an operation and choose Preview. Previewing a reclassification sends that message to Jev and can incur usage. Apply is a separate explicit action, with fresh state and configuration checks. Resume the background service when finished. CLI equivalents:

```sh
npm run service -- health
npm run service -- review-list
npm run service -- pause
npm run service -- review-preview --id '<message-id>' --operation rerun --request-id '<unique-request-id-at-least-16-characters>'
npm run service -- review-ticket --ticket '<returned-ticket-id>'
npm run service -- review-apply --ticket '<returned-ticket-id>'
```

CLI review responses are saved to owner-only `private/service/` files; console output gives the ticket, state and file path. `review-list --after '<next-cursor>'` paginates the full ledger. Save and reuse the same request ID if a preview response is lost: the service returns the same ticket instead of charging for another model call. In the dashboard, a page refresh clears the local view; retrieve a lost ticket with the CLI before starting a new preview.

- **Correct Type:** choose **This belongs in…**, optionally keep **Use this correction to help with future mail from this sender** checked, then Preview and Apply. This files eligible organizer-processed mail from Inbox or a configured Type folder into your chosen Type folder. It preserves task/unrelated labels, unread state and flags, removing obsolete Type badges. It records your choice separately from the original model distribution and uses no Jev attempts. Completed/protected, security-held, truncated and manually changed messages remain blocked. An explicit correction is not automatically overwritten by Ask Jev again; use another correction or Undo.
- **Ask Jev again (reclassify):** one previously completed organizer job still in Inbox, with a saved matching after-state. Protected/completed mail, truncated inputs, previous security holds, moved messages and manual edits are excluded. Original unrelated categories are preserved. The new classification must pass the existing filing rules before Apply becomes available. A blocked or still-uncertain preview changes no mail.
- **Undo last change:** restore the saved prior categories and, for a previously filed message, its original Inbox location. It requires an exact match to the recorded after-state, preserving subsequent manual edits. It does not mark mail unread/read or change flags. Repeated application is idempotent, and undoing an undo is blocked.
- **Retry failed job:** queue another bounded classification cycle for a failed, unclassified Inbox message. Existing managed labels, prior write results and completion are protected. It consumes the normal budget when the resumed service processes it; it is not an unlimited or automatic retry.

Previews expire after one hour and are bound to the source job and current policy/layout/relationship configuration. ETag-only synchronization drift is accepted before preparing the operation; subsequent writes retain the strict production guards. Every application writes through the same durable intent/checkpoint ledger. An interrupted write enters recovery; repeating Apply does not blindly repeat the mutation. Resume the service to reconcile the saved intent, and inspect any held result. Read state and native flags must still match. Review and undo are limited to the configured recent-mail window.

Rerun attempts share the regular daily model budget and provider cooldown. There is no separate hidden operator allowance. Existing historical operator-only changes outside the cloud ledger remain protected on mismatch; this release does not import or replay them automatically.

## Learning from corrections

Only successfully applied **Correct Type** operations become feedback. Previewing, a blocked/failed write, or selecting a model prediction does not teach the model. The checkbox can limit a correction to that message. Each corrected message contributes at most one active example: a later correction replaces its older contribution. Undo disables learning from the reverted correction; older examples are not silently reactivated. Recovery after an interrupted move activates evidence only when the final mailbox state is verified.

This first learning loop supplies Jev with Type counts from up to twenty owner-corrected messages from the **exact same sender** in the last 180 days. It is contextual guidance, not model training or a sender-wide routing rule. The current message's purpose takes precedence; mixed sender history is shown as multiple Type counts. Confidence/security gates remain unchanged, and no history is inferred from folder moves or uncategorized mail. A future result records the IDs of the corrections supplied to Jev, allowing the decision's context to be audited. There is no measured accuracy improvement claim yet.

Feedback retains correction/message IDs, selected and original Types, timestamps and a mailbox-salted sender hash. It does not persist message bodies, subjects or sender addresses. Hashes are pseudonymous private metadata, not anonymous data; protect ledger backups. No feedback is shared across installations or added to the public repository. Learning fields passed to Jev contain Type/count pairs and guidance, not sender hashes or old message text.

The **Learning from your corrections** section shows examples and their source messages. Pause and select **Stop learning from this correction** to disable an example without changing mail. This also invalidates outstanding previews, as does adding an applied correction. Examples stop contributing after 180 days, while their audit records remain. There is no automatic old-mail replay. Learned hints are available to future cloud classifications and dashboard reruns; standalone local preview tools do not load the cloud feedback ledger.

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
