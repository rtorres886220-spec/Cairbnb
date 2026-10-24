# CairBnB — San Diego host growth & cleaning operations

A simple, browser-based lead tracker for independent short-term-rental cleaning teams.

## Run it

Run the app through a local web server (double-clicking the HTML files will break module loading and password setup):

```sh
python3 -m http.server 8080 --bind 127.0.0.1
```

Then visit `http://localhost:8080`. The password setup requires localhost or HTTPS.

## Import the City list

Choose **Import public leads** to try the City of San Diego CSV. Some browsers block cross-origin downloads; if that happens, download the **Active licenses** CSV from [the City’s STRO open data page](https://data.sandiego.gov/datasets/stro-licenses/) and choose the file when prompted.

Lead records are stored locally in browser IndexedDB, with migration from the earlier local-storage format. Operations records remain in local browser storage. No leads or operations records are sent to a server by this static prototype. Export creates a CSV on your device.

## Current scope

- Filter by neighborhood, license tier, status, and search text.
- Review public contact and license details, open the property in Maps/profile, and edit a suggested first note.
- Open a prepared message in the device's email or text app when the CSV contains an email address or phone number.
- Track new, contacted, replied, won, and not-a-fit leads, plus notes and follow-up dates.
- Import and merge City CSV updates by license ID; export the tracked lead list.

## Cleaning operations

Open `operations.html` for the operations workspace. It includes local turnover scheduling, .ics file import, property-specific access details and checklists, crew assignment, job status, photo proof, damage notes, supply inventory, a unit inbox preview with owner escalations, invoice tracking, payroll export, and a basic operating profit view. Data is stored in the browser on this device.

The unit inbox is a local interaction prototype: it stores conversations on this device and uses deterministic keyword rules to preview routine replies and owner escalations. It is not a live AI service, shared chat, or SMS/email delivery. The app is not a deployed multi-user SaaS. Cleaner/client accounts and permissions, shared real-time messages, an AI provider, scheduled digests, cloud backup, payment processing, and automated payroll need a secure backend and external service connections.

For lead outreach, contact details should be checked and messages personalized. Email/text actions open a draft in the user's own app; they do not automatically send or bulk-message anyone. No email or text provider credentials are configured. City license records identify active STROs; they do not show whether a host is seeking a cleaner.


Both app entry points include the same custom local password gate; the operations workspace also has a collapsible sidebar. The password check is browser-side only and is not production authentication. The `_headers` file adds static-response security headers on Cloudflare Pages. Before putting the app on a public domain, configure Cloudflare Access for the app hostname and its `pages.dev` preview; see [SECURITY.md](SECURITY.md).
