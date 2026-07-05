# Cal's Trippin'

One place for your group trip — flights, money, plans and photos. One organiser runs the trip, everyone else gets a link.

**Live app:** https://chrisjamesseal.github.io/cals-trippin/

## How it works

- **No accounts.** Trip data lives in the organiser's browser (localStorage). The Share button generates an invite link containing a compressed read-only snapshot of the trip — participants just open it, on any device.
- **Documents** — upload boarding passes/e-tickets (PDF or photo). Text-based PDFs are scanned client-side (pdf.js) and flight details pre-fill the Flights section for confirmation.
- **Structured notes** — flights, accommodation, emergency contacts, general info.
- **Money splitter** — receipts with itemised line-by-line splitting or an even-split toggle, plus who-pays-whom settlement.
- **Photos** — links out to an Apple Shared Album or Google Photos album, with setup tutorials.
- **Mood board** — pin links, notes and images; built-in destination-based idea suggestions.
- **Auto-archiving** — trips grey out and become read-only one month after the end date.

## Notes

- Static site, no backend — hosted on GitHub Pages.
- Uploaded files and mood-board images stay on the organiser's device; they aren't embedded in share links.
- After editing a trip, share a fresh link to update participants.

Built from the v1 product spec (see `cals_trippin_spec.md` in the project).
