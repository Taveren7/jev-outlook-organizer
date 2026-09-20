# Security and privacy

Do not post secrets or private mail data in public issues. Use GitHub's private vulnerability reporting feature for this repository when available. Otherwise request a private reporting channel without including the vulnerability details or sensitive data.

The organizer uses an app-only Microsoft identity, scoped with Exchange RBAC to one mailbox. Mail.ReadWrite technically permits more than this application implements, including deletion; application code provides a narrower operational boundary, not a narrower Microsoft permission. Mail.Send is not required. MailboxSettings.ReadWrite is used for category registration and can be revoked after setup if no further category changes are needed.

Entra application permissions and Exchange RBAC assignments are additive. A scoped RBAC assignment does not neutralize an independent tenant-wide Entra grant. Check both and verify that a second mailbox returns 403. Permission changes may take time to propagate.

Email is untrusted input. The model receives no Microsoft credentials. Model output must validate against the configured schema; ordinary code determines allowed mutations. The software never follows email instructions to alter its own permissions, send messages or fetch links. This does not make model predictions authoritative or guarantee resistance to all prompt injection.

Message text, subject and participant context are transmitted to TypeSafe. Cloudflare stores classifications, message IDs and state/audit metadata. No email bodies, subjects, addresses, tokens or raw provider errors belong in its ledger or logs. Attachment payloads are not read. Before using real mail, evaluate the providers' terms and your organization's rules.

`.env`, `.dev.vars`, generated account configuration and `private/` exports are ignored by Git. Local setup uses restrictive POSIX permissions; Windows users should also protect their user profile and local file ACLs. Secrets are uploaded through stdin to Wrangler, not placed in command arguments or URLs. Protect the admin token: its holder can enable mailbox writes and inspect private metadata.

The service checks current categories, read state, flags, folder and ETag before writes. Category PATCH uses If-Match. Microsoft Graph moves have no documented equivalent atomic protection here, leaving a concurrent-edit race. Uncertain external outcomes are reconciled by reading state; ambiguous cases are held rather than blindly replayed. Audit exports support operator review, but bulk undo is not implemented.

Rotate Microsoft and Jev credentials before expiration, update Worker secrets and verify access. For decommissioning, pause first, remove scoped assignments, revoke secrets and decide how to retain or remove private ledger exports. Deleting a ledger is not a retry mechanism.
