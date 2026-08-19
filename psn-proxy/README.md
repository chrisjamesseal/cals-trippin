# Proxy (for the Games, Design and Gigs tabs)

> Four endpoints live here, all for the same reason: a browser can't make these calls itself.
> `/session`, `/refresh` and `/titles` for PlayStation, `/design-news` for the Design tab's RSS,
> `/board-games` for BoardGameGeek, and `/spotify-search` for Gigs' artist photo search.
> Deploying this once turns all of them on.

The Games tab shows your PlayStation trophy progress. PlayStation has no official public API,
and the unofficial one needs an auth step a browser can't make itself (it has to send a
`Cookie` header to Sony that `fetch()` refuses to set cross-origin, and Sony's trophy API
doesn't send back the CORS headers a browser needs either). So this one small piece needs a
real server in front of it - this folder is that server, as a [Cloudflare Worker](https://workers.cloudflare.com/)
(free tier is plenty for one person's trophy checks).

It's a stateless relay: your NPSSO code and the tokens it becomes pass through it but aren't
stored by it. Your login token itself only ever lives in your own browser's `localStorage`,
never committed anywhere.

The Design tab's `/design-news` endpoint lives in this same worker (see `worker.js`) rather
than a separate deployment - most RSS feeds have the same CORS problem the PSN API does, and
it's the same fix, so it didn't need its own Cloudflare project. It's public and identical for
everyone (no login, no per-device state), and cached for 30 minutes so it isn't re-fetching
five feeds on every page load. Deploying the worker below turns on both tabs at once.

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

## Connect Spotify (for Gigs)

Gigs works without this - artist name/venue/date/notes can always be typed by hand - but
Spotify's catalogue gives the artist field a live search with a photo, the way Board Games'
search works against BoardGameGeek.

1. Create an app at [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard)
   (any redirect URI satisfies the form; `/spotify-search` never uses one - see `worker.js`
   for why).
2. Copy its Client ID and Client Secret.
3. Set them as secrets on the deployed worker, **not** in `worker.js` or anywhere else in this
   repo - unlike PSN's `CLIENT_ID`/`CLIENT_SECRET` below (a long-published, account-agnostic
   value the community's reverse-engineered), a Spotify app's credentials are tied to your own
   developer account, and this repo is public:
   ```
   wrangler secret put SPOTIFY_CLIENT_ID
   wrangler secret put SPOTIFY_CLIENT_SECRET
   ```
   (or the Cloudflare dashboard: your worker → Settings → Variables and Secrets)

## If it breaks

Sony hasn't published this API and hasn't promised not to change it. `worker.js`'s
`CLIENT_ID`/`CLIENT_SECRET` are the values the community-maintained
[psn-api](https://github.com/achievements-app/psn-api) project has reverse-engineered for the
PlayStation App's OAuth client; if Connect starts failing where it used to work, check that
project's `src/authenticate/exchangeAccessCodeForAuthTokens.ts` (the hardcoded Basic-auth
header, base64-decoded) for current values before assuming your NPSSO code is bad. A "PlayStation
rejected the token request (status 401)" error specifically points at a stale `CLIENT_SECRET`.

If Design's feed looks thin, one of the publications in `worker.js`'s `DESIGN_FEEDS` list has
likely moved or renamed its RSS URL - each feed is fetched independently, so the rest still
come through, but check the publication's site for its current feed link and update that one
entry.

Board Games talks to [BoardGameGeek's XML API](https://boardgamegeek.com/wiki/page/BGG_XML_API2),
which rate limits and will start returning errors if it's hammered; `/board-games` caches for
six hours (an hour for searches) to stay well clear of that. BGG is also the reason the parsing
in `worker.js` looks the way it does: Workers have no `DOMParser`, and BGG double-escapes its
descriptions, so those get decoded twice where the RSS feeds are decoded once.

If Gigs' artist search says "Spotify isn't connected yet", the worker is missing (or has a
stale) `SPOTIFY_CLIENT_ID`/`SPOTIFY_CLIENT_SECRET` secret - see "Connect Spotify" above.
