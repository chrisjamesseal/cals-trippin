# Cal's Trippin'

One place for your group trip — flights, money, plans and photos. One organiser starts the trip, everyone else gets a link — and now everyone can pitch in.

**Live app:** https://chrisjamesseal.github.io/cals-trippin/

## How it works

- **No accounts.** You start a trip and share one link. Anyone with the link can open it on any device — no sign-up.
- **Collaborative editing (Milestone 2).** With the shared store switched on (see below), the link is **permanent** and everyone with it can edit — flights, notes, documents, receipts and the mood board — and see each other's changes. Each person picks their name once, so the **edit log** can show who changed what and when (the **Log** tab).
- **Receipt scanning + splitting.** Snap a photo of a receipt — or upload an existing image from your library — and it's read in your browser into a list of items. Tick who had each item and the app works out what's left to assign and what each person owes. No manual maths, no server upload — the scan happens on your device.
- **Travel** — Flights, Ferries and Car Hire in one place. Flights offer airline and airport autocomplete (code shown large, airport name in grey), tick-boxes for what's included with the ticket (cabin/checked bag, priority…), a link to live flight status, and you can attach the boarding pass or any document to each item.
- **Accommodation** — add as many stays as the trip needs (hotel, Airbnb, a friend's sofa…), each with an address (with a one-tap Google Maps link), check-in/check-out date and time, a booking reference and a link to the listing.
- **Itinerary** — the full day-by-day schedule: your flights and accommodation check-in/check-out appear here automatically alongside the stops you add by hand (a place, a time or just a morning/afternoon/evening slot, and a note on why it's worth it). Give a stop a location to pin it on an embedded Google Map, and add a photo. Ideas pins carry their image and location straight in.
- **Documents** — the app is a hub: upload booking confirmations, tickets and insurance PDFs/photos so everyone can open them from one place, and link out to things that live in other apps (airline app, check-in page).
- **Structured notes** — emergency contacts and general trip info (visas, packing list, house rules…).
- **Money splitter** — receipts with itemised line-by-line splitting or an even-split toggle, plus a who-pays-whom settlement that combines debts into the fewest possible payments (Tricount-style). Your own balance shows right on the dashboard's Money tile.
- **Photos** — links out to one shared album everyone adds to. **PhotoCircle** is recommended (free, cross-platform, and everyone — iPhone, Android or web — can *add* photos, not just view); Apple Shared Album / Google Photos links also work if you already use them, with in-app notes on each one's limitations.
- **Mood board** — pin links, notes and images; built-in destination-based idea suggestions.
- **Auto-archiving** — trips grey out and become read-only one month after the end date.
- **Your trips are kept** — trips are saved in the browser and survive app updates. Use **Back up trips** on the home screen to download all your trips as a file and **Restore** them in any other browser or on a new phone (no account needed). With the shared store configured, trips also sync to anyone holding the link.

## Turning on the shared, permanent link (Firebase)

The app works out of the box **on a single device** with no setup. To get the one-permanent-link-that-everyone-edits behaviour, connect a free [Firebase](https://firebase.google.com/) Realtime Database:

1. Create a free Firebase project and add a **Realtime Database**.
2. In Project settings → *Your apps* → *Web*, copy the config object.
3. Paste it into `FIREBASE_CONFIG` near the top of the `<script>` in `index.html` (these are public client keys — safe to commit).
4. Set the database rules. Access is by unguessable trip link (no logins), so for a friends-only trip planner:

   ```json
   {
     "rules": {
       "trips": {
         "$id": { ".read": true, ".write": true }
       }
     }
   }
   ```

That's it — share buttons now hand out `…/#/trip/<id>` links that stay the same forever and sync everyone's edits. Without a config, the app quietly falls back to single-device mode and the Share button produces a portable snapshot link instead.

The header shows a small **sync status** pill (Synced / Saving… / Offline / On this device) so you always know where your changes are.

## Notes

- Static site, no backend of its own — hosted on GitHub Pages. The optional shared store is Firebase, called directly from the browser.
- **Security is deliberately light:** anyone with a trip link can view and edit it. Keep links to your group.
- Large uploaded files and mood-board images stay on the uploader's device (only smaller ones sync); their details still appear for everyone.
- Receipt/PDF scanning accuracy varies with the photo — it's a review-and-correct flow, not magic.

Inside a trip, everything is reached from the **dashboard tiles** or the **☰ Menu**, each with its own icon: Overview, Travel (flights, ferries, car hire), Accommodation, Itinerary, Money, Photos, Ideas, Emergency Contacts, Documents, Notes and Activity — no horizontal tab scrolling. Countries and people are managed from **Edit Trip** on the Overview.

Built from the v1 product spec (`cals_trippin_spec.md`); this release adds **Milestone 2 (collaborative editing + edit log)**, in-browser receipt scanning, and a branded UI refresh (teal/coral palette, "Cal's Trippin'" wordmark, icon menu navigation).
