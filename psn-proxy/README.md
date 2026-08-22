# Proxy (for the Games, News, Music, Films tabs and Home's Made Today/This Week card)

> A handful of endpoints live here, all for the same reason: a browser can't make these calls
> itself. `/session`, `/refresh` and `/titles` for PlayStation, `/design-news` `/film-news`
> `/music-news` for the News tab's RSS (three categories, merged into one feed client-side),
> `/spotify-search` plus the `/spotify-login-url` `/spotify-callback`
> `/spotify-refresh` `/spotify-me` `/spotify-top-tracks` group for Music's artist search, Artists
> checklist and Songs tab, `/letterboxd-diary` for Films' Letterboxd sync, and
> `/branch-earnings` for Home's Made Today/This Week card. Deploying this once turns all of them
> on. (Board Games and the Games tab's Wishlist aren't here - see "Connect BoardGameGeek" and
> "Connect RAWG" below for where those actually live and their own one-time setup.)

The Games tab shows your PlayStation trophy progress. PlayStation has no official public API,
and the unofficial one needs an auth step a browser can't make itself (it has to send a
`Cookie` header to Sony that `fetch()` refuses to set cross-origin, and Sony's trophy API
doesn't send back the CORS headers a browser needs either). So this one small piece needs a
real server in front of it - this folder is that server, as a [Cloudflare Worker](https://workers.cloudflare.com/)
(free tier is plenty for one person's trophy checks).

It's a stateless relay: your NPSSO code and the tokens it becomes pass through it but aren't
stored by it. Your login token itself only ever lives in your own browser's `localStorage`,
never committed anywhere.

The News tab's three endpoints live in this same worker (see `worker.js`) rather than a separate
deployment - most RSS feeds have the same CORS problem the PSN API does, and it's the same fix,
so they didn't need their own Cloudflare project. `/design-news` covers a handful of UX/design
publications, `/film-news` covers Variety and The Hollywood Reporter's Film/Movies verticals plus
IndieWire (cinema culture and criticism) and What's on Netflix (new streaming releases), and
`/music-news` covers Resident Advisor, DJ Mag and Spotify Newsroom - all three share the exact
same fetch/parse/cache machinery (`fetchNewsFeeds` in `worker.js`), fetched and merged into one
feed client-side rather than three separate tabs. They're public and identical for everyone (no
login, no per-device state - your own thumbs up/down preferences stay local to your device), and
each cached for 30 minutes so a visit isn't re-fetching eight feeds every time. Deploying the
worker below turns all three on at once. Every feed is fetched independently, so one publication's
RSS (or one whole category) being down doesn't take out the rest of the merged feed.

Before articles reach the app, `fetchNewsFeeds` also sorts them newest-first by date (checking
`pubDate`, `updated`, `published` and `dc:date` in turn, since not every feed uses the same tag)
and drops articles that read as not-English (`looksNonEnglish`, a non-ASCII character ratio check
- it catches non-Latin scripts like Cyrillic or CJK but can't tell French or German from English,
both being Latin-alphabet; this one applies to all three categories). Design additionally drops
anything about a named city other than London (`looksOffLocation`, a fixed city-name keyword list
- an article naming London anywhere always survives, and one naming no city at all always survives
untouched) - Film and Music skip this one (`fetchNewsFeeds`' `filterLocation` argument, `true` only
for `fetchDesignNews`), since Variety/Hollywood Reporter are LA-centric by nature and Resident
Advisor/DJ Mag cover Berlin/Ibiza/Amsterdam as core dance-music territory rather than "somewhere
irrelevant" - a London-only filter there was dropping nearly every article in both categories.
Both filters are cheap heuristics, not real language detection or geocoding - see each function's
comment in `worker.js` for exactly what they will and won't catch. Image extraction
(`extractFeedImage`) also falls back through `data-src`/`data-original`/`srcset` before `src`,
since some publications (DJ Mag among them) lazy-load images with a blank placeholder in `src` and
the real URL only in one of those attributes.

## Deploy it

1. Install the Cloudflare CLI once: `npm install -g wrangler`
2. From this folder: `wrangler login` (opens a browser to connect your free Cloudflare account)
3. `wrangler deploy`
4. Wrangler prints a URL like `https://cals-trippin-psn-proxy.<you>.workers.dev` - that's your proxy.
5. Paste that URL into `PSN_PROXY_URL` near the top of `../index.html`'s `<script>` (same spot
   as the Firebase config). It's just an address, safe to commit.

Optionally lock the proxy to your app's origin instead of accepting requests from anywhere:
uncomment the `[vars]` block in `wrangler.toml`, set `ALLOWED_ORIGIN` to your app's URL, and
run `wrangler deploy` again.

## Connect your account

The Games tab walks you through this, but in short:

1. While signed in to PlayStation in your browser, open
   [ca.account.sony.com/api/v1/ssocookie](https://ca.account.sony.com/api/v1/ssocookie) and
   copy the `npsso` value from the page.
2. Paste it into the Games tab's Connect box. The app sends it to your proxy once, your proxy
   exchanges it with Sony for a login token, and that's what gets saved on your device from
   then on (the NPSSO code itself is short-lived and isn't kept).

If a game you're mid-playthrough on doesn't show up, or Connect fails outright, see
"If it breaks" below before assuming something's wrong with your account.

## Connect BoardGameGeek (for Board Games)

Board Games talks to [BoardGameGeek](https://boardgamegeek.com/wiki/page/BGG_XML_API2)'s XML
API through `api/board-games.js`, a Vercel Edge Function that ships and deploys with the app
itself (same repo, same `git push`, no separate deploy step) - but BGG now requires every
request to carry a registered application's token, so it does need one piece of setup:

1. Register at [boardgamegeek.com/using_the_xml_api](https://boardgamegeek.com/using_the_xml_api)
   to get a free application token (a `Authorization: Bearer <token>` header BGG asks every XML
   API caller to send now, not something specific to this app).
2. Set it as an environment variable on the Vercel project (**not** in `api/board-games.js` or
   anywhere else in this repo, the same reasoning as Spotify's credentials below - it's tied to
   your own BGG account): Vercel dashboard → your project → Settings → Environment Variables →
   add `BGG_API_TOKEN` with the token as its value → redeploy (or just push again) for it to
   take effect.

## Connect RAWG (for the Games Wishlist)

The Games tab's Wishlist - search for a new or upcoming game (GTA VI, say) and save it to a
list - talks to [RAWG](https://rawg.io/apidocs) through `api/game-search.js`, another Vercel
Edge Function alongside `api/board-games.js` (same repo, same `git push`, no separate deploy).
RAWG's free tier just needs a key, no OAuth dance:

1. Sign up at [rawg.io/apidocs](https://rawg.io/apidocs) for a free API key (no credit card).
2. Set it as an environment variable on the Vercel project (**not** in `api/game-search.js` or
   anywhere else in this repo, tied to your own RAWG account the same as the other keys here):
   Vercel dashboard → your project → Settings → Environment Variables → add `RAWG_API_KEY` with
   the key as its value → redeploy (or just push again) for it to take effect.

The Wishlist itself (which games you've saved) stays on-device in `localStorage`, the same way
Board Games' Want to Play/Played marks do - no account, nothing synced.

## Connect TMDb (for film search and UK streaming availability)

Logging a film works without any of this - title/year/date/rating can always be typed by hand -
but the Log Film and Watchlist forms' title fields can search a real catalogue (with posters)
instead, so you don't have to remember exact spelling or release years. The same endpoint also
backfills posters after a Letterboxd CSV import (that export has no poster field at all) and
after a Letterboxd sync that comes back missing one. It talks to
[TMDb](https://www.themoviedb.org/documentation/api) through `api/film-search.js`, another
Vercel Edge Function alongside `api/board-games.js` and `api/game-search.js` (same repo, same
`git push`, no separate deploy). TMDb's free tier just needs a key, no OAuth dance:

1. Sign up at [themoviedb.org](https://www.themoviedb.org/signup) and request a free API key at
   [Settings → API](https://www.themoviedb.org/settings/api) (the "API Key (v3 auth)" one, not
   the longer read-access token).
2. Set it as an environment variable on the Vercel project (**not** in `api/film-search.js` or
   anywhere else in this repo, tied to your own TMDb account the same as the other keys here):
   Vercel dashboard → your project → Settings → Environment Variables → add `TMDB_API_KEY` with
   the key as its value → redeploy (or just push again) for it to take effect.

The same key also powers the UK streaming-availability logos under Home's Watch Next widget and
each Watchlist card (`api/film-providers.js`, sourced from TMDb's own watch-providers data,
which in turn comes from JustWatch - shown alongside a "via JustWatch" credit as their terms for
that specific endpoint require). No separate setup - if film search already works, this does
too.

## Connect Spotify (for Music)

Logging a gig works without any of this - artist name/venue/date/notes can always be typed by
hand - but Spotify gives you three things on top of that, all needing you to log in and approve
access since it's your personal library data, not the public catalogue: a live artist search
with a photo (this one part is public, no login needed), the Artists checklist (every artist you
follow ranked by how much you actually listen to them), and the Songs tab (your top tracks).

1. Create an app at [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard).
2. Add a **Redirect URI** in that app's settings, byte-for-byte the same as `SPOTIFY_REDIRECT_URI`
   near the top of the Spotify section in `worker.js` (defaults to this app's own address -
   `https://cals-trippin.vercel.app/` - change the constant first if you've deployed the app
   somewhere else, then make the dashboard entry match it, not the other way round).
3. Copy the app's Client ID and Client Secret.
4. Set them as secrets on the deployed worker, **not** in `worker.js` or anywhere else in this
   repo - unlike PSN's `CLIENT_ID`/`CLIENT_SECRET` below (a long-published, account-agnostic
   value the community's reverse-engineered), a Spotify app's credentials are tied to your own
   developer account, and this repo is public:
   ```
   wrangler secret put SPOTIFY_CLIENT_ID
   wrangler secret put SPOTIFY_CLIENT_SECRET
   ```
   (or the Cloudflare dashboard: your worker → Settings → Variables and Secrets)
5. In Music's Artists tab, tap **Connect Spotify** and approve access. Only the artist search
   (step 1-4) is needed for the plain "add a gig" flow - the Artists checklist and Songs tab
   both need this step too.

## Connect Letterboxd (for Films)

Logging a film works without any of this - title/year/date/rating can always be typed by hand -
but if you keep a [Letterboxd](https://letterboxd.com/) diary, Films can pull it in instead of
you re-typing it. Letterboxd's own API is invite-only (you'd have to email them and hope for
approval), so this reads the same public diary RSS feed your profile page links to
(`letterboxd.com/<username>/rss/`) - your most recent entries (capped around 50 for a free
account), not your full watched history or watchlist, neither of which are exposed outside the
closed API.

This is the one feature on this whole page that needs **no setup at all** - no key, no secret, no
account, nothing to register. It's a public feed, so `/letterboxd-diary` just fetches and reduces
it to JSON. If you deployed this worker for Games/Design/Music already, Films' Letterboxd sync is
already live; if not, deploying it (see "Deploy it" above) turns this on along with everything
else. In the Films tab, tap **Connect Letterboxd** and enter your username (the one in your
profile URL, not your display name).

## Connect Branch (for Home's Made Today/This Week card)

Home's top card shows two figures: what you've made today (every invoice line item logged in
[Branch](https://github.com/chrisjamesseal/branch), a separate CRM app, between 07:00 and 23:30
that day) and what you've made this week (Monday 00:00 through now) - each with a pro-rated
day's pay from a separate 9-to-5 job added on top for every weekday that's started (annual
salary ÷ 260 working days). Tap the card to see both breakdowns.

Unlike everything else on this page, there's no in-app "Connect" step - Branch's data lives in
its own Supabase project, and Supabase's row-level security means reading it needs a privileged
key that only ever touches this Worker, never the browser:

1. In Branch's Supabase project dashboard: **Settings → API**. Copy the **Project URL** and the
   **service_role** key (not the `anon` one - the service key bypasses row-level security,
   which is exactly what's needed here since this Worker has no logged-in Supabase session of
   its own).
2. Set them as secrets on the deployed worker, **not** in `worker.js` or anywhere else in this
   repo - same reasoning as Spotify's credentials above, except more so: the service_role key
   has full read/write access to every table in that Supabase project.
   ```
   wrangler secret put BRANCH_SUPABASE_URL
   wrangler secret put BRANCH_SUPABASE_SERVICE_KEY
   ```
3. Optional: to include the weekday 9-to-5 pay figure, also set your annual salary (a plain
   number, no currency symbol or commas):
   ```
   wrangler secret put BRANCH_ANNUAL_SALARY
   ```
   Leaving this unset just means the card only ever shows the line-items totals, every day
   (weekday salary contributes £0 rather than erroring).
4. `wrangler deploy`. The card appears on Home on your next visit - no per-device login step,
   since (again unlike Games/Music) the Worker authenticates to Supabase itself rather than on
   your behalf.

**Worth doing at the same time:** every other endpoint on this Worker either needs no auth at
all (the RSS feeds) or is gated by a token proving who's asking (PSN/Spotify's bearer tokens).
`/branch-earnings` has neither - the service_role key above is what authorizes the
request, not the caller, so anyone who finds this Worker's URL and knows the route can otherwise
call it too. Uncomment and set `ALLOWED_ORIGIN` in `wrangler.toml` (see "Deploy it" above) before
or right after setting this up, so only your own deployed app's origin can reach it.

## If it breaks

Sony hasn't published this API and hasn't promised not to change it. `worker.js`'s
`CLIENT_ID`/`CLIENT_SECRET` are the values the community-maintained
[psn-api](https://github.com/achievements-app/psn-api) project has reverse-engineered for the
PlayStation App's OAuth client; if Connect starts failing where it used to work, check that
project's `src/authenticate/exchangeAccessCodeForAuthTokens.ts` (the hardcoded Basic-auth
header, base64-decoded) for current values before assuming your NPSSO code is bad. A "PlayStation
rejected the token request (status 401)" error specifically points at a stale `CLIENT_SECRET`.

If the News tab's Design category looks thin, one of the publications in `worker.js`'s
`DESIGN_FEEDS` list has likely moved or renamed its RSS URL - each feed is fetched independently,
so the rest still come through, but check the publication's site for its current feed link and
update that one entry. Films and Music work the same way - their sources live in `FILM_FEEDS` and
`MUSIC_FEEDS` right next to `DESIGN_FEEDS`, same fix if one looks thin.

If a whole category looks thinner than expected but no feed is actually failing, the language
filter is likely doing that on purpose - see `looksNonEnglish` above (the location filter only
ever applies to Design, so it can't be the cause for Film or Music). An article that's genuinely
English but keeps getting filtered is a language-filter false positive; a real gap in the
heuristic is a `worker.js` edit, not a config problem.

If an article's text shows literal HTML like `<p>` instead of being rendered as a paragraph
break, that feed is entity-escaping its own markup (`&lt;p&gt;` instead of a real `<p>` tag) -
`inlineRuns` in `worker.js` strips tags again after decoding entities specifically to catch this,
so if it's still happening the feed is doing something `inlineRuns`' second pass doesn't
recognise (an unusual tag name, or a genuinely malformed encoding) - check that article's raw feed
XML against what the function expects.

Board Games lives in `api/board-games.js`, not this Worker (see that file's top comment for why
it moved). If it says "isn't configured", the Vercel project is missing (or has a stale)
`BGG_API_TOKEN` environment variable - see "Connect BoardGameGeek" above. A raw "BoardGameGeek
returned 401" instead means the token itself is bad or expired - re-check it against BGG's own
registration page. That endpoint caches for six hours (an hour for searches).

The Wishlist lives in `api/game-search.js`, same setup as Board Games: if it says "isn't
configured", the Vercel project is missing (or has a stale) `RAWG_API_KEY` environment variable
- see "Connect RAWG" above.

If Music's artist search says "Spotify isn't connected yet", the worker is missing (or has a
stale) `SPOTIFY_CLIENT_ID`/`SPOTIFY_CLIENT_SECRET` secret - see "Connect Spotify" above. If
tapping **Connect Spotify** in the Artists tab sends you to Spotify and it complains the redirect
URI is invalid, `SPOTIFY_REDIRECT_URI` in `worker.js` doesn't byte-for-byte match a Redirect URI
in the Spotify app's dashboard settings (a trailing slash is enough of a mismatch to fail) -
fix whichever one is wrong so they agree, then redeploy the worker if you changed the constant.
The same login covers the Songs tab too, so a stale `SPOTIFY_REDIRECT_URI` or missing secret
shows up there the same way.

If Films' Letterboxd sync says it "couldn't sync" and specifically mentions "running an older
version", the deployed worker predates this route - redeploy it (`wrangler deploy` from this
folder, see "Deploy it" above); this is a genuinely separate step from the code merging into
`main`, easy to miss since every *other* change to the app ships automatically on `git push`. A
plain 404 that instead names the username means the username itself is wrong (it's the one in
your profile URL - `letterboxd.com/<username>/`, not your display name) or the profile doesn't
exist. Anything else (a plain "status 500" etc.) means Letterboxd's site is unreachable or
temporarily erroring - try again in a bit. Since there's no key or secret to expire here, if it
suddenly stops working the most likely cause is Letterboxd having changed their RSS feed's field
names - check `worker.js`'s `parseLetterboxdItems` against a fresh `letterboxd.com/<any
username>/rss/` response if entries start coming through blank or missing ratings.

Film search in the Log Film and Watchlist forms lives in `api/film-search.js`, same setup as
Board Games and the Wishlist: if it says "isn't set up" (the title field still works as a plain
text box either way), the Vercel project is missing (or has a stale) `TMDB_API_KEY` environment
variable - see "Connect TMDb" above. The same missing key is why a CSV import's "finding
posters…" step silently finds none - nothing breaks, the films just stay posterless the way they
came in from the CSV.

If Home's Made Today/This Week card just doesn't appear at all, that's by design when Branch
isn't configured yet (see "Connect Branch" above) - `loadDashboardBranch` fails quiet rather
than showing a dead-end "Connect" prompt, since unlike Games/Music there's nowhere in this app
to send you to finish the setup; opening `/branch-earnings` directly in a browser tab is the
fastest way to see the actual error (missing secrets show as "Branch isn't configured", a
Supabase-side problem shows as "Branch (Supabase) returned status … : {the PostgREST error
body}" - a `42703 column ... does not exist` there means a migration in Branch's own
`supabase/migrations/` hasn't actually been run against the live database yet, most likely
`0031_invoice_line_item_created_at.sql`/`0032_invoice_line_item_updated_at.sql`, since
`created_at` on `invoice_line_items` is what both totals filter on). A wrong
`BRANCH_SUPABASE_URL` or an anon/publishable key used in place of the service_role one both show
up as that same Supabase-status error too - a `401`/`403` specifically points at the key
(row-level security blocking it), not the URL. If the card shows but a number looks off, check
`BRANCH_ANNUAL_SALARY` is a plain number (no `£`, no commas); if today's total specifically
looks far too high just once, that's likely `ADD COLUMN created_at ... DEFAULT now()` having
just backfilled every pre-existing line item's `created_at` to the moment that migration ran
(a one-time Postgres quirk, not lost or duplicated data) - it self-corrects the next day, since
those rows won't fall inside a future day's window again.
