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
   A 7-step wizard (PO lookup -> order info -> production notes ->
   **sizing** -> **inspection details** -> additional issues -> review)
   that produces a PDF and a pass/fail result. The questions asked are
   specific to the product type and come from `reportQuestions.json`;
   sizing is measured against the PO's own Product Dimensions table, not
   a generic template. See "The September 2026 QA/QC redesign" below,
   which is the section to read before changing anything in the report.
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
  orderDb.js                 SQLite storage for orders - schema, migration, WAL checkpoint
  orderManagementStore.js    Order CRUD, component definitions sync, dispatch targets
  componentDefinitionStore.js  Per-SKU sub-component specs (keyed sku::partName)
  poDispatch.js              Builds per-supplier dispatch targets and messages
  filePreview.js             Renders PDF/AI first page to an image (mupdf/WASM)
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
  reporting.html + app.js     QA/QC Reporting wizard (~190KB, the largest JS file)
  order-management.html + order-management.js   Order Management ERP (~300KB, the largest file overall)
  reports.html + reports.js   Report lookup/download
  analytics.html + analytics.js
  settings.html + settings.js
  styles.css                  Shared styles for every page
data/                         NOT in git - created at runtime, see DATA_DIR below
  orderManagement.db          SQLite - orders (see Data model)
  orderManagement.json        The pre-SQLite file, kept as the migration rollback
  order-management-files/     Uploaded previews, per order id
```

## Config files (`config/*.json`)

These are reference data, not code - edited either directly, or through
the Settings page (which writes back to the same files). Each one has a
`_readme` field at the top explaining its own structure and how it's
used, worth reading before touching one.

**The disk-seeded trap.** Several of these (`options`, `creatorTiers`,
`aqlRecommendation`, `unitCosts`, `fits`, `tolerances`) are *seeded* onto
the data disk on first run and read from there forever after. Editing the
repo copy of one of those changes nothing on an existing deployment - a
seeded file is never re-seeded. This has caused real confusion more than
once: values looked correct in git and were absent in production. Either
edit through Settings, or write a heal-on-boot merge like the one in
`loadTolerances()`. Files loaded with `require()` (`categories`,
`reportQuestions`, `conditionalChecks`, `i18n`, `aql`) deploy normally.

| File | Purpose |
|---|---|
| `i18n.json` | Every bilingual (en/zh) label in the app - by far the largest file. A missing key here silently shows nothing, so check this first if text seems to disappear. |
| `categories.json` | Product category/subcategory tree. Apparel subcategories link to a `fitGroup` in `fits.json`. Adding a top-level category also needs its key adding to `CATEGORY_ORDER` in `public/app.js`, or it is silently filtered out of both pickers. |
| `reportQuestions.json` | **The QA report question bank** - 112 bilingual questions grouped by product type, driving Steps 4, 5 and 6. Question ids are referenced by submitted reports; do not renumber. |
| `conditionalChecks.json` | Optional per-category checks offered at Setup Report Link (glow-in-the-dark, magnets, sound module, accessories). |
| `tolerances.json` | Per-category `sizingCm` / `printCm` / `weightG`, editable in Settings. Apparel `sizingCm` is written through to `fits.toleranceCm`. Disk-seeded, and the loader merges shipped defaults underneath the disk copy to heal partial files. |
| `fits.json` | Apparel sizing standards - each "fit" (e.g. Hoodie - Oversized) has a set of sizes and measurement points with generic standard values. Editable via Settings. |
| `options.json` | The editable dropdown lists: factory codes, creators, QA leads, PD leads. New values typed into these dropdowns get auto-added here (see `addNewOptionIfMissing` in server.js). |
| `aql.json` | The static AQL (Acceptable Quality Level) sampling table, standard reference data, not editable via Settings. |
| `aqlRecommendation.json` | Tier x Risk x PO-Size -> recommended Inspection Level and Point Check % range. Editable via Settings. |
| `creatorTiers.json` | Creator/brand -> QA Tier (1/2/3) mapping, feeds into the AQL recommendation. Editable via Settings. |
| `unitCosts.json` | Category/subcategory -> $ per unit, used for cost estimates in the Reporting flow. Editable via Settings. |
| `approvalPhotoSets.json` | Named photo slots on the PD approval page, per category. Step 5 questions can reference a slot (see the `reference` field in `reportQuestions.json`) to show the approved sample photo beside the question. |
| `approvalPhotoSets.json` | Which named photo slots (Front, Back, Hang Tag, etc.) appear on the QA/QC Approval page, per category. |
| `asanaFieldMap.json` | Asana integration config - see "Asana integration" below. |

## Data model

### Orders: SQLite (`data/orderManagement.db`)

Orders moved from a single JSON file to SQLite in September 2026. The
reason is scale: the import of ~4,700 historical POs is imminent, and the
old store read the entire file and rewrote it on every operation.
Measured with realistically-shaped records (accessories, size
distribution, dimensions table, both QA stages, dispatch log, field
history):

| Orders | JSON file | One edit (read + rewrite) |
|--------|-----------|---------------------------|
| 500    | 4.8 MB    | 76 ms                     |
| 2,000  | 19.3 MB   | 227 ms                    |
| 4,700  | 40.4 MB   | **627 ms**                |

Node is single-threaded, so each of those blocked every other request,
and `loadAll()` is called in 22 places - one Order Management page view
could stack several full parses.

The schema is deliberately **not** a relational decomposition. Each order
is one row whose `data` column holds exactly the JSON object the rest of
the app already passes around:

```
orders(id PK, po_number, sku, product_line, status,
       supplier_name, created_at, updated_at, data TEXT)
```

The extra columns exist only so lookups and filters happen in SQL instead
of loading everything and calling `.find()`. Because `data` is the same
object as before, `hydrateOrder`, `normalizeAccessory`, `toQaShape`, the
doc-slot matching and every caller work unmodified.

Measured after the change, same 4,700 records:

| Operation | Before | After |
|---|---|---|
| `getOrderById` | part of a 386 ms parse | 0.06 ms |
| `getOrderByPoNumber` | same | 0.04 ms |
| `getOrdersBySku` | same | 0.04 ms |
| `updateOrder` | ~627 ms | 0.23 ms |
| `listOrders` (filtered) | full scan | 0.05 ms |
| `listOrders` (unfiltered) | ~386 ms | 326 ms |

**`better-sqlite3` is a deliberate choice.** Its API is synchronous, so
none of the 22 call sites - nor anything upstream in `server.js` - had to
become async. It is a native module, so Render compiles it on deploy
(~1-2 min). `node:sqlite` is the zero-compile alternative if build time
ever becomes a constraint.

**Migration is automatic and idempotent.** On boot, if the `orders` table
is empty and `data/orderManagement.json` exists, it is imported. The JSON
file is deliberately left on disk afterwards as the rollback copy.

Two things to know if you touch this:

- The migration call sits at the **bottom** of `orderManagementStore.js`
  on purpose. `hydrateOrder` reads constants declared further down the
  module; running it beside `orderDb.init()` at the top throws a
  temporal-dead-zone error, and the surrounding catch meant the app
  booted against an empty database - indistinguishable from "all the
  orders are gone". The failure log is loud for the same reason.
- WAL mode creates `-wal` and `-shm` sidecar files. **Both backup paths
  call `checkpointDatabase()` before zipping**, because copying a WAL
  database without checkpointing produces a backup that restores short of
  recent writes or refuses to open - a failure invisible until someone
  needs it.

### Everything else: JSON files on the data disk

Still flat files, and fine at their sizes: suppliers (~137), the fabric
library (~1,049), users, clients, catalog products. The stores that grow
**per PO** are the migration candidates once the orders store has proven
itself in production:

- `componentDefinitionStore` - roughly 4,700 x 4 parts, so ~19,000 rows
- `approvalStore` - one per PO
- `submissionLog` - one per submitted report

They are the same pattern repeated; the second one is far quicker than
the first was.

### Uploaded files: preview + link, not the original

Design files (manufacturing drawings, hang tags, packaging artwork) are
**references, not archives**. Keeping originals meant years of
multi-megabyte artwork on a per-GB persistent disk, inside a weekly
backup that zips the whole data directory - the backup grows with it and
eventually stops completing.

On upload the user is asked for the Google Drive link. With one, the
server renders a preview image, keeps that, and deletes the original. A
2 MB drawing became a ~50-200 KB preview in testing. Without a link the
full file is kept, because discarding the only copy of something would be
indefensible - the dialog says so plainly.

The Drive link is stored in `mainComponent.docSourceUrls`, keyed by slot
field name. When present, the slot's link reads **Open in Drive**;
without one it reads **View file** and points at the local copy, so files
uploaded before this change behave exactly as they always did.

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

Still the goal. **AWS Lightsail** remains the recommended path over raw
EC2 - flat pricing, built-in static IP, simple firewall, closest to how
Render feels to operate. Given the China-based factory staff, the Hong
Kong region (`ap-east-1`) is worth considering for latency, though AWS HK
uses standard internet routing rather than a China-optimised backbone: a
meaningful improvement over hosting further away, not a guarantee.

What changes:

- **DATA_DIR**: provision a separate Lightsail **Block Storage** volume
  and mount it, rather than using the instance root volume, so data
  survives the instance. Same principle that mattered on Render.
- **Environment variables**: `DATA_DIR`, `ASANA_ACCESS_TOKEN`,
  `SITE_PASSWORD`, `SESSION_SECRET` into a `.env` on the instance. The
  app already uses `dotenv`, so no code change.
- **HTTPS**: Render does this automatically. On Lightsail, Nginx as a
  reverse proxy plus a Let's Encrypt certificate via `certbot`.
- **Process management**: `pm2` or systemd for restart-on-crash.
- **Deploys**: SSH in and `git pull && npm install && pm2 restart`, or a
  small GitHub Actions workflow doing the same over SSH. Note `npm
  install` now compiles `better-sqlite3`, so the instance needs
  build-essential and python3 present.

#### What SQLite changes about the migration

The previous version of this document said "nothing about the
application code changes". That is no longer quite true, and the
difference matters for how the AWS deployment is shaped:

- **Single writer.** SQLite is a file, and the app is the only process
  allowed to write it. That rules out running two or more app instances
  behind a load balancer against a shared volume. One instance, scaled
  vertically, is the supported topology. This is fine for the current
  user count but it is now an explicit architectural constraint rather
  than an accident.
- **Do not put the database on EFS or any NFS share.** SQLite's locking
  is not reliable over network filesystems, and the failure mode is
  corruption rather than an error. Block storage (EBS / Lightsail block
  storage), attached to one instance, is the correct choice.
- **Backups need the checkpoint.** Any backup mechanism added at the
  infrastructure level (volume snapshots, a cron job) must either use
  SQLite's own backup API or checkpoint first. A naive file copy of a
  live WAL database is not a valid backup. The in-app backup already
  handles this; anything added outside the app must too.
- **If multi-instance or multi-region ever becomes a requirement**, that
  is the point at which SQLite stops being the answer and RDS
  (Postgres) becomes worth the migration. The current schema - one row
  per order with a JSON blob - maps onto Postgres `jsonb` almost
  directly, so that path stays open and is not a rewrite.

#### Historical data import (~4,700 POs)

Planned, not yet executed. Sources: a master PO spreadsheet (4 years),
a variant breakdown sheet, per-supplier sheets covering subcomponents and
pricing, Asana for PD approval statuses, and Google Drive for the
approval docs and design files.

Agreed approach:

- **Storage swap first** (done - see Data model above). Importing into
  the old flat file would have made the app unusable.
- **Import in dependency order**: suppliers -> fabrics -> products and
  components -> POs -> variants -> subcomponents -> approvals -> files.
- **Go through `createOrder`/`updateOrder`**, not hand-written rows, so
  normalisation, the `Product - Part` qualification, component-definition
  sync and doc-slot matching all apply.
- **Idempotent, keyed on PO number**, with a dry-run mode producing a
  reconciliation report: rows in, records out, and every rejected row
  with a reason.
- **Google Docs PD approvals**: do not attempt to reconstruct structured
  approval records from years of free-form docs. Attach the doc link plus
  its extracted images to the PO, and take the structured fields
  (status, date, approver) from Asana, which is already structured.
- **Design files**: link to Drive with a generated preview, per the
  upload behaviour described in Data model. Do not copy Drive onto the
  instance volume.
- **Subcomponent names will be inconsistent across years.** Because
  component definitions are keyed `sku::partName`, inconsistent naming
  silently creates duplicate definitions. The first import pass should
  emit a **name-mapping table for human review** rather than importing
  straight through.

---

## Upload/Restore from Backup

Settings offers a one-click backup download and a restore. The backup is
a zip of the whole data directory. **It now checkpoints the SQLite WAL
before zipping** - see Data model.

---

# The September 2026 QA/QC redesign

The inspection report was reworked from a fixed checklist into a
config-driven, per-product-type flow. This is the largest recent change
and touches the report, Order Management, the PDF and the scoring.

## Step order changed

`STEPS` is now:

```
poLookup -> orderInfo -> productionNotes -> sizing ->
inspectionDetails -> issues -> review
```

Sizing and Inspection Details **swapped**: sizing is Step 4, inspection
is Step 5. The inspector measures first, then judges the piece against
what they found.

## Questions come from config, not code

`config/reportQuestions.json` holds 112 questions grouped by product
type. A group names its `category` and the `subcategories` it covers; an
empty subcategory list means the whole category (Bags, Other). Matching
is subcategory-first, then category.

Every question carries `title`/`title_zh`, `guidance`/`guidance_zh`,
`section`/`section_zh`, an `answer` format and a `media` rule. The
renderer resolves to the header language and falls back to English if a
translation is blank, so a question added without Chinese still renders.

`answer` is one of `passFailNa` (Step 5), `passFail`, `numeric` (plush
weight), `sizingChart`, or `defects` (Step 6).
`media` is `on_fail`, `photo_always`, `video_always`, `on_entry` or
`none`.

**Question ids are stable and are what submitted reports reference. Do
not renumber them.**

## Severity is derived, not chosen

The minor/major selector is gone. Severity now comes from *where* an
issue was recorded:

- A **Step 5** question answered Fail is **major**
- Anything logged in **Step 6** is **minor**
- An out-of-tolerance measurement is **major**
- Nothing is recorded as critical any more, so the old automatic
  critical-reject at ac=0 no longer fires

`collectAllDefects()` exists in both `public/app.js` and `lib/passFail.js`
and **they must agree**. The server's copy previously read only the old
`categoryData` keys, so it saw zero defects on every new-format report and
passed everything. Both now read `payload.inspection`.

## Counting: entries, units, and defective units

Three different things were being conflated, producing nonsense like "10
minor issues" from a sample of 5 units. `countDefects()` separates them:

- `entries` - how many distinct issues were logged
- `units` - the sum of units-affected across them
- `defectiveUnits` - **bounded by the number of units inspected**

The third cannot be derived by adding: if issue A affected 5 units and
issue B affected 5 of the same 5 checked, that is 5 bad units, not 10.
Nothing records which unit each issue was found on, so the honest answer
is a bound. All rates and the whole-PO extrapolation use `defectiveUnits`,
because a rate over 100% is meaningless.

The recap shows Found, **Total PO assumption** (the sample rate scaled
across the order, capped at PO quantity) and Accepted.

**A pre-production report used to always pass** - the branch built its
recap object and pushed no fail reason at all. It now fails on any
major/critical, and when every inspected unit had at least one issue. The
same all-defective rule was added to bulk, where minors alone previously
could never reject.

## Setup Report Link and conditional checks

`config/conditionalChecks.json` defines optional checks per top-level
category (glow-in-the-dark, magnets, sound module, accessories, other
functions). In Order Management, **Setup Report Link** opens a picker of
the triggers valid for that PO's category, plus custom one-off questions
with require-photo / require-video flags.

Stored on the PO at `qaReports.<stage>.setup`. Saving moves a Pending
stage to In Progress and the button becomes **Copy Report Link**. Bulk
pre-fills from the Pre-Production setup. A report opened before setup ran
gets `null` and proceeds with no additional questions - the safe default.

The server drops any trigger not defined for the PO's category, so a
stale dialog cannot attach sound-module questions to a pin.

## Tolerances are editable

`config/tolerances.json`, edited in Settings, holds three numbers per
category: `sizingCm`, `printCm`, `weightG`.

The one wrinkle: **apparel `sizingCm` is also `fits.toleranceCm`**, which
`passFail.js`, `pdfBuilder.js`, `app.js` and `approval.js` all read.
Rather than rewrite four consumers, it is written through to `fits.json`
on save and reconciled at startup. `tolerances.json` always wins.

Non-apparel dimensions are now scored against the category tolerance,
which they never were before. Out of tolerance **flags the field and
continues** - it does not block, because blocking just encourages
deleting the real number to get past the step.

Because this file is disk-seeded and went through two shape changes, the
loader merges the shipped defaults underneath whatever is on disk and
heals partial files on boot. An install still holding the first version
had an empty table and no scoring at all.

## Sizing is sourced from the PO

The PO's Product Dimensions table is the sizing source of truth. The
report and the PD approval page both pull from it and render it
**read-only**; QA can no longer pick a different standard than the order
was placed against. Where the PO has no table, the report shows a warning
with an **Enter manually** fallback that is not written back to the PO -
defining approved sizing is Product Development's call, not QA's.

Age brackets on youth sizes ("Youth M (8/9 yrs)") are stripped at display
time via `displaySizeName()`. The stored key is untouched, because
`fits.json` is disk-seeded and renaming keys would orphan every submitted
report.

## Sub-component naming

Parts are stored product-qualified: typing "Hang Tag" on the Test Plush
PO saves as **"Test Plush - Hang Tag"**. This was to stop the Components
page showing ten identical rows reading "Hang Tag".

`partType` holds the bare type alongside the qualified `partName`. The
doc-slot matchers test `partType`, because they are anchored regexes and
testing them against a product-qualified name would silently never match.
`partType` is **derived server-side** by stripping the product prefix,
not taken from the client, because the edit form only posts `partName`
and trusting it meant the type became the qualified name on the second
save.

## Dispatch rows follow the target

`dispatchImageRow` previously built every supplier's PO image from the
main component, so a hang-tag supplier received the plush photo, the
plush quantity and the plush delivery date. It now uses the target's own
photo, quantity and delivery date. A sub-component with no image attached
shows **no** photo rather than falling back to the product shot: a wrong
reference is worse than none.

---

## Removed

**WeChat and WeCom sign-in** (September 2026). `lib/wechatAuth.js`,
`lib/wecomAuth.js`, `lib/wecomCallback.js`, the `/auth/wechat`,
`/auth/wecom` and `/wecom/callback` routes, and the
`wechatOpenId`/`wechatUnionId`/`wecomUserId` identity fields. Never
offered in the UI and never configurable - the callback domain's ICP
filing could not be satisfied on an onrender.com subdomain. Google OAuth
and the shared site password are the only sign-in routes.

The WeChat **dispatch** workflow is unrelated and still in use: suppliers
have a WeChat ID contact field, and the batch-send flow renders the PO as
an image to paste into WeChat.

**Dead code removed**: `renderRestOfOrderInfo()` (no callers), the
`toleranceGuidance*` i18n strings, and `toleranceGuidanceKey` from five
categories.

---

## Known gaps

- `listOrders` unfiltered still parses all rows (~326 ms at 4,700).
  Pagination is the fix if the landing page gets slow, not more indexes.
- `approvalStore`, `submissionLog` and `componentDefinitionStore` are
  still JSON and grow per PO.
- The question bank's expanded guidance text has not had a native-speaker
  review of the Chinese, nor a full review of the English by the QA team.
- The app has not been tested with real inspection photos over Chinese
  mobile data - upload size and phone memory across dozens of photos per
  report is untested.
- The legacy defect paths in `collectAllDefects` are kept for in-flight
  reports and can be removed once none remain.
