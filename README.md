# My Trips

One place for your group trip, flights, money, plans and photos. One organiser starts the trip, everyone else gets a link, and now everyone can pitch in.

**Live app:** https://chrisjamesseal.github.io/cals-trippin/

## How it works

- **No accounts.** You start a trip and share one link. Anyone with the link can open it on any device, no sign-up.
- **Collaborative editing (Milestone 2).** With the shared store switched on (see below), the link is **permanent** and everyone with it can edit: flights, notes, documents, receipts and the mood board, and see each other's changes. Each person picks their name once, so the **edit log** can show who changed what and when (the **Log** tab).
- **Receipt splitting.** Add a receipt as an even split or item-by-item, tick who had each item, and the app works out what's left to assign and what each person owes. No manual maths.
- **Travel:** Flights, Ferries and Car Hire in one place. Flights offer airline and airport autocomplete (code shown large, airport name in grey), tick-boxes for what's included with the ticket (cabin/checked bag, priority…), a link to live flight status, and you can attach the boarding pass or any document to each item.
- **Accommodation:** add as many stays as the trip needs (hotel, Airbnb, a friend's sofa…), each with an address (with a one-tap Google Maps link), check-in/check-out date and time, a booking reference and a link to the listing.
- **Itinerary:** the full day-by-day schedule: your flights and accommodation check-in/check-out appear here automatically alongside the stops you add by hand (a place, a time or just a morning/afternoon/evening slot, and a note on why it's worth it). Give a stop a location to pin it on an embedded Google Map, and add a photo. Ideas pins carry their image and location straight in.
- **Weather on the itinerary:** each day shows its forecast (high/low, conditions and chance of rain) from [Open-Meteo](https://open-meteo.com/), which is free and needs no API key or sign-up. Forecasts only run about two weeks ahead, so days beyond that show nothing rather than a guess. It defaults to the trip's country; use **Change** at the top of the Itinerary to pin it to the town you're actually staying in. If the forecast can't be reached the itinerary is unaffected, it just doesn't show weather.
- **Documents:** the app is a hub: upload booking confirmations, tickets and insurance PDFs/photos so everyone can open them from one place, and link out to things that live in other apps (airline app, check-in page).
- **Structured notes:** emergency contacts and general trip info (visas, packing list, house rules…).
- **Money splitter:** receipts with itemised line-by-line splitting or an even-split toggle, plus a who-pays-whom settlement that combines debts into the fewest possible payments (Tricount-style). Your own balance shows right on the dashboard's Money tile.
- **Photos:** links out to one shared album everyone adds to. **PhotoCircle** is recommended (free, cross-platform, and everyone, iPhone, Android or web, can *add* photos, not just view); Apple Shared Album / Google Photos links also work if you already use them, with in-app notes on each one's limitations.
- **Mood board:** pin links, notes and images; built-in destination-based idea suggestions.
- **Places I've Been:** a card on the home page (and the icon next to the logo) opens a region picker: an "All" card plus Europe, Asia, Africa, North America, South America and Oceania, each showing how many of its countries you've ticked off. Tick Been or Want to Go for any country; any country on an active trip's itinerary shows as Been automatically, no need to tick it yourself. Filter the whole page down to just Been or Want to Go, with a live count next to each filter. Each country shows its capital, language and a "Search Flights" link out to Google Flights. Includes England, Scotland, Wales and Northern Ireland as their own entries, not lumped into a single United Kingdom.
- **Auto-archiving:** trips grey out and become read-only one month after the end date.
- **Your trips are kept:** trips are saved in the browser and survive app updates. Use **Back up trips** on the home screen to download all your trips as a file and **Restore** them in any other browser or on a new phone (no account needed). With the shared store configured, trips also sync to anyone holding the link.

## Turning on the shared, permanent link (Firebase)

The app works out of the box **on a single device** with no setup. To get everyone-sees-every-trip syncing plus the shared PIN gate, connect a free [Firebase](https://firebase.google.com/) Realtime Database:

1. Create a free Firebase project and add a **Realtime Database**.
2. In Project settings → *Your apps* → *Web*, copy the config object.
3. Paste it into `FIREBASE_CONFIG` near the top of the `<script>` in `index.html` (these are public client keys, safe to commit).
4. Set the database rules. Access is gated by a shared PIN (no per-user logins), so for a friends-only trip planner:

   ```json
   {
     "rules": {
       "trips": {
         ".read": true,
         "$id": { ".write": true }
       },
       "appPin": { ".read": true, ".write": true },
       "places": { ".read": true, ".write": true }
     }
   }
   ```

   Note the `trips` node needs its own top-level `.read: true`, Realtime Database rules don't cascade upward from `trips/$id` to `trips`, and the app needs to read the *whole* `trips` node at once to list every trip on the "Your Trips" page. Without it, the app silently falls back to only showing trips this particular browser already knows about (looks like "no trips saved"), and the in-app PIN-change screen will fail to save. The same non-cascading rule applies to `places`, the shared Places I've Been checklist: without it, ticked countries stay stuck on the device that ticked them instead of syncing to the group.

That's it, the app now shows every trip that exists (not just ones this browser made), and share buttons hand out `…/#/trip/<id>` links that stay the same forever and sync everyone's edits. Without a config, the app quietly falls back to single-device mode, a fixed local PIN, and the Share button produces a portable snapshot link instead.

## Notes

- Static site, no backend of its own, hosted on GitHub Pages. The optional shared store is Firebase, called directly from the browser.
- **Security is deliberately light:** the PIN gate is a client-side deterrent, not real access control, anyone who reads the page source can find it. It stops casual visitors, not a determined stranger. Keep the URL and PIN to your group.
- Large uploaded files and mood-board images stay on the uploader's device (only smaller ones sync); their details still appear for everyone.

Inside a trip, everything is reached from the **dashboard tiles** or the **☰ Menu**, each with its own icon: Overview, Travel (flights, ferries, car hire), Accommodation, Itinerary, Money, Photos, Ideas, Emergency Contacts, Documents, Notes and Activity: no horizontal tab scrolling. Countries and people are managed from **Edit Trip** on the Overview.

Built from the v1 product spec (`cals_trippin_spec.md`); this release adds **Milestone 2 (collaborative editing + edit log)** and a branded UI refresh (teal/coral palette, "My Trips" wordmark, icon menu navigation).
