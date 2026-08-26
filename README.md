# Juniper QA/QC Report App

A mobile-friendly web app for logging QA/QC inspections (Apparel, Plush Toys, Other),
capturing photos, flagging out-of-tolerance measurements automatically, and generating
a bilingual (English/Chinese) branded PDF report.

This first version is set up for **local testing** so we can nail down the workflow,
fields, and wording before wiring up real email delivery and hosting it somewhere
reachable from China.

---

## 1. Run it locally (5 minutes)

You need [Node.js](https://nodejs.org) installed (v18 or newer).

```bash
cd juniper-qa-app
npm install
npm start
```

Then open **http://localhost:3000** in your browser.

That's it — no email setup, no cloud account needed. Because no SMTP settings are
configured yet, the app automatically runs in **Test Mode**:

- Fill out the form like a real inspection.
- Hit Submit.
- Instead of emailing anything, it generates the real PDF and gives you a
  **"View Generated PDF"** link right there so you can check it immediately.
- Every test PDF is also saved in the `submissions/` folder on your computer, so you
  can look back at past test runs.

## 2. Testing on your phone (recommended, since this is built for iPhone/tablet use)

The camera capture and mobile layout only really make sense on a phone/tablet, so it's
worth testing there instead of just in a desktop browser:

1. Make sure your phone and computer are on the **same WiFi network**.
2. Find your computer's local IP address:
   - Mac: System Settings → Wi-Fi → Details (something like `192.168.1.23`)
   - Windows: `ipconfig` in Command Prompt, look for "IPv4 Address"
3. On your phone's browser, go to `http://<that-ip>:3000` (e.g. `http://192.168.1.23:3000`)
4. Add it to your home screen (Safari: Share → Add to Home Screen) so it opens full-screen
   like an app while you're testing.

## 3. What to check while testing

- Does the step order make sense for how your team actually does an inspection?
- Are the bilingual labels accurate? (I did my best on the Chinese translations, but
  your team should sanity-check the QA/manufacturing terminology.)
- Try the Apparel flow: pick a fit, type in some measurements more than 0.5" off from
  the placeholder standard, and confirm they get flagged in red — both in the app and
  in the generated PDF.
- Take a few real photos on your phone (general, tags, and on an issue) and confirm
  they land correctly in the PDF's photo sections.
- Open the generated PDF on your phone too, not just desktop, to make sure it's easy
  to review on a small screen.

Anything that feels off — wrong fields, missing checks, wording, extra steps you don't
need — flag it and we'll adjust before moving to the real deployment.

---

## What's still placeholder / to confirm before going live

- **`config/fits.json`** — now populated with real approved measurements imported
  from `Juniper - Size Charts.xlsx` for Crewnecks (4 fits), T-Shirt (9 fits), Hoodie
  (7 fits), Jacket (5 fits), and Hat (1 fit) — 26 fits total. Jacket width and Hat
  circumference are stored as approved ranges (e.g. "47-48.5 in") rather than a single
  target number, and the tolerance check treats a measurement as out-of-range only if
  it falls outside that range by more than the 0.5" buffer. Socks, Slippers, Onesie,
  Shorts, and Sweatpants/Joggers were intentionally left out of this round (either no
  data yet, or a different sizing model like shoe sizes) — let me know if you want
  those added next.
- **`config/options.json`** — the dropdown lists for Creator/Brand, Factory Code, Point
  Check Rate, and QA/QC Lead. Plain JSON, easy to edit directly.
- **Chinese translations** — in `config/i18n.json`, one line per label.
- **Pass/Fail logic** — FAIL if any apparel measurement is out of tolerance, FAIL if
  3+ minor issues, FAIL if 1+ major/critical issue, otherwise PASS. Lives in
  `lib/passFail.js`.
- **Fail requires a photo** — marking any check as "Fail" makes that section's photo
  upload required before moving on or submitting.
- **The form won't let you submit** until every check has a Pass/Fail/N-A selected, any
  required fail-photos are attached, and (for Apparel) a fit is picked with at least
  one measurement entered. Anything still missing shows up in a red list on the Review
  screen.
- **"Other" option** on Factory Code, Creator/Brand, and QA/QC Lead dropdowns — picking
  it reveals a text box for a one-off custom value. That value is only used for that
  report; if it should be a permanent option going forward, add it via Settings (see
  below).
- **Settings page** — a gear icon on the first screen (category selection) opens
  `settings.html`, where you can add or remove entries in the Factory Code,
  Creator/Brand, and QA/QC Lead lists. Changes save to `config/options.json` on the
  server and apply immediately for everyone using the app - no redeploy needed. Point
  Check Rate isn't editable here since it's a fixed 10-100% scale.
- **Mobile photo uploads** now get resized and compressed in the browser before being
  held in memory or uploaded (down to roughly 100-400KB each, from several MB straight
  off a phone camera). This should fix the low-memory crash when adding new photos on
  a phone. If it still happens on a particular device, let me know - it likely means
  that device needs an even smaller size cap than the current default.
- **Product categories now have a two-level structure**: Apparel (Hoodie, T-Shirt,
  Sweatshirt, Hat, Other), Plush Toys (Standard, Mini, Electronic), Bags (Backpack,
  Lunchbox, Purse, Tote, Other), Accessories (Keychain, Pin, Notebook/Sketchbook,
  Other), and Other. Only Apparel's subcategories link to real measurement charts
  (`config/fits.json`), since that's the only category with real spreadsheet data.
  One thing to flag: your Apparel subcategory list didn't include "Jacket," but we do
  have real Jacket measurements from your spreadsheet - I mapped Apparel → "Other" to
  show the full fit list including Jacket as a fallback. Let me know if Jacket should
  be its own subcategory instead.
- **Real AQL sampling (ANSI/ASQ Z1.4 / ISO 2859-1)** replaces the old ad-hoc pass/fail
  rule. On the Order Info step, enter the **Lot Size** (total units in the PO) and pick
  an **Inspection Level** (defaults to General II, the standard choice) and **AQL
  values** for Major/Minor defects (defaults 2.5/4.0, the industry standard - Critical
  is always zero-tolerance, Accept 0/Reject 1). As soon as a lot size is entered, the
  app shows the exact sample size code letter, required sample size, and Accept/Reject
  thresholds for reference during the physical inspection. That same reference re-
  appears live on the Issues step (updating as you log defects) and on the Review step,
  and the full breakdown is now a section in the generated PDF. If a chosen AQL/lot
  size combination requires more units than the sample size implies (edge case where
  the underlying published table has no direct entry and points to a different sample
  size), the app inspects at the larger of the two implied sample sizes - a
  conservative, standard-referenced simplification of applying the full arrow logic
  by hand. If no lot size is entered, the app falls back to the old simple heuristic
  (3+ minor issues, or 1+ major/critical issue) so it still works, but this is meant as
  a stopgap, not the primary way to use it now.
- **Defects are now logged inline, where they're found** — each section (Fabric,
  Embroidery, Printing, Washing Tags, Sizing, Packaging) opens a small defect log
  right there when you mark it "Fail": description, severity, **units affected**, and
  a photo, all in one place. You can log more than one defect per section - matches
  how an inspection actually happens on the floor, noting the problem the moment you
  find it rather than reconstructing a list afterward.
- **"Additional Issues" (last step before Review) is now a catch-all**, not the
  primary place defects get counted - for anything that doesn't fit neatly into a
  section above.
- **The AQL tally sums units affected, not the number of log entries.** This fixes a
  real gap in the first version: logging "found a defect across 20 units" as one
  entry only counted as 1 toward the AQL threshold. It now correctly counts as 20.
  Every defect requires a "Units Affected" count (defaults to 1) alongside its
  description and photo.

---

## Sharing a test version with a colleague

Since your colleague has Google Workspace access in Canada (no China connectivity
constraints for this test), there are two easy ways to get them a working version
without needing your computer to stay on:

### Option A — Quick temporary link (fastest, good for a live walkthrough)

While the app is running locally (`npm start`), you can expose it with a free
tunneling tool called [ngrok](https://ngrok.com/download):

1. Download and install ngrok, then sign up for a free account (needed for the
   authtoken step it walks you through).
2. In a **second** terminal window (leave `npm start` running in the first one):
   ```
   ngrok http 3000
   ```
3. Ngrok prints a public URL like `https://random-name.ngrok-free.app` — send that
   to your colleague. It stays live as long as both `npm start` and `ngrok` are
   running on your machine.

This is the fastest option but is temporary — closing either terminal window ends it.

### Option B — Persistent hosted link (better if they'll test on their own time)

[Render.com](https://render.com) has a free tier for small Node apps and doesn't
require a credit card to start:

1. Push this project to a GitHub repo (or use Render's manual upload/CLI deploy if
   you'd rather not use GitHub).
2. In Render, choose **New > Web Service**, connect the repo.
3. Build command: `npm install` — Start command: `npm start`
4. Add the environment variables from `.env.example` under the service's
   **Environment** tab (see Gmail setup below for real email during testing).
5. Render gives you a permanent URL like `https://juniper-qa.onrender.com` you can
   share directly — your colleague just opens it, no setup on their end.

(Free-tier Render services sleep after inactivity and take ~30s to wake up on the
first request — fine for a test, worth knowing so it doesn't seem broken.)

### Real email for this test (optional)

Since this test isn't constrained by China connectivity, Gmail SMTP works fine here
if you want your colleague to see the actual "email arrives with PDF attached" flow
instead of just the in-app PDF preview:

1. On the Google account you want to send from, turn on 2-Step Verification if it
   isn't already on.
2. Go to [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords)
   and generate an App Password (choose "Mail" as the app).
3. Set these in `.env` (or Render's Environment tab):
   ```
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=587
   SMTP_SECURE=false
   SMTP_USER=your-gmail-address@gmail.com
   SMTP_PASS=the-16-character-app-password
   SMTP_FROM=your-gmail-address@gmail.com
   REPORT_RECIPIENTS=mikhail@junipercreates.com,colleague@example.com
   ```
   Note this is just for this Canada-based test — the real production deployment in
   China will need a different provider, as covered below.

---

## Next step: China hosting + real email

Once the workflow is confirmed, the remaining pieces to go live for your China-based
team are:

1. **Hosting**: deploy this Node.js app somewhere reachable from mainland China without
   a VPN — e.g. Alibaba Cloud, Tencent Cloud, or a Hong Kong/Singapore-based host. The
   app itself doesn't depend on any Google services, so this is a standard Node
   deployment.
2. **Email**: since Gmail/Google Workspace SMTP isn't reliable from China, we'll use a
   China-friendly provider (Alibaba Cloud DirectMail, Tencent Cloud SES) or a global
   provider like SendGrid — the important part is that the *app server* (not your
   phone) is what talks to the email provider, so it just needs the server to be
   hosted somewhere with good connectivity.
3. Set the real `SMTP_*` variables in `.env` for that provider once chosen.

I'm happy to help with either of those once you're ready.


---

## AQL recommendation is now automatic

Instead of manually picking Inspection Level and a Point Check %, the app now
recommends both automatically based on your actual company policy:

- **PO Quantity** (renamed from Lot Size) x a rough per-unit cost (by category/
  subcategory, see `config/unitCosts.json`) estimates the **Order Value**.
- Order Value buckets into a **PO Size** band (>$20k, $5-20k, <$5k).
- The selected **Creator** maps to a **QA Tier** (1/2/3) via `config/creatorTiers.json`
  - all 218 creators from your Creator_List_QA.xlsx are pre-loaded, with a default
  tier of 2 for anyone not listed.
- **Product Complexity/Risk** (High/Medium/Low) is a new required field you set per
  report.
- Tier x Risk x PO Size looks up a recommended Inspection Level + Point Check % range
  in `config/aqlRecommendation.json` (this is the reduced form of your spreadsheet -
  every creator sharing a tier had identical recommendations, so it collapses to a
  clean 27-cell table instead of 218 rows).

The recommended Inspection Level auto-fills the existing Inspection Level control,
but you can still override it manually if needed - once you touch it, the app stops
auto-following the recommendation for that report.

**Actual Spot Check Percentage** moved out of the top Order Info section to the
Review step, since it's the real, as-inspected number (which may differ from the
recommendation during busy periods) rather than an upfront input.

All three new datasets (Creator Tiers, the AQL Recommendation table, and Unit Costs)
are editable from the Settings page (gear icon on the category screen) - no code
changes needed if tiers, policy, or costs change.

**"Additional Issues" is now framed as "Tolerance & Placement Issues"** - for finer
issues like an off-center graphic or a slightly misaligned print, since the sections
above already cover major issues like material and construction.

---

## Pre-Production vs Production Sample now work differently

- **Top section of Order Info** (PO Number, Factory Code, Date, QA Lead, Creator,
  Product Title, QA Type, PO Quantity, Product Complexity/Risk) is always filled in
  regardless of QA Type.
- **Pre-Production Sample**: AQL sampling doesn't apply at all - the whole AQL card is
  replaced with a short note. You still go through every inspection section, just on
  a handful of hand-checked units (at least one per size).
- **Production Sample**: the full AQL card appears, showing:
  1. A **recommendation** (Creator Tier, Estimated Order Value, recommended Point
     Check % and Inspection Level) computed live from Creator + PO Quantity + Risk.
  2. A **reference threshold table** for that recommendation (informational).
  3. An **Actual Spot Check %** field (required for Production) - once filled in,
  4. An **Actual Thresholds** table appears, using the real number of units checked
     (PO Quantity x Actual %) to determine Accept/Reject - not the theoretical
     recommended sample size. Checking fewer units than recommended (e.g. during a
     busy period) correctly tightens the allowable defect count, and vice versa.

One nuance worth knowing: the published AQL standard has a ceiling for a given AQL
value - checking far more units than the standard's own table defines for that AQL
doesn't keep expanding the allowed defect count indefinitely (that's a property of
the real ANSI/ASQ Z1.4 table itself, not a shortcut on my end).

## Other changes this round

- **Category → Subcategory** now displays inline - selecting a category shows its
  subcategory chips directly attached below that card, not below the whole list.
- **General section photos are back**, alongside the per-defect photos from last
  time - each inspection section (Fabric, Embroidery, Printing, Washing Tags, Sizing,
  Packaging) now has both a general documentation photo area (always available) and
  the required photo(s) on any logged defect.
- **Apparel sizing now has a photo box per size** instead of one shared "Sizing
  Photos" area - easier to keep organized when checking multiple sizes.
- **Tolerance guidance placeholders** added for Plush, Bags, Accessories, and Other on
  the Sizing step - these are clearly marked as placeholder text and need your real
  numbers; apparel's real tolerance already comes from the measurement chart itself.
- **"Additional Issues" → "Tolerance & Placement Issues"** - reframed as the spot for
  finer issues like an off-center graphic or slightly misaligned print, since the
  sections above already cover major issues like material and construction.

---

## AQL simplified further, and a Recap section added

- **Actual Spot Check is now a plain number** ("e.g. 400" units checked), not a
  percentage - the app auto-computes and displays the percentage next to it. This
  also feeds the pass/fail math directly, with no rounding round-trip through a %.
- **Inspection Level, Major AQL, and Minor AQL are no longer shown or editable.**
  Major/Minor are fixed at the industry-standard 2.5% / 4.0%, and Inspection Level
  is derived silently from the Creator Tier table - neither needs a decision from
  QA staff anymore.
- **Code Letter removed everywhere** - only the plain Accept/Reject numbers show,
  no ANSI table jargon.
- **Recommendation now shows an actual quantity range** (e.g. "400 - 700 (40-70%)")
  instead of a bare percentage, computed against the PO Quantity.
- **Severity definitions added** under the Minor/Major/Critical picker on every
  defect card, based on how AQL classification actually works in practice: Minor
  means the unit is still saleable, Major means that specific unit is rejected
  (not automatically the whole batch), Critical means zero tolerance - even one
  can fail the entire batch. (Source: https://www.qcadvisor.com/blog/acceptable-quality-limit-classification/)
- **Pre-Production Sample now shows nothing at all** for the AQL section - no card,
  no notice, since AQL sampling genuinely doesn't apply to a small hand-checked
  sample.
- **New Recap section**, at the very end of the report (Production only): Quantity
  Checked, Quantity Approved, and Quantity Rejected. A unit is only counted as
  rejected if it has a Major or Critical defect logged against it - units with only
  Minor defects stay in the Approved count, since minor issues don't make a unit
  unsaleable. One caveat worth knowing: since defects are logged as counts rather
  than tracked to a specific physical unit, a unit with both a Major and a Critical
  defect could in principle be counted in both tallies - this is a reasonable
  estimate given the data the app collects, not an exact unit-by-unit ledger.

---

## Chinese-first, and AQL simplified to a pure accept/reject model

- **Chinese now displays first everywhere** (app and PDF) - English is the secondary
  language, flipped from before. This was done at the source (the `bi()` translation
  helper in each file), so it's consistent throughout without needing per-line changes.
- **Step 2 ("Spot Check Recommendation", renamed from "AQL Recommendation")** no
  longer shows the "Reference Thresholds" table - just the recommendation itself
  (Creator Tier, Estimated Order Value, Recommended Units to Check).
- **The overall pass/fail policy changed.** A PO is no longer auto-rejected just
  because it has a lot of major defects. Instead: individual defective units
  (Major or Critical) are rejected, the rest of the reviewed quantity is approved
  (including units with only Minor issues - minor issues don't make a unit
  unsaleable). The report only fails outright if every single unit reviewed turned
  out defective. A partial defect rate is reflected honestly in the Quantity
  Approved/Rejected numbers, not treated as a batch-wide failure. Tested with a
  150-of-400-major-defects scenario: the report correctly stays "合格 PASS" with
  250 approved / 150 rejected shown plainly, rather than auto-failing.
- **The Critical/Major/Minor table now shows Found / Accepted instead of
  Accept/Reject thresholds.** Minor's "Accepted" always equals its "Found" count
  (minor issues stay accepted); Major and Critical always show 0 accepted (that
  specific unit is rejected).
- **The Recap now includes PO Size** alongside Quantity Checked, Approved, and
  Rejected - both on the Review step and in the PDF (shown once near the AQL
  section for context, and restated at the very end of the report as a clean
  bottom line).
- **Apparel sizing now has an "Other / Custom Sizing" option** in the fit dropdown,
  for cases with a different approved sizing not covered by the standard charts.
  Selecting it swaps in the same general Pass/Fail/defect-logging checklist that
  non-apparel categories use, instead of the numeric measurement chart.
- **Fixed a PDF bug found during this update**: the footer page-number text was
  being drawn inside the page's bottom margin, which confused PDFKit's own
  auto-pagination into silently inserting extra blank pages at the end of every
  report (a 3-page report was coming out as 6 pages). Fixed by temporarily
  zeroing the bottom margin while the footer draws.

---

## Report history, analytics dashboard, and a favicon

### Fixed: "Units Checked" needing a click between every digit

Typing into that field was triggering a full re-render of the section it lives
in (to update the live preview), which destroyed and recreated the input on
every keystroke and dropped focus. Fixed by splitting the input from the
derived content around it, so only the preview updates live now - the input
itself is untouched while you type.

### Report history (needs a persistent disk to actually stick around)

Every submission now gets logged to `DATA_DIR/submissions.json` (see
`lib/submissionLog.js`), and every generated PDF is saved to
`DATA_DIR/submissions/` - both always on now, not just in test mode. Set
`DATA_DIR` in `.env` to match your Render persistent disk's mount path so this
survives restarts; it defaults to a local `./data` folder otherwise.

When you start filling out a new report and enter a **PO Number** that matches
an earlier submission (case-insensitive, exact string match - e.g.
"JDAN01PLU1-PO3"), a **"Previous Report Found"** card appears right below the
PO Number field: date, result, every issue that was logged, and a link to
download that report's full PDF. This is how a Production report can
reference the Pre-Production report for the same PO.

### Analytics dashboard (new page, linked from the category screen)

A new 📊 Analytics link sits next to ⚙️ Settings on the first screen. It has
two sections:

- **Overall Stats** - all POs, broken down by top-level category (Apparel,
  Plush Toys, Bags, Accessories, Other), organized by month.
- **Vendor Stats** - pick a Creator from a dropdown, see the same breakdown
  scoped to just that vendor.

Both default to the last 90 days, with a dropdown for 30 days / 90 days / 6
months / 1 year / all time. Each month (and a totals row) shows: POs Placed
(distinct PO numbers), Manufactured Quantity (sum of PO Quantity across
Production reports completed that month), Units Checked, Units Rejected,
Defective Rate, and Pass Rate. "Manufactured" is keyed to when a Production
Sample report was completed, per your instruction - Pre-Production reports
don't contribute to quantity/rate figures since they don't carry a formal
checked quantity.

This is all computed live from the same submission log above, so it's only as
complete as your submission history - same persistence caveat applies.

### Favicon

Generated from the existing teal tree logo (`public/assets/juniper-mark.png`)
at the standard sizes (favicon.ico, 32x32 PNG, 180x180 apple-touch-icon) and
wired into all three pages (main app, Settings, Analytics).

---

## Bug fix and refinements

### Fixed: phantom "photo required" error with nothing visibly logged

Found the exact cause of the bug you screenshotted: marking a checklist item
"Fail" auto-creates an empty defect placeholder (so you don't hit a dead end
if you tap Fail and add details a moment later). If you then changed your mind
and switched it back to Pass or N/A, that placeholder stayed behind invisibly
in the underlying data - the UI only shows the defects area while a section is
marked Fail, so there was no way to see or remove it. Submission then correctly
saw an incomplete defect (no description, no photo) and blocked with the
confusing error, even though nothing appeared to be logged. Fixed by clearing
a section's defects whenever its status changes away from Fail.

### Recap changes

- No more mentions of "AQL" in the Recap's plain-language notices.
- **PO Size now always shows** in the main Order Information section of every
  report, not just buried in the Production recap.
- **Pre-Production now has its own "Quantity Checked" field** - a simple
  manual count of how many units you physically hand-checked - which now
  shows up in both the app's live recap and the PDF's Recap section
  alongside PO Size and the Critical/Major/Minor counts.

### "Previous Report Found" - moved and upgraded

- Now sits at the bottom of the Order Info step as its own dedicated section,
  after everything else, instead of squeezed under the PO Number field.
- Each issue now displays as a larger card - description, a proper severity
  badge, units affected, and the actual defect photo shown inline - matching
  how the PDF itself presents a defect, instead of a small text-only bullet
  list. This needed new backend support: defect photos are now saved
  separately to persistent storage (alongside the PDF) specifically so they
  can be pulled back up here without needing to open the full report.

### Analytics: filter by Vendor or Factory Code

The Vendor Stats section now has a toggle - Vendor or Factory Code - and
switches the dropdown and the underlying query accordingly. Both use the same
month-by-month stats format as before.

---

## Custom sizing, pre-fill, and a sizing chart editor

### Apparel "Other / Custom Sizing" now has a real chart

Instead of falling back to the same generic checklist as plush/bags/etc, "Other"
now gets: a fillable chart (add a size, type in its measurements freeform, attach
a photo of that specific size) plus a separate "Reference Chart Photo" upload for
snapping a whole paper breakdown if that's faster than typing. The Pass/Fail
sizing check still applies too, since there's no automatic tolerance comparison
for a custom fit - the manual check is the actual QC record here.

(Fixed a related bug while building this: apparel with "Other" fit was silently
skipping the sizing Pass/Fail checklist entirely - that logic only made sense for
standard fits with automatic tolerance checking, not "Other," which has none.)

### Pre-fill from the Pre-Production report

Step 2 is now two boxes: the first is just **PO Number + QA Type**. Once you enter
a PO Number that matches an earlier report and select **Production Sample**, the
second box (Factory Code, Date, QA Lead, Creator, Product Title, PO Quantity,
Risk) - plus the sizing chart itself, if apparel - fills in automatically from
whatever was entered on the Pre-Production report for that same PO. Anything you've
already typed is never overwritten, and a small note flags when a field was
auto-filled so it's obvious to double-check. Photos are never carried forward -
only text and measurements - since photos are physical evidence tied to a specific
inspection, not something that should be silently reused.

### Settings: edit apparel sizing charts

New section at the bottom of Settings - pick a standard from a dropdown to edit
its chart (sizes, measurement points, and values - a value can be a plain number
like `24` or a range like `24-26`), or add a brand new standard from scratch.
Changes take effect immediately, no restart needed.

### Bag category

"Purse" is now labeled "Sling Bag" (the underlying data key is unchanged, so this
doesn't affect existing reports or analytics).

---

## Phase 1: Site restructure, three workstreams, New Purchase Order

Bigger picture change - the app is being split into three main workstreams
(QA/QC Reporting, QA/QC Approval, Reports), rolled out in phases. This is
Phase 1: the new home page, the split, and the New Purchase Order flow.

### New site layout

- `index.html` is now the home page: three main buttons (QA/QC Reporting, QA/QC
  Approval, Reports) plus Settings and Analytics.
- The existing inspection wizard moved to `reporting.html` (same `app.js`).
- `approval.html` and `reports.html` are placeholders for now (Phases 3 and 4).
  Approval's placeholder is functional in one respect already: if reached via a
  New Purchase Order's share link, it pulls and displays that PO's real data,
  so the link isn't a dead end while the rest of that workflow gets built.
- Fixed a bug found along the way: the Settings/Analytics header links were
  showing Chinese only, with no English at all.

### QA/QC Reporting now starts with a chooser

Three options: **New Purchase Order**, **Pre-Production Sample Reporting**,
**Bulk Sampling Reporting**. The latter two drop straight into the existing
wizard (unchanged for now - that's Phase 2). Finishing a report returns to
this chooser instead of restarting the wizard directly.

### New Purchase Order

A lightweight one-page form: Category/Type, PO Number, Product SKU, Order
Date, Order Quantity, Creator, Product Development Lead, and - for apparel -
which sizes are included in this specific PO.

The sizing part depends on whether this SKU already has an established
sizing standard on file (set later, during QA/QC Approval's Sample Approval
step):
- **If yes** (a later PO for a SKU that's already been through Approval),
  its size list shows as a multi-select automatically.
- **If no** (the first PO for a brand-new SKU), there's nothing to select
  from yet - a note explains the standard will be set at Approval and carried
  forward automatically to future POs of this SKU. Tested this exact
  hand-off: created PO1 for a new SKU (no fit yet), simulated Approval
  establishing a fit, then created PO2 for the same SKU and confirmed the fit
  and its sizes copied over automatically.

Submitting creates the PO record and shows a shareable link (with a copy
button) that opens QA/QC Approval for that PO - this is the link that gets
shared with whoever owns that part of the process.

### Still to come

Phase 2 (Pre-Production/Bulk Sampling Reporting updates: pre-fill from the PO
+ Approval data, SKU-based history instead of PO-based, Issues step rewording,
removing the Final Approval Photos step), Phase 3 (the full QA/QC Approval
workflow), Phase 4 (Reports), and the multi-photo/camera-roll fix are all not
built yet.

---

## Phase 2 + 3: QA/QC Approval, and Reporting now built on top of it

### QA/QC Approval (new)

A full new workflow at `approval.html`, for the China QA team to share reference
photos with Product Development for sign-off:

- **Sample Approval** - enter a PO Number (or arrive via a New PO's share link,
  which jumps straight here), fill in Factory Code / QA Lead / Product Risk /
  Sizing, upload the category-specific photo set (Plush, Apparel, Book -
  mapped to the Notebook/Sketchbook subcategory - or a general default set),
  add notes. If a SKU already has a completed Sample Approval from an earlier
  PO, it shows up as a reference with a one-click "Copy From Prior PO" -
  tested this exact PO2 scenario end-to-end.
- **Pre-Production Approval** / **Bulk Approval** - same PO-entry pattern,
  shows the Sample Approval photos as reference, uploads its own photo set
  (per-size for apparel - Front+Back for each size in the PO), links to the
  matching Reporting-side report once one exists.
- Every submitted stage gets a **Product Development comment box** - text +
  optional photos, timestamped and attributed to whoever left it.
- Crucially: submitting a Sample Approval with an apparel sizing standard now
  writes that standard back onto the PO record, which is what lets it copy
  forward automatically to PO2, PO3, etc. of the same SKU (this took a real
  bug fix to get right during testing - the initial version updated the
  Approval data but never wrote it back to the PO record, so nothing carried
  forward).

### QA/QC Reporting - restructured around POs and Approval data

- **Category selection is gone as its own step.** Pre-Production/Bulk
  Sampling Reporting now start with a **PO Lookup** step - enter the PO
  Number, and Category, Subcategory, SKU, Creator, PO Quantity, sizes
  included, Factory Code, Product Risk, and the sizing standard all pull in
  automatically from the PO record and Sample Approval.
- **Order Info is now pre-filled** (still editable) with only QA Lead and
  Quantity Checked genuinely entered fresh, grouped together as their own
  section.
- **Prior report history is now SKU-based, not PO-based** - it follows a
  product across PO2, PO3, etc., not just one specific PO.
- **Product Development's Approval-side comments now show up directly** in
  the Reporting flow's Order Info step, so factory QA staff see PD's feedback
  without needing to go dig through Approval separately.
- **Final Approval Photos is gone** as a step, and removed from the generated
  PDF too (it would have always been empty now that the step doesn't exist).
- **Apparel sizing is now scoped to the PO** - only the sizes actually
  included in that specific PO show up in the measurement chart, not every
  size the standard defines.
- **Issues step reworded** - renamed "Tolerance & Placement Issues" to "Other
  Issues" and broadened the description (not limited to tolerance/placement
  anymore), plus a clear classification guide: Minor stays within tolerance
  and gets accepted, Major is outside tolerance and gets rejected back to the
  factory to fix, Critical means the whole batch has the issue and gets
  rejected and redone.

Every piece above was tested end-to-end against the real running server: PO
creation, Sample Approval with a real photo, a PD comment, then a
Pre-Production report reading all of that back and pre-filling correctly, the
SKU-based history picking it up, and the generated PDF confirmed correct on
both counts (no Final Approval Photos section, "Other Issues" wording).

### Still outstanding

Reports (Phase 4 - SKU lookup with a consolidated download combining
Reporting + Approval + PD comments) and the multi-photo/camera-roll upload fix
are not built yet.

---

## Approval UX overhaul, Phase 4 (Reports), and the camera fix

### Fixed: Sample Approval photos not showing up after submission

This was a real bug, not a display quirk - the "Submitted" screen only ever
showed a checkmark and a PD comment box, never the photos that were actually
uploaded. Rebuilt this screen entirely; confirmed via a live test against the
running server that the photos now render, large and aligned, with a
click-to-enlarge lightbox (works everywhere photos show up now, not just here).

### Side-by-side comparison for Pre-Production / Bulk Approval

Reviewing Pre-Production or Bulk Approval now shows the Approved Sample photo
next to that stage's own photo for the same slot, side by side, large - for
apparel, this is per-size (each size's Front/Back next to the Sample's
Front/Back).

### The Approval review page now has three sections, per PO's request

In this order, all on the same screen once a stage is submitted:
1. **Approved Sample Photos** (or the comparison, for Pre-Production/Bulk)
2. **Current Production Notes** - the free-text notes field from every stage
   submitted so far (Sample, Pre-Production, Bulk), not just the current one
3. **Previous PO Issues** - the same SKU-based Reporting history/issue detail
   used in the Reporting flow, now visible here too

Product Development's comment box sits below all three, now with an
**Approval** dropdown (Approved / Approved with Comments / Not Approved)
alongside the comment text, and the button is now "Submit" instead of "Add
Comment." The approval decision shows as a badge on each past comment.

### Phase 4: Reports

New working page at `reports.html` - enter a SKU, see every PO under it, and
download a **consolidated report** per PO: order info, every completed
Approval stage (photos, notes, PD comments with their decision), and a
summary of every Reporting-side inspection for that PO with a clickable link
to each one's full report. Tested end-to-end with a real PO spanning Sample
Approval (with a photo and a PD comment) and a Pre-Production inspection
report with a logged issue - confirmed everything renders correctly in one
PDF, including the link back to the original report actually resolving to a
real file.

### Camera roll fix

Found the cause: the Reporting flow's photo input had `capture="environment"`
set, which on many mobile browsers (iOS Safari especially) removes the "Photo
Library" option from the picker, leaving only "Take Photo." Removed it -
`multiple` was already in place, so this restores full camera-roll,
multi-select access. Confirmed no other instance of this anywhere in the app.

---

## Reporting Step 3 ("Production Notes") and Reports rewritten as one true document

### New Reporting wizard step

Pre-Production/Bulk Sampling Reporting now has 7 steps instead of 6 - a new
Step 3 sits between Order Info and Inspection Details:

- **Reference Images** - the actual Approved Sample (and Pre-Production, once
  it exists) photos, large with click-to-enlarge (added the same lightbox
  approval.html already had, now in the Reporting wizard too).
- **Production Notes** - Approved Sample Notes and Pre-Production Sample
  Notes, each showing both the free-text notes entered at that stage AND
  Product Development's comments on it, color-coded the same way as
  everywhere else. Pre-Production's section links straight to that
  inspection's own report once one's been filed.
- **Previous Production Issues** - every issue found on every prior report
  for this SKU (not just the latest one), each with a working download link.

Order Info no longer shows any of this - it's just the pre-filled order
details plus QA Lead / Quantity Checked now.

Tested end-to-end with a real PO carrying Sample Approval notes, a PD
comment, and a filed Pre-Production report with a logged issue - confirmed
every piece shows up correctly, color-coded right, and the wizard still
flows correctly through all 7 renumbered steps afterward.

### Reports: genuinely one document now, not links

Rewrote the consolidated report generator to actually merge real PDF pages
together (using `pdf-lib`) instead of drawing summaries with links out to
separate files. The final PDF is laid out as:

1. Order Information + Performance (quantity checked/approved/rejected,
   pulled from whichever reports have been filed)
2. Sample Approval (info, notes, PD comments, photos)
3. Pre-Production Approval (photos, notes, PD comments) immediately followed
   by the **actual, full** Pre-Production inspection report - the complete
   checklist detail, sizing charts, everything - not a summary
4. Bulk Approval, followed by the actual, full Bulk inspection report the
   same way

Verified this with a complete real scenario spanning all three approval
stages and both report types - confirmed the merged PDF genuinely contains
the full original inspection report pages (PASS banner, full checklist,
Recap, all of it) inline, not a link. One minor known cosmetic detail: each
merged section keeps its own "Page X of Y" footer from when it was generated,
rather than one continuous page count across the whole document - doesn't
affect the content, just how the page-count label reads.

---

## QA/QC Approval polish + wider desktop layout

- **Title fixed** - "Product Development Approval" now shows consistently
  across the Approval entry screens.
- **"Copy From Prior PO" now copies sizing too** - found a real gap where
  only the apparel fit was being copied over, not the general sizing notes
  used by non-apparel categories. Both now carry forward correctly.
- **"Submit Photos"** - the Approval stage's submit button now has its own
  label, separate from the Reporting flow's "Submit Report" button (they
  used to share one i18n key).
- **Reordered and clearly separated** - the submitted-stage view is now
  Images → Notes → Product Development Approval (comment + approval status),
  followed by a visible divider, then Previous PO Issues at the very bottom.
- **Saved comments now say what they're approving** - "Sample Approval,"
  "PP Sample Approval," or "Bulk Sample Approval" shows right on the card,
  so it's clear which stage a given comment belongs to at a glance.
- **Back to one unified flow** - removed the China-team/PD-team split
  entirely. Visiting Approval now goes straight to PO entry; the page itself
  (upload form vs. submitted review) makes clear what's happening without
  needing a separate access path.
- **Wider desktop layout** - above 900px viewport width, the app now uses up
  to 1180px instead of the mobile-optimized 720px, and the photo comparison
  columns stop wrapping - so Bulk Approval's 3-way side-by-side comparison
  actually sits side by side instead of stacking.

Every change here was verified directly against the rendered HTML output
(including the exact section ordering and the stage-labeled comment display),
not just code review.
