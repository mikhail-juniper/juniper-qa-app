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

- **`config/fits.json`** — All standard measurements are set to `0` right now
  (meaning "not flagging" in test mode). Once you have real approved measurements per
  size/fit, fill those in and the tolerance flagging will use real numbers. This file
  is plain JSON, so anyone on your team can edit it directly, no code needed. Comments
  at the top of the file explain the format.
- **Brand colors** — I used a placeholder dark green. Let me know your actual brand hex
  codes and I'll swap them in (`lib/pdfBuilder.js` → `BRAND` object, and
  `public/styles.css` → `:root` variables).
- **Logo** — Currently just a "JC" monogram placeholder in the header. Send over your
  logo file and I'll drop it in.
- **Chinese translations** — in `config/i18n.json`, one line per label. Easy to edit
  directly if anything needs correcting.

## Next step: China hosting + real email

Once the workflow is confirmed, the remaining pieces to go live are:

1. **Hosting**: deploy this Node.js app somewhere reachable from mainland China without
   a VPN — e.g. Alibaba Cloud, Tencent Cloud, or a Hong Kong/Singapore-based host. The
   app itself doesn't depend on any Google services, so this is a standard Node
   deployment.
2. **Email**: since Gmail/Google Workspace SMTP isn't reliable from China, we'll use a
   China-friendly provider (Alibaba Cloud DirectMail, Tencent Cloud SES) or a global
   provider like SendGrid — the important part is that the *app server* (not your
   phone) is what talks to the email provider, so it just needs the server to be
   hosted somewhere with good connectivity.
3. Turn off Test Mode by setting the `SMTP_*` variables in `.env` (see `.env.example`)
   — once those are set, real submissions will email the PDF instead of just saving it
   locally.

I'm happy to help with either of those once you're ready.
