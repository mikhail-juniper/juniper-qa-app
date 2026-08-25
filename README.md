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
