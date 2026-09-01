# Juniper QA/QC App

An internal tool for Juniper Creates that manages the quality-control
lifecycle of a purchase order: creating a PO, getting Product Development
to approve a Golden Sample from China's factory team, then running
Pre-Production and Bulk inspection reports against that approved
standard. It's bilingual (English/Chinese) throughout, since the people
using it day-to-day are split between Juniper's Toronto office and
factory-side QA staff in China.

This document is written for an engineer picking this up cold - how it's
built, how the pieces fit together, what to watch out for, and what
changes if it moves off Render onto AWS.

## Who uses it, and the core workflow

Two groups, two different needs:
- **Juniper Creates staff** (Product Development leads, ops) - create
  POs, review and approve/reject Golden Samples, read reports.
- **China-side QA/factory staff** - upload sample photos, fill out
  Pre-Production and Bulk inspection reports, respond to PD's feedback.

The lifecycle for one product, in order:

1. **New Purchase Order** (`/index.html`) - someone at Juniper logs a PO:
   PO number, SKU, category, quantity, creator/brand, PD lead, and
   optionally an Asana task link. This is the shared record everything
   else hangs off of.
2. **QA/QC Approval** (`/approval.html?po=<id>`) - a three-stage,
   sequential workflow tied to that one PO:
   - **Sample Approval** - China's QA team uploads photos of the Golden
     Sample plus its measurements (for apparel). This becomes the
     approved standard everything downstream gets measured against.
   - **Pre-Production Approval** - same idea, for a small hand-checked
     batch before full production starts. Can be explicitly skipped for
     repeat POs of an already-established product (see "Skip
     Pre-Production" below).
   - **Bulk Approval** - the final production run's own sample.

   Each stage has a back-and-forth: China submits, Product Development
   responds with a decision (Approved / Approved with Issues Flagged /
   Not Approved) and/or free-text comments, China can reply, and this can
   go back and forth an arbitrary number of times before the next stage
   unlocks. See "The PD approval thread" below for exactly how this
   works.
3. **QA/QC Reporting** (`/reporting.html`) - the actual inspection
   reports: Pre-Production Sample Reporting and Bulk Sampling Reporting.
   A 7-step wizard (order info -> production notes -> inspection
   checklist -> sizing -> other issues -> review -> submit) that produces
   a PDF and a pass/fail result, using the approved Golden Sample's own
   measurements (not a generic template) as the standard to measure
   against.
4. **Reports** (`/reports.html`) - look up and download prior reports by
   SKU, or a single consolidated PDF combining a PO's entire QA/QC
   Approval history and every inspection report against it.
5. **Analytics** (`/analytics.html`) - pass/fail rates and defect trends
   by vendor, factory, and category.
6. **Settings** (`/settings.html`) - editable reference data: factory
   codes, QA leads, PD leads, creator tiers, AQL recommendation table,
   unit costs, apparel sizing charts (fits), and a one-click backup
   download of all persistent data.

## Architecture at a glance

- **Node.js + Express**, single server process, no build step.
- **Frontend is vanilla JS** - no framework, no bundler. Each page is a
  plain HTML file plus one big JS file that renders everything by
  building HTML strings and re-rendering on state change. `styles.css`
  is shared across all pages.
- **Storage is flat JSON files on disk**, not a database. Simple, but it
  means the disk itself needs to be persistent (see "The one thing that
  will bite you" below) and there's no query language - all the
  filtering/sorting logic lives in the `lib/*Store.js` files.
- **PDF generation** via PDFKit (report PDFs) and pdf-lib (merging PDF
  sections together for the consolidated report).
- **Photo uploads** via Multer, stored to disk as JPEGs, served back as
  static files.
- **No user accounts, no auth.** Anyone with the URL can use it. This is
  an intentional simplicity trade-off for an internal tool with a small,
  trusted user base - flag this if that assumption ever changes.

## Directory structure

```
server.js                    All Express routes - the entire backend API surface
lib/
  poStore.js                 Purchase Order CRUD (purchaseOrders.json)
  approvalStore.js           QA/QC Approval CRUD (approvals.json)
  submissionLog.js           Inspection report log (submissions.json) + DATA_DIR definition
  passFail.js                Pass/fail + tolerance logic, mirrored client-side in public/app.js
  aql.js / aqlRecommendation.js   AQL sampling table lookups
  analytics.js                Vendor/factory/category stats over the submission log
  pdfBuilder.js               Builds one inspection report's PDF (PDFKit)
  consolidatedReportBuilder.js  Builds the "everything for this PO" PDF (pdf-lib, merges sections)
  asanaClient.js              Thin wrapper around Asana's REST API (enum fields, text fields, attachments)
config/
  *.json                     All editable reference data - see "Config files" below
public/
  index.html + home.js        New Purchase Order page
  approval.html + approval.js QA/QC Approval page
  reporting.html + app.js     QA/QC Reporting wizard (this is the largest JS file - ~130KB)
  reports.html + reports.js   Report lookup/download
  analytics.html + analytics.js
  settings.html + settings.js
  styles.css                  Shared styles for every page
data/                         NOT in git - created at runtime, see DATA_DIR below
```

## Config files (`config/*.json`)

These are reference data, not code - edited either directly, or through
the Settings page (which writes back to the same files). Each one has a
`_readme` field at the top explaining its own structure and how it's
used, worth reading before touching one:

| File | Purpose |
|---|---|
| `i18n.json` | Every bilingual (en/zh) label in the app - by far the largest file. A missing key here silently shows nothing, so check this first if text seems to disappear. |
| `categories.json` | Product category/subcategory tree. Apparel subcategories link to a `fitGroup` in `fits.json`. |
| `fits.json` | Apparel sizing standards - each "fit" (e.g. Hoodie - Oversized) has a set of sizes and measurement points with generic standard values. Editable via Settings. |
| `options.json` | The editable dropdown lists: factory codes, creators, QA leads, PD leads. New values typed into these dropdowns get auto-added here (see `addNewOptionIfMissing` in server.js). |
| `aql.json` | The static AQL (Acceptable Quality Level) sampling table, standard reference data, not editable via Settings. |
| `aqlRecommendation.json` | Tier x Risk x PO-Size -> recommended Inspection Level and Point Check % range. Editable via Settings. |
| `creatorTiers.json` | Creator/brand -> QA Tier (1/2/3) mapping, feeds into the AQL recommendation. Editable via Settings. |
| `unitCosts.json` | Category/subcategory -> $ per unit, used for cost estimates in the Reporting flow. Editable via Settings. |
| `approvalPhotoSets.json` | Which named photo slots (Front, Back, Hang Tag, etc.) appear on the QA/QC Approval page, per category. |
| `asanaFieldMap.json` | Asana integration config - see "Asana integration" below. |

## Data model (`data/*.json`, created at runtime)

Three files, each an append-only-ish array of records (updates rewrite
the whole file - fine at this scale, would need to change for a real
database):

**`purchaseOrders.json`** - one entry per PO. Key fields: `id` (uuid,
used in the approval page URL), `poNumber`, `sku`, `category`,
`subcategory`, `productDevelopmentLead`, `sizesIncluded`, `fitKey` +
`fitSizes` (the established apparel sizing standard for this PO's SKU,
so a repeat PO of the same product can inherit it automatically),
`asanaTaskLink` + `asanaTaskGid` (the raw pasted link and the numeric ID
extracted from it).

**`approvals.json`** - one entry per PO (matched by `poNumber`), holding
all three stages:
```
{
  poNumber, sku,
  sampleApproval: { submitted, submittedAt, data, pdComments, skipped, skippedAt },
  preProductionApproval: { ...same shape... },
  bulkApproval: { ...same shape... }
}
```
`data` is whatever China submitted for that stage (photos, factory code,
QA lead, sizing measurements, etc. - shape varies slightly by
category/stage). `pdComments` is a plain chronological array - see "The
PD approval thread" below for how this is actually used.

**`submissions.json`** - one entry per inspection report submitted
through the Reporting wizard (Pre-Production or Bulk). This is the
system of record for pass/fail history, analytics, and the "reference a
prior report" feature. Each entry embeds its own `overallResult`,
`issues` (with photo URLs), and a `sizingCarryForward` block so a later
report on the same PO can pre-fill from it.

Generated PDFs and uploaded photos live in subfolders of the same
`DATA_DIR` (`submissions/`, `issue-photos/`, `approval-photos/`) and are
served back as static files - see the `app.use('/submissions', ...)`
lines near the top of `server.js`.

## Key design decisions worth understanding

### The established standard vs. the generic template

This is the single most important pattern in the app, and the source of
a couple of real bugs earlier in the project's life, so it's worth
understanding explicitly.

`fits.json` has a **generic** standard measurement for e.g. "Hoodie -
Oversized, Youth S, Sleeve: 62.2cm". But every PO's actual Golden Sample
can (and does) differ from that generic template - that's the whole
point of Sample Approval. Once established, PP and Bulk reports should
be measured against *that PO's own approved sample*, not the generic
fits.json number.

Both the client (`establishedStandardFor()` in `public/app.js`) and the
server (`establishedStandardFor()` in `lib/passFail.js` - a separate,
parallel implementation, not shared code) implement this same fallback:
check the PO's own submitted Sample Approval sizing first, fall back to
the generic `fits.json` value only if nothing's been established yet.
**Any new code that reads a sizing standard needs to go through this
path, not read `fits.json` directly** - that exact mistake caused a real
bug (tolerance flagging using the wrong baseline) that took real
debugging effort to track down.

### Size label matching

Apparel sizes are stored two ways depending on context: a plain canonical
name ("Youth S") on a PO's `sizesIncluded`, versus a fit-specific label
with an age range ("Youth S (6/7 yrs)") inside `fits.json` and in
submitted sizing data. Matching between the two needs to go through
`sizeMatchesCanonical()` (public/app.js) - a direct string comparison
between these two forms will silently fail to match and has caused real
bugs (sizes disappearing from a form) in the past.

### The PD approval thread

Each stage's `pdComments` array is rendered as a **plain chronological
list** - not "the first comment is the official decision, forever." Any
comment can optionally carry an `approvalStatus`
(`approved`/`approvedWithComments`/`minorIssue`/`majorCriticalIssue`);
the most prominent badge shown reflects whichever comment most recently
carried one. This means a Minor Issue flagged early in the conversation,
followed by discussion, followed by a later Approved, displays exactly
like that sequence - nothing is hidden or overwritten. `minorIssue` is
kept as a valid stored/displayed value for old data but is no longer
offered as a new choice in the dropdown (which now only offers three
options, matching Asana's wording - see below).

### Skip Pre-Production

For a repeat PO of an already-established product, the team often skips
Pre-Production Approval and goes straight from Golden Sample to Bulk.
`approvalStore.skipStage()` marks a stage `skipped: true` (distinct from
`submitted: false`, so it's visually clear this was a deliberate choice,
not something overlooked) - only Pre-Production supports this; Sample
and Bulk are always required.

### Bilingual text conventions

Every user-facing label goes through `i18n.json` via a `bi(key)` helper
that returns `{ en, zh }`. Two rendering patterns exist side by side:
stacked (Chinese on top, English smaller below - the default for most
labels, via `biBlockHtml()`) and inline slash-separated ("English /
中文" - used for compact contexts like table headers). If you add a new
label and it looks jammed together with no spacing, it's almost always
because the CSS default (`.zh { display: block; ... }` in styles.css)
got overridden by a more specific selector for that context - check for
one before assuming it's a JS bug.

## The pass/fail and AQL logic

`lib/passFail.js` (server-side, authoritative) and its close mirror in
`public/app.js` (client-side, live preview during the wizard) both
implement:
- **Tolerance check**: any apparel measurement more than `toleranceCm`
  (from `fits.json`, currently 1.27cm) off the established standard fails
  the report outright, regardless of everything else.
- **Pre-Production**: no formal AQL sampling applies - it just records
  defect counts on the small hand-checked batch.
- **Bulk/Production**: uses the AQL table (`config/aql.json`) plus the
  recommended Inspection Level (from Tier x Risk x PO Size, via
  `aqlRecommendation.json`) to determine Accept/Reject counts. A report
  only fails outright if *every* unit checked was defective - a partial
  defect rate doesn't auto-reject the whole PO, it's reflected in the
  Quantity Approved/Rejected recap instead.

## Asana integration

Three separate sync points, all "best-effort" by design: if
`ASANA_ACCESS_TOKEN` isn't set, a PO has no Asana link, or Asana's API
call fails for any reason, the app logs a warning and moves on - an
Asana hiccup should never block or fail someone's actual work in this
app. All three fire *after* the response has already been sent to the
person using the app (fire-and-forget), so they add no latency.

1. **QA/QC Drive Link** (text field) - written once, when a PO with an
   Asana task link is created. Value is this PO's own approval page URL.
2. **Sample/PP/Bulk Approval fields** (enum/dropdown fields, one per
   stage) - updated to "Waiting for Product Dev" the moment China
   submits a stage, and to the matching option
   (Approved/Proceed / Approved with Issues Flagged / Not Approved / Not
   Applicable) whenever PD records a formal decision, or Pre-Production
   gets explicitly skipped.
3. **Consolidated report attachment** - when Bulk gets marked Approved,
   the same PDF available from the Reports page gets generated and
   attached directly to the Asana task's activity feed.

All of this is driven by `config/asanaFieldMap.json` - the field GIDs
and enum option GIDs for this specific Asana project (these are internal
Asana IDs, not exposed in Asana's normal UI - see the file's own
`_readme` for how to fetch them via Asana's `custom_field_settings` API
endpoint). **Moving to a different Asana project requires regenerating
this whole file** - the GIDs are project-specific.

`lib/asanaClient.js` is the actual HTTP layer: `setEnumCustomField`,
`setTextCustomField`, and `attachFileToTask`, each a thin wrapper around
Asana's REST API using a Bearer token. No Asana SDK dependency - just
`fetch` (native in Node 18+).

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `PORT` | No (defaults to 3000) | HTTP port to listen on |
| `DATA_DIR` | **Yes, in any real deployment** | Absolute path to persistent storage - see below |
| `ASANA_ACCESS_TOKEN` | No | Asana Personal Access Token; leave unset to disable the Asana integration entirely |

See `.env.example` for the copy-pasteable version with fuller comments.

## The one thing that will bite you: DATA_DIR must be a real persistent disk

`DATA_DIR` defaults to a local `./data` folder next to the app code. That
folder **gets wiped on every deploy** on most hosting platforms,
including Render, because the app code itself gets redeployed fresh -
this has actually happened during this project's history and cost real
data.

`DATA_DIR` must point at the **absolute path of an actually-persistent
disk mount** - on Render, this means provisioning a paid persistent disk
and setting `DATA_DIR` to its mount path (e.g. `/var/data`). The app
has a built-in check for this: `GET /api/backup/status` (also surfaced
in the Settings page UI) flags both "not set at all" and "set to a
relative path" as misconfigurations, since both silently resolve to a
non-persistent folder. **Always check this after any redeploy or
migration** - it looks completely fine until the next deploy wipes it.

There's also a one-click full backup: `GET /api/backup/download` zips
the entire `DATA_DIR` on demand. Worth doing before any migration or
risky change.

## Local development

```bash
npm install
cp .env.example .env
# DATA_DIR=./data is fine for local dev - just don't use that on a real deploy
node server.js
```

No build step, no watch mode set up - restart the process to pick up
server.js changes; frontend JS/CSS changes just need a browser refresh.

## Deployment

### Currently: Render

A standard Render web service (`node server.js` via `npm start`), with a
paid-tier persistent disk attached and `DATA_DIR` pointed at its mount
path. Environment variables set in Render's dashboard under the service's
Environment tab. Deploys are git-push-triggered.

### Moving to AWS

The recommended path is **AWS Lightsail**, not raw EC2 - Lightsail is
AWS's simplified VPS product (flat pricing, built-in static IP, simple
firewall UI) and is the closest match to how Render feels to operate,
without EC2's extra setup surface (security groups, elastic IPs, volume
attachment as separate manual steps). Given this app's audience includes
China-based factory staff, Lightsail's Hong Kong region (`ap-east-1`) is
worth specifically considering for latency - though note AWS's Hong Kong
region uses standard internet routing rather than a China-optimized
backbone, so it's a meaningful improvement over hosting further away,
not a guarantee of great performance from every part of mainland China.

What changes and what doesn't, moving off Render:

- **DATA_DIR**: same concept, different disk. Provision a separate
  Lightsail **Block Storage** volume (not just the instance's own root
  volume) and mount it independently, so the data survives even if
  something happens to the instance itself - this is the same principle
  that mattered on Render, just a different product name.
- **Environment variables**: move `DATA_DIR` and `ASANA_ACCESS_TOKEN`
  into a `.env` file on the instance (this app already uses `dotenv`, no
  code change needed) rather than a platform dashboard.
- **HTTPS**: Render handles this automatically; on Lightsail this needs
  Nginx as a reverse proxy in front of the Node process, with a free
  Let's Encrypt certificate via `certbot`.
- **Process management**: Render restarts the process automatically on
  crash/deploy; on Lightsail, use `pm2` (or systemd) for the same
  behavior.
- **Deploys**: Render's git-push-to-deploy doesn't exist on a raw
  instance. Either SSH in and run `git pull && npm install && pm2
  restart` manually, or set up a small GitHub Actions workflow to do
  that automatically on every push (SSH-based, using repo secrets for
  the host/user/key - this touches nothing else in the AWS account
  beyond that one instance, no AWS access keys involved).
- **Nothing about the application code changes.** No AWS SDK, no S3, no
  Lambda - this is a plain Node process reading/writing a local disk,
  and that model carries over directly.

---

## New: Upload/Restore from Backup

Settings now has a "Restore from Backup" section right below the existing
Download Backup button. Upload a previously downloaded backup zip, and
it merges into the current data rather than replacing it wholesale:

- Any PO in the backup that isn't already in the live data gets added
- For a PO that already exists, a dropdown chooses what happens:
  **Skip it** (default, the safer option - keeps whatever's currently
  live) or **Replace it with the backup version** (overwrites the live
  record with the backup's)
- Referenced photos and PDFs come along automatically for anything added
  or replaced - filenames already carry a random ID, so there's no risk
  of accidentally overwriting an unrelated current file
- A confirmation prompt appears before anything happens, with different
  wording depending on which mode is selected, since "replace" is the
  more consequential of the two choices
- Server-side validation rejects anything that isn't a real zip, or a
  zip that doesn't actually look like a Juniper QA backup - with a clear
  message either way, not a generic error

New endpoint: `POST /api/backup/upload` (multipart, fields: `backup` file
+ `mode` of `ignore` or `override`), using a separate, much larger upload
size limit than regular photo uploads, since backups accumulate PDFs and
photos over time.

Tested the full round trip: downloaded a real backup, simulated a PO
going missing and another PO diverging from its backed-up version, then
restored in "skip" mode (confirmed the missing PO came back and the
diverged one was correctly left alone) and separately in "replace" mode
(confirmed the diverged PO was correctly overwritten back to the backup's
values). Also confirmed photos are restored correctly, confirmed clear
error messages for a non-zip file and for a zip that isn't a real backup,
and confirmed regular photo uploads and report submissions are
unaffected by the new, separate upload configuration.

---

## Both features from the team's feedback are now complete and tested

### Apparel Sizing Charts: additional columns

A "+ Add Additional Column" button on the Golden Sample setup screen lets
someone add a product-specific measurement point (e.g. "Inseam") beyond
the fit's standard ones - name it, remove it if added by mistake, and
fill in a value per size. That column then flows everywhere the standard
ones do: the Reporting flow's reference chart and measurement entry, the
Sizing Details comparison table, tolerance/pass-fail checking (both
client preview and the authoritative server-side check), and the
generated PDF report (both the reference table and the measurement
table).

Two real bugs were caught and fixed while finishing this: the PDF's
measurement table was still comparing a custom column against the
generic fits.json template (which never has that column, so it would
have shown nothing and never flagged tolerance correctly), and the
"Add Column" button itself crashed on click because it called a helper
function that only exists in a different file.

Verified end-to-end through the real UI, not just code review: added an
Inseam column, filled it in, submitted the Golden Sample, confirmed it
appears correctly in Reporting with the right established value,
confirmed tolerance flagging correctly catches a bad value and clears a
good one, and downloaded and visually inspected the actual generated PDF
to confirm the column renders with correct red tolerance highlighting.

### QA/QC Approval comments: reference a photo or a size row

A "Reference (optional)" dropdown in the comment/reply form lists every
photo uploaded for that stage, plus (Golden Sample only, since that's the
one stage with its own inline size chart) every size row. Picking one
attaches it to the comment. A submitted comment with a reference shows a
small clickable chip; clicking it smoothly scrolls to and briefly
highlights the actual photo or size-chart row it points at, wherever that
lives on the page.

A few judgment calls made building this, worth knowing about:
- One reference per comment, not several
- Jump-and-highlight, not an inline preview thumbnail
- Only Golden Sample can reference a size row, since Pre-Production and
  Bulk don't have their own inline size chart in the Approval page (their
  sizing lives in the separate Reporting flow's report history instead)
- If the referenced photo or size no longer exists by the time someone
  clicks the chip (unlikely, but possible if data changed since), it
  shows a clear message instead of doing nothing or breaking

Tested the complete flow for both reference types: selected a photo
reference, submitted the comment, confirmed the chip appears with the
correct label, confirmed clicking it correctly targets and highlights
that exact photo. Repeated the same for a size-row reference. Also
confirmed the reference is correctly saved server-side, and confirmed a
comment with no reference selected still submits and displays completely
normally.

---

## Merged in a fix made directly against an older file version

Two files (approval.js, styles.css) came back edited from a separate
conversation, based on a version of the app from before the custom
sizing columns and comment-reference features existed in this session.
Diffed them directly against the current working files rather than
assuming - confirmed they were missing both of those features (would
have been lost if used as-is), but also contained a genuine fix neither
had: photos in the comparison views (Approved Sample vs Pre-Production vs
Bulk, and the Reporting flow's photo gallery) now sit inside a bordered,
fixed-aspect-ratio frame with `overflow: hidden`, rather than relying on
the `<img>` tag's own `border-radius` and `aspect-ratio` to clip
correctly on their own - a likely fix for the inconsistent photo
edge/shadow artifact raised earlier, since a wrapping frame reliably
clips regardless of a given photo's actual dimensions.

Merged the frame fix into the current, complete version rather than
picking one or the other - applied it to all three photo-comparison
spots in approval.js and the Reporting flow's own photo gallery in
app.js (which needed the same wrapper added, since the underlying CSS
rule this fix relies on had moved off the bare `<img>` tag). Re-diffed
against the originally uploaded files afterward to confirm every part of
the fix made it in, and confirmed both the custom sizing columns and
comment-reference features (the ones that would have been lost) are
intact and still working after the merge.
