# Customize the organizer

Edit `organizer.config.json` before mailbox setup. Run `npm run config:check` after editing. The file is bundled into the Worker; restart local processes after changes. Never put API keys or passwords here. Configuration is tracked in your clone, so consider whether your personal context belongs in a public fork.

## Context and categories

Set `ownerContext` to the mailbox owner's role and responsibilities, and `organizationContext` to the perspective needed to distinguish customers, suppliers and internal work. Use general descriptions, not contact lists or confidential business data.

Replace, add or remove entries under `types`. Between 2 and 30 are supported. Each key is a stable lowercase identifier; each entry provides:

```json
"project_updates": {
  "description": "Active project milestones, deliverables, status reports and coordination.",
  "folder": "Projects",
  "color": "preset4",
  "routine": false
}
```

The description becomes a Jev choice, the key is validated in its returned probability distribution, and the folder is used in the mailbox mapping. These are real custom choices, not aliases for hard-coded categories. `routine` controls eligibility in the optional strict `conservative` mode; it does not limit `type-folders` mode.

Change the display names and colors under `attention`, `actions` and `review`, keeping their keys and meanings. All display names must be unique across groups, ignoring case. Folder names cannot contain `/` or `\`. Colors use Microsoft's `none` or `preset0` through `preset24` values. Existing mailbox category colors are preserved during setup; the preview shows the existing color.

## Personal action indicator

`actionIndicator` defaults to `{"name":"Needs Me","color":"preset0","threshold":0.9}`. Change the name, color or threshold during onboarding. The label appears when `needs_owner` reaches the threshold, independently of Now/Soon urgency and Type confidence. It does not change native Outlook follow-up flags or bypass security/truncation filing holds. Completed messages are excluded before tagging. Later completion does not automatically clear an already-applied label; remove it manually when appropriate.

This field is optional: profiles from v0.1.1 that omit it retain their exact profile identity and have no action indicator. Upgrading code while keeping that JSON unchanged does not enable the label. Adding or changing it on an active installation is a profile change; follow the migration guidance below. No existing messages are automatically replayed.

## Processing settings

| Setting | Default | Behavior |
| --- | --- | --- |
| `timeZone` | UTC | IANA zone used for daily budgets |
| `lookbackDays` | 30 | Inbox discovery and first-write age window; 1–30 days |
| `dailyLimit` | 100 | Default model-attempt limit passed by the service CLI; 1–250 |
| `model` | jev-latest | Jev model alias; a changing alias is not a pinned accuracy baseline |
| `maxBodyCharacters` | 12000 | Message-text input limit; 1000–50000 |
| `routing.choiceConfidence` | 0.8 | Minimum Type confidence for filing |
| `routing.choiceProbability` | 0.8 | Minimum probability assigned to the selected Type |
| `routing.securityHold` | 0.7 | Scores at or above this remain in Inbox |
| `routing.fileTruncatedMessages` | false | Whether a clear Type can be filed when supplied input was truncated |

Confidence and winning probability are separate requirements. These defaults are operational choices, not measured accuracy guarantees. Task uncertainty and unseen attachments keep review labels and a to-do attention level; they do not independently block a clear Type. Attachments are not analyzed. Setting `fileTruncatedMessages` to true accepts routing from partial context and keeps the review labels.

Reading an email never means its task is complete. Explicit completed flags are protected, and no task is automatically marked done or expired.

## Changing an active installation

Pause first and export your audit. The coordinator binds its ledger to the exact profile and mailbox identity; a changed profile fails closed with `profile_changed`. Changing a JSON file and redeploying is not an automatic migration of existing folders, categories, classifications or completed jobs.

This release supports customization during initial onboarding. For later schema changes, plan a deliberate migration: preserve the old ledger, review folder/category mappings and protect previous message IDs before starting a separately configured Worker. Do not reset a ledger or strip old labels to force replay. Automated migrations and a graphical configuration editor are not included.
