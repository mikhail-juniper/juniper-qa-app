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

