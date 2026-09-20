# Architecture: Jev inside an Outlook workflow

This application turns message interpretation into five explicit values that application code can use. Jev handles contextual judgments; the organizer owns scheduling, filing policy, mailbox state checks, budgets and recovery.

![The organizer's services and data flow.](assets/architecture.svg)

## The problem the model solves

A useful email organizer has to separate several questions. A clear customer-sales message may still have an uncertain next action. A receipt may mention an invoice without representing an unpaid customer balance. An internal sender may be discussing IT or HR rather than production. A forwarded message can contain a purchase receipt whose original purpose still matters.

The model receives descriptions of the available categories and the mailbox owner's context, rather than relying solely on keyword matches. Known customer/supplier/internal relationships can help resolve ambiguity. Specific content takes precedence over relationship defaults, and a known domain is not sender authentication.

TypeSafe describes Jev as a System One model that evaluates typed questions against a shared state. **Choice** returns an option, distribution and confidence; **Noul** returns a 0–1 probability. This integration uses those two primitives, not Score. Questions are evaluated independently, so the application must handle inconsistent combinations, such as a high Needs owner score with a reference-only action. See the [TypeSafe introduction](https://docs.typesafe.ai/), [Choice](https://docs.typesafe.ai/primitives/choice), [Noul](https://docs.typesafe.ai/primitives/noul) and [confidence reference](https://docs.typesafe.ai/confidence).

## One classification request

The shipped call in [src/jev.ts](../src/jev.ts) uses `TypeSafeClient.systemOne()` with all five questions from [src/taxonomy.ts](../src/taxonomy.ts). The model is configured in `organizer.config.json`; the default is `jev-latest`. Secrets are supplied through Worker bindings.

| Input to Jev | Source and bounds |
| --- | --- |
| Owner and organization context | User-edited configuration |
| Type options and descriptions | `CONFIG.types`, transformed into Choice criteria |
| Subject and body text | Up to 500 subject characters and configured body limit, 12,000 by default |
| Sender, recipients, timestamp | Current message; up to 30 To and 30 Cc recipients |
| Attachment presence | Boolean only; attachment contents are not fetched |
| Business relationship | Optional private exact-domain/exact-address configuration |
| Owner correction history | Optional Type counts from recent verified same-sender corrections |
| Context limitations | Explicit warnings about missing attachment content or truncated fields |

Only the current message is supplied. Quoted history inside its text can provide context; the system does not separately retrieve a full conversation. Instructions embedded in email are treated as untrusted content. There is no tool-execution loop in the model call.

The SDK request disables SDK retries. The coordinator owns bounded retries, pre-call budget reservations and provider cooldowns, so each attempted classification is accounted for in one place.

## How the five outputs compose

![Fictional customer quote request with five illustrative Jev decisions and the resulting folder and labels.](assets/jev-email-decisions.svg)

For the fictional quote request above, suppose all three Choice answers have high confidence and high probability for the selected option. The Type is Customer Sales, Attention is Soon, Action is Reply, Needs owner is 0.96 and Security risk is 0.03.

The application validates all distributions and probabilities, then checks the message's age, folder, existing labels and completion status. With the default type-folder policy, the clear Type determines the destination, Soon and Reply stay visible, and the 0.96 owner-action score adds Needs Me. The writer preserves the existing read state and native flag. No redundant Customer Sales category is added to the filed message.

Changing one dimension changes a specific part of the result:

| Change in the illustrative result | Policy consequence |
| --- | --- |
| Type confidence falls below 0.80 | Automatic filing is held; review stays in Inbox |
| Winning Type probability falls below 0.80 | Same hold, even if confidence is high |
| Action is uncertain but Type is clear | Filing can proceed in type-folders mode with task/review labels retained |
| Security risk reaches 0.70 | No automatic move; security/review labels apply |
| Input is truncated | Default policy holds automatic filing and retains review labels |
| Needs owner falls below 0.90 | No new Needs Me indicator from that score; urgency/action are separate |
| User edits message state before a write | Writer holds the operation instead of overwriting the changed state |

These are configured operational thresholds, not calibrated accuracy guarantees for this mailbox. The model can be wrong. Synthetic integration tests prove application behavior for supplied answers; evaluating Jev quality requires independently reviewed real examples.

The organizer also supports observe, labels-only and conservative modes. Conservative filing has a narrower routine-Type allowlist and stronger checks across all Choice answers. [Modes and troubleshooting](operations.md)

## Runtime responsibilities

| Component | Responsibility | Source |
| --- | --- | --- |
| Worker entry point | Scheduled execution, authenticated admin routes and dashboard assets | [production.ts](../src/production.ts) |
| Mailbox coordinator | One mailbox's discovery, queue, alarms, budgets, cooldowns and review operations | [coordinator.ts](../src/production/coordinator.ts) |
| SQLite Durable Object ledger | Jobs, intent/checkpoints, audit metadata, counters, review tickets and learning records | [store.ts](../src/production/store.ts) |
| Jev adapter | Bounded input preparation, SDK request and response validation | [jev.ts](../src/jev.ts), [taxonomy.ts](../src/taxonomy.ts) |
| Policy and writer | Compose decisions, verify eligibility and current state, write and reconcile results | [core.ts](../src/production/core.ts), [policy.ts](../src/policy.ts) |
| Microsoft Graph adapter | Scoped reads, category updates and folder moves | [graph.ts](../src/production/graph.ts) |
| Review and learning | Expiring previews, explicit corrections, reruns, undo and revocable hints | [review.ts](../src/production/review.ts), [learning.ts](../src/production/learning.ts) |

Inbox discovery runs on a five-minute schedule, backed by durable alarms for ready work and recovery. This version uses periodic bounded scans, not Graph change notifications or delta subscriptions. A new installation starts paused. Once enabled, it processes eligible unprocessed Inbox messages within the configured lookback, including the initial recent backlog. Completed ledger jobs are not automatically replayed after a prompt or context change.

Before an external write, the service records intent durably. It checks current metadata, uses conditional category updates, verifies the destination and reads back results. If a response is lost, recovery compares live state with recorded state; an ambiguous move is held for review rather than blindly repeated. Read status, native flags and unrelated categories are preserved. See [operations](operations.md) for recovery and audit commands.

## Corrections and the learning boundary

A human Type correction is separate evidence from a model prediction. The dashboard requires pause, a fresh preview and explicit apply. After the mailbox change is verified, an opted-in correction contributes one active example for that message. A later correction replaces that contribution; undo or Stop learning disables it.

For future cloud classifications, the organizer looks up a mailbox-salted hash of the exact sender. It aggregates up to twenty corrected messages from the last 180 days into Type/count pairs and adds those pairs to the model input. Jev makes a fresh decision about the new message, and normal filing checks still apply.

This is **contextual feedback**, not fine-tuning, automatic rule generation or learning from every manual Outlook move. It does not infer that a sender always belongs in one folder. The original model result and human correction remain separately auditable. The standalone local preview command does not load the cloud learning ledger. [Complete correction and revocation behavior](resilience.md)

## Where data lives

| Location | What it receives or retains |
| --- | --- |
| Microsoft 365 | Original mail, folders, categories and native flags |
| TypeSafe request | Bounded message content, addressing context, configured questions and optional context hints |
| Cloudflare request memory | Message content while classifying or serving an authenticated live summary |
| Durable Object SQLite | IDs, decisions, before/after metadata, audit/tickets, budgets and optional salted sender hashes; no message bodies, subjects or sender addresses |
| Dashboard browser session | Admin token and bounded live message summaries; no token in URL or local storage |
| User's local private files | Credentials, relationship configuration, setup plans and metadata exports, excluded from Git |

The application-level storage boundary does not specify a provider's retention policy. Review your provider agreements for your own deployment. Pseudonymous hashes and message identifiers remain private metadata.

Microsoft access is scoped through Exchange application RBAC to one mailbox. Mail.ReadWrite supports the intended message/folder operations; MailboxSettings.ReadWrite supports category definitions during setup. Mail.Send is not required. There is no sending, deletion, purchasing or task-completion feature.

## Customize and verify

Category configuration drives the Jev Type question, runtime validation, physical folder map and dashboard correction choices. Choose the default ten Types, the optional thirteen-Type [expanded preset](../organizer.extended.example.json), or your own initial taxonomy. An active deployment binds its ledger to the exact profile and mailbox; schema changes need a deliberate migration.

Start with [onboarding](setup.md), inspect [configuration](configuration.md), then review several real predictions and outcomes before broadening use. The synthetic test suites exercise both the default and a custom profile, but fresh-tenant onboarding and client-specific Outlook display still need environment-specific verification. Known remaining work is listed in [resilience](resilience.md#remaining-work).
