# Operate and troubleshoot

Run commands from your checkout with its private `.env`. Never put the admin token in a URL.

```sh
npm run service -- status
npm run service -- pause
npm run service -- resume --mode type-folders --limit 100
npm run service -- jobs
npm run service -- audit --after 0
```

`status` shows pause state, counters, queue counts, last scan/update and sanitized errors. `jobs` exports the latest 100 jobs. Audit is paginated: use the last event sequence as the next `--after`. Exports live under ignored `private/service/` and should not be attached to public issues. No automatic failure alerts or dashboard are included.

## Why a tagged email can still be in Inbox

Attention/Action labels describe work, not a folder. A Type label can also remain in Inbox when its message is held. Inspect the job's classification, limitations and plan:

- An uncertain Type does not qualify to move.
- Security scores at or above your threshold prevent filing.
- Truncated input prevents filing unless you explicitly configured otherwise.
- Existing managed categories and completed flags protect previous work.
- A change in read state, flag, categories, version or folder can stop a queued update.
- Only Inbox itself is scanned; rules that deliver mail elsewhere are outside scope.

The normal Type-folder mode files clear Types even when a task needs review or has an active flag. Review labels stay visible inside the folder. Sorting never completes a task or marks it read. New Type-folder plans write their final labels before the move, avoiding a temporary Type badge and a second category write after the move.

## Modes and previews

`observe` stores model decisions but does not change mail. `labels` applies categories only. `type-folders` files clear Types under your policy. `conservative` is an optional stricter mode: only Types marked `routine`, with strong agreement across all choices and low risk/owner-action scores, can file.

The CLI defaults to `observe` if no mode is supplied. To inspect an observed job, pause and export `jobs`. Apply one explicitly reviewed observation with:

```sh
npm run service -- promote --id '<private-message-id>' --mode type-folders
npm run service -- resume --mode type-folders --limit 100
```

Promotion does not make another model call; the writer still checks the original message state. Simply switching modes does not replay already done or observed jobs. Existing labels are not a generic instruction to move mail. This release has no bulk replay of completed messages.

## Schedule and model budget

Inbox metadata is discovered every five minutes, including during normal idle operation. Ready jobs run continuously, one durable turn at a time. There is no arbitrary pause between ready messages; provider rate limits and bounded retries add backoff. The regular limit counts classification attempts, including failed calls, in your configured time zone. Up to half of regular capacity is available for messages received before activation. Ready new arrivals have priority over fresh backfill jobs; interrupted writes are reconciled first.

A one-time accelerated allowance can cover the queued backlog's remaining attempts:

```sh
npm run service -- pause
npm run service -- scan
npm run service -- catchup
npm run service -- resume --mode type-folders --limit 100
```

Catch-up grants at most three total classification attempts per snapshotted message independently of the regular daily limit. It can incur many model calls. Repeating activation does not refill it; unused capacity closes when the work finishes. It is not a recurring unlimited quota.

Messages older than the configured window are not newly classified/moved; existing old tasks are not auto-completed or deleted. Up to 100 metadata pages are scanned per discovery. An incomplete inventory reports a failure rather than silently claiming completion.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Personal Outlook.com sign-in fails | This setup needs a Microsoft 365 organization and Exchange administrator. |
| Microsoft authentication fails | Tenant/client IDs and secret **Value**, secret expiry, correct organization. |
| Graph 403 reading mail | Single-mailbox Mail.ReadWrite assignment, enterprise application Object ID, propagation, mailbox ID. |
| Category setup gets 403 | Scoped MailboxSettings.ReadWrite assignment and propagation. Mail.ReadWrite alone is insufficient. |
| Deployment cannot verify Cloudflare metadata | Set the account ID from `npx wrangler whoami`, refresh Wrangler login, and confirm that the account has a workers.dev subdomain. No deployment proceeds on a failed discovery. |
| Deployment target already exists or URL differs | Use the intended account and Worker name, set its exact `JEV_SERVICE_URL`, pause it and create a new deployment preview. |
| Deployment preview is stale | Run `npm run deploy` again, review the target, then apply within one hour. |
| Setup reports ambiguous names | Resolve duplicate/case-conflicting folders/categories, then create a fresh preview. |
| Labels saved but hard to see in Outlook | Confirm mailbox master categories were created and the client synchronized. |
| Search Folders missing | The helper targets classic Windows Outlook; newer/web clients use a different parent. Definitions can also expire. |
| `profile_changed` | The deployed JSON profile differs from this ledger's original profile. Pause and plan a migration. |
| `account_changed` or `layout_invalid` | Wrong mailbox/app identity or stale folder mapping; do not reset the ledger to bypass it. |
| Rate-limit cooldown or retry | Let Retry-After expire; manual run/resume cannot bypass it. |
| `held` after a write | Export the audit and compare live state. Do not blindly repeat a move or overwrite a manual correction. |
| Service idle with remaining jobs | Check daily/catch-up capacity, retry due time, mode and pause state. |

Error output is sanitized. Do not enable raw request/body logging to troubleshoot real mail. Reproduce with synthetic fixtures instead.

## Recover, rotate and stop

The ledger records intent before each external effect. After an interrupted call, the service reads current state and either recognizes the expected result or holds it for review. Before/after metadata supports an operator-designed reversal; automatic bulk undo is not included.

Before an update, pause and wait for `busy: false`. Keep the existing Durable Object migration and Worker name. Never clear durable storage to retry work. Changing category names, meanings or profile settings after activation requires a deliberate migration; this release does not automate it.

Rotate credentials in your provider accounts, update the private `.env`, then redeploy while paused and verify access. Keep the admin token stable until the corresponding Worker secret is updated. If it is lost, use your authenticated Cloudflare account to rotate the Worker secret, then update local configuration.

To decommission, pause, remove Exchange assignments, revoke secrets, and decide how to retain/delete Cloudflare metadata and local exports. Removing the Worker does not undo changes already made to Outlook.
