# Set up your own organizer

This guide configures one Microsoft 365 work/school mailbox with your own accounts. You need an Exchange administrator for the permission setup. It does not use a personal Outlook.com sign-in or someone else's ChatGPT connection. The current endpoints target Microsoft's global cloud.

## 1. Install and choose your categories

Install Node.js 22.13 or newer; Node.js 24 LTS is recommended. Clone this repository, then:

```sh
npm ci
npm run setup
npm run config:check
```

`setup` creates `.env` only if it does not exist, generates an admin token, and prints the steps. Open `.env` in your local editor. The token and keys must stay local; never paste them into a GitHub issue. On Windows, use your protected user directory for the checkout.

Edit `organizer.config.json` before continuing. Set your context, Type descriptions, folder names and colors. See [configuration](configuration.md). The generated private folder map belongs to this exact profile.

## 2. Register a Microsoft application

In [Microsoft Entra admin center](https://entra.microsoft.com/), sign in with the work/school administrator for the target organization:

1. Open **Identity → Applications → App registrations → New registration**.
2. Give the application a name, choose **Accounts in this organizational directory only**, and leave redirect URI empty. Register it.
3. Copy **Directory (tenant) ID** into `MS_TENANT_ID` and **Application (client) ID** into `MS_CLIENT_ID` in `.env`.
4. Open **Certificates & secrets → Client secrets → New client secret**. Choose the organization's approved expiry. Copy the secret **Value**, not Secret ID, into `MS_CLIENT_SECRET`. Record its expiry privately; rotation is not automatic.
5. Open **Enterprise applications**, find this application, and record its **Object ID** for the PowerShell step. This is different from the app registration's Object ID.
6. Find the target mailbox user's Entra **Object ID** and put it in `MS_MAILBOX_ID`. This setup CLI requires the GUID rather than an email address.

This uses the [Microsoft client-credentials flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-client-creds-grant-flow). Do not add tenant-wide Entra Mail.ReadWrite, MailboxSettings.ReadWrite or Mail.Send application grants as a shortcut: this guide uses scoped Exchange assignments instead.

## 3. Scope access to one mailbox

In PowerShell 7, install/import the Exchange module and connect with an authorized administrator:

```powershell
Install-Module ExchangeOnlineManagement -Scope CurrentUser
Import-Module ExchangeOnlineManagement
Connect-ExchangeOnline

$scope = @{
    TenantId = '<directory-tenant-id>'
    AppId = '<application-client-id>'
    ServicePrincipalId = '<enterprise-application-object-id>'
    MailboxObjectId = '<mailbox-user-object-id>'
}

# Preview only:
./scripts/setup-exchange.ps1 @scope -Permission Mail.ReadWrite
./scripts/setup-exchange.ps1 @scope -Permission MailboxSettings.ReadWrite

# Apply the reviewed, single-mailbox assignments:
./scripts/setup-exchange.ps1 @scope -Permission Mail.ReadWrite -Apply
./scripts/setup-exchange.ps1 @scope -Permission MailboxSettings.ReadWrite -Apply
```

The script checks the connected tenant and exact scope membership, refuses conflicting scope/role definitions, and tests authorization. A negative Exchange test is attempted when another user mailbox exists. Audit independent Entra grants too: they are additive, and Exchange's test does not check them. Microsoft documents caching delays of up to two hours. See [Exchange application RBAC](https://learn.microsoft.com/en-us/exchange/permissions-exo/application-rbac).

Mail.ReadWrite supports folder creation and the message updates this application performs. Category registration requires MailboxSettings.ReadWrite. Both should use the same one-mailbox scope; Mail.Send is unnecessary. See [folder permissions](https://learn.microsoft.com/en-us/graph/api/mailfolder-post-childfolders?view=graph-rest-1.0) and [category permissions](https://learn.microsoft.com/en-us/graph/api/outlookuser-post-mastercategories?view=graph-rest-1.0).

Put another existing mailbox's object ID into optional `MS_DENIED_MAILBOX_ID` to verify a real Graph denial. The probe asks only for an ID and must return 403. Do not substitute a nonexistent mailbox, where a 404 does not prove authorization is restricted.

## 4. Add Jev and check connectivity

Obtain a TypeSafe Jev API key from your own [TypeSafe account](https://typesafe.ai/) and put it in `TYPESAFE_API_KEY` in `.env`.

```sh
npm run doctor
npm run doctor -- --jev
```

The first command reads Inbox and category metadata and checks the optional negative scope; it does not send email to Jev or write mail. It does not claim to prove write access until the setup application succeeds. `--jev` adds a potentially billable synthetic classification, with no real email content.

If a command fails, see [troubleshooting](operations.md). Do not broaden permissions to make an error disappear.

## 5. Preview and create folders and category definitions

```sh
npm run mailbox:setup
```

Review the printed list of folders/categories to create or reuse. The private plan expires after one hour. Setup reuses exact, unique existing folder names and preserves existing category colors. It does not move existing folders, create an Old Folders archive or modify messages.

```sh
npm run mailbox:setup -- --apply
```

This checks that the account, profile and relevant mailbox state still match the preview, creates only missing entries, verifies the result and saves the private ID mapping. If interrupted, run a new preview before applying again; existing entries are discovered and reused. Conflicting or duplicate names need manual resolution.

Optional cross-folder task views for classic Outlook on Windows:

```sh
npm run mailbox:setup -- --search-folders
npm run mailbox:setup -- --search-folders --apply
```

These search Inbox and all configured Type folders, exclude completed flags and do not include nested historical folders. Check that they appear in classic Outlook and add the useful views to Favorites. Microsoft documents different search-folder locations for classic Outlook and newer/web clients; this command targets the classic Windows location. Recreate expired views by repeating preview/apply. See [Microsoft's Search Folder behavior](https://learn.microsoft.com/en-us/graph/api/resources/mailsearchfolder?view=graph-rest-1.0).

## 6. Deploy to your Cloudflare account, paused

Sign in to Cloudflare and choose a unique `WORKER_NAME` in `.env`. Run `npx wrangler whoami` and copy the chosen account ID into `CLOUDFLARE_ACCOUNT_ID`. This is required even with one account, so the deployment target is explicit. Use an account authorized to process this mailbox's data.

```sh
npx wrangler login
npm run deploy
npm run deploy -- --apply
```

The first deployment command reads Cloudflare metadata using your Wrangler login, verifies the exact account and Worker name, and saves a private preview valid for one hour. It previews the target URL, mapping and secret names; it never prints secret values. An existing Worker requires its matching `JEV_SERVICE_URL`, a valid admin token and a paused, idle public organizer. A name collision cannot be treated as a fresh deployment. Application creates an ignored `wrangler.local.jsonc`, deploys the Worker, and passes secrets to Wrangler through stdin. The fresh durable coordinator starts paused, and setup verifies paused status after uploading secrets. If verification fails, inspect status before proceeding; the deployment may already exist. Do not use another application's Worker name.

Copy the resulting `https://…workers.dev` URL into `JEV_SERVICE_URL` in `.env`. Then:

```sh
npm run service -- status
```

Confirm `paused: true`. No mailbox processing starts automatically during onboarding. Cloudflare pricing and account availability vary; review your own account's limits and [Wrangler secret documentation](https://developers.cloudflare.com/workers/configuration/secrets/).

For updates, retain `.env`, the local mapping and the existing Worker name. Set `JEV_SERVICE_URL` and pause the service first; deployment checks its exact account, URL and paused status. Run the preview again before applying; it rejects a changed target, profile or folder map. Do not redeploy a changed category profile onto an active ledger without a migration plan.

## 7. Review a real prediction, then enable

```sh
npm run preview -- --latest
```

This sends the latest Inbox message to Jev and prints only its decisions, limitations, labels and proposed destination. Metadata is saved privately. It makes no mailbox changes. A completed or previously categorized message may be protected; do not remove its labels or flag just to force a preview.

After checking the result, explicitly choose a mode:

```sh
# Categories only; no moves:
npm run service -- resume --mode labels --limit 100

# Or Type folders plus task labels:
npm run service -- resume --mode type-folders --limit 100
```

Both include unprocessed Inbox mail within the configured lookback window. Use a small `lookbackDays` before initial setup if you want less history. Review several actual outcomes and classifier decisions before expanding use. A passing connectivity check or test suite is not a model-accuracy benchmark.

Pause at any time with `npm run service -- pause`. For catch-up, observation mode, audits and recovery, see [operations](operations.md).

## Private context and health dashboard

Setup creates `private/relationships.json`. Populate customer, supplier and internal domains there, using the keys described in [the resilience guide](resilience.md). Keep `RELATIONSHIP_CONTEXT_FILE=private/relationships.json` in `.env`; custom-taxonomy defaults must name your configured Type keys. Deployment validates and uploads this data as a Worker secret without printing its contents. Set `MS_SECRET_EXPIRES_AT` to the Microsoft secret expiry date for dashboard warnings. Neither setting changes the category profile or replays existing mail. Deployment previews bind the relationship content and expiry setting too; rerun preview after editing them.

After deployment, open `<your Worker URL>/dashboard` and enter the existing admin token from your private `.env`. Do not put the token into a bookmark or URL. Dashboard alerts refresh while the page is open; no external notifications are sent.
