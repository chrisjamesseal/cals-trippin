/* ============================================================================================
   PSN proxy for the Games tab in My Trips (../index.html) - also serves Design's news feed
   ============================================================================================
   This worker started out purely for the Games tab, but it's really just "the thing that
   makes cross-origin calls the browser can't make itself", and the Design tab needs exactly
   that for a different reason: most RSS feeds don't send the CORS headers a browser needs to
   read them directly. Rather than stand up a second Cloudflare project (and walk through
   connecting it to the repo all over again), Design's /design-news endpoint just lives here
   too. Unlike the PSN endpoints below, it needs no login and returns the same public feed to
   everyone, so it's cached for 30 minutes rather than fetched fresh every time.
   ============================================================================================
   PlayStation Network has no official public API. The widely-used reverse-engineered one
   (see https://github.com/achievements-app/psn-api, which this worker's request shapes are
   based on) needs an auth step a browser can't make on its own: exchanging your PSN login
   for an access token requires sending a `Cookie: npsso=...` header to Sony, and browsers
   refuse to let page JavaScript set that header on a cross-origin request. It also has to
   follow that up with calls to Sony's trophy API, which doesn't send back the CORS headers
   a browser needs to accept a direct response either way.

   This worker is the fix: it's the only thing that talks to Sony, and it exposes three small
   JSON endpoints the app calls instead. Your NPSSO code and the tokens it turns into pass
   through this worker but are never stored by it - it's a stateless relay, not an account
   database.

   CLIENT_ID / CLIENT_SECRET below are the ones psn-api's community has reverse-engineered for
   the PS App's OAuth client. Sony hasn't published them and could change them without notice;
   if /session or /refresh suddenly starts failing with a 401, check psn-api's source (in
   particular the hardcoded Basic-auth header in
   `src/authenticate/exchangeAccessCodeForAuthTokens.ts` in that repo, base64-decoded) for
   current values before assuming your NPSSO is the problem.

   Deploy: see README.md next to this file.
   ============================================================================================ */

const LOGIN_URL = 'https://ca.account.sony.com/api/authz/v3/oauth/authorize';
const TOKEN_URL = 'https://ca.account.sony.com/api/authz/v3/oauth/token';
const TROPHY_TITLES_URL = 'https://m.np.playstation.com/api/trophy/v1/users/me/trophyTitles';

const CLIENT_ID = '09515159-7237-4370-9b40-3806e67c0891';
const CLIENT_SECRET = 'ucPjka5tntB2KqsP';
const REDIRECT_URI = 'com.scee.psxandroid.scecompcall://redirect';
const SCOPE = 'psn:mobile.v2.core psn:clientapp';

function corsHeaders(env){
  return {
    'Access-Control-Allow-Origin': (env && env.ALLOWED_ORIGIN) || '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  };
}
function json(data, status, env){
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({'Content-Type': 'application/json'}, corsHeaders(env)),
  });
}
function bearerFrom(request){
  const h = request.headers.get('Authorization') || '';
  const m = /^Bearer (.+)$/.exec(h);
  return m ? m[1] : null;
}

/* Step 1 of the OAuth dance: swap the NPSSO code for a one-time authorization code. PSN
   responds with a redirect whose Location carries the code as a query param; nothing at
   that redirect target actually needs to be reached, so the fetch is told not to follow it. */
async function exchangeNpssoForAuthCode(npsso){
  const url = `${LOGIN_URL}?access_type=offline&client_id=${CLIENT_ID}` +
    `&scope=${encodeURIComponent(SCOPE)}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&response_type=code`;
  const res = await fetch(url, {
    redirect: 'manual',
    headers: { Cookie: `npsso=${npsso}` },
  });
  const location = res.headers.get('location');
  const code = location && new URL(location).searchParams.get('code');
  if(!code) throw new Error('PlayStation did not return an authorization code - the NPSSO code is likely wrong or expired');
  return code;
}
async function exchangeAuthCodeForTokens(code){
  return tokenRequest(`grant_type=authorization_code&code=${encodeURIComponent(code)}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&token_format=jwt`);
}
async function refreshTokens(refreshToken){
  return tokenRequest(`grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}` +
    `&scope=${encodeURIComponent(SCOPE)}&token_format=jwt`);
}
async function tokenRequest(body){
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + btoa(`${CLIENT_ID}:${CLIENT_SECRET}`),
    },
    body,
  });
  if(!res.ok) throw new Error('PlayStation rejected the token request (status ' + res.status + ')');
  const data = await res.json();
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
  };
}

async function fetchTitles(accessToken, search){
  const url = new URL(TROPHY_TITLES_URL);
  url.searchParams.set('limit', search.get('limit') || '100');
  if(search.get('offset')) url.searchParams.set('offset', search.get('offset'));
  const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
  if(res.status===401) throw Object.assign(new Error('expired'), {status:401});
  if(!res.ok) throw new Error('PlayStation trophy API returned status ' + res.status);
  const data = await res.json();
  const titles = (data.trophyTitles || []).map(t => ({
    id: t.npCommunicationId,
    name: t.trophyTitleName,
    iconUrl: t.trophyTitleIconUrl,
    platform: t.trophyTitlePlatform,
    progress: t.progress || 0,
    lastPlayed: t.lastUpdatedDateTime,
    // Sony's own response already breaks both of these down by tier - kept here rather than
    // collapsed to a bare total, so a per-game page can show "3 Platinum, 12 Gold…" rather than
    // just a trophy count with no sense of how hard any of them were to get
    earnedTrophies: {
      bronze: (t.earnedTrophies && t.earnedTrophies.bronze) || 0,
      silver: (t.earnedTrophies && t.earnedTrophies.silver) || 0,
      gold: (t.earnedTrophies && t.earnedTrophies.gold) || 0,
      platinum: (t.earnedTrophies && t.earnedTrophies.platinum) || 0,
      total: (t.earnedTrophies && (t.earnedTrophies.bronze + t.earnedTrophies.silver + t.earnedTrophies.gold + t.earnedTrophies.platinum)) || 0,
    },
    definedTrophies: {
      bronze: (t.definedTrophies && t.definedTrophies.bronze) || 0,
      silver: (t.definedTrophies && t.definedTrophies.silver) || 0,
      gold: (t.definedTrophies && t.definedTrophies.gold) || 0,
      platinum: (t.definedTrophies && t.definedTrophies.platinum) || 0,
      total: (t.definedTrophies && (t.definedTrophies.bronze + t.definedTrophies.silver + t.definedTrophies.gold + t.definedTrophies.platinum)) || 0,
    },
  }));
  // most recently played/updated first, so the top of the list is "what you're playing now"
  titles.sort((a,b) => new Date(b.lastPlayed||0) - new Date(a.lastPlayed||0));
  return { titles };
}

/* ---------- Design news: a handful of well-known UX/design RSS feeds, merged ---------- */
/* These are long-standing, well-known feed URLs, but nobody guarantees an RSS URL forever -
   if one of these goes quiet, check the publication's own site for its current feed link and
   update it here. A feed failing just means fewer articles that day, not a broken page: each
   is fetched independently and the rest still come through (see fetchDesignNews).
   UX Planet dropped (2026-08): its feed only ever carried a short teaser, well under
   READABLE_MIN_CHARS, so every one of its articles showed the "Read on UX Planet" link-out
   button instead of being readable in the app - the opposite of what this section is for. */
const DESIGN_FEEDS = [
  {name:'Smashing Magazine', url:'https://www.smashingmagazine.com/feed/'},
  {name:'Nielsen Norman Group', url:'https://www.nngroup.com/feed/rss/'},
  {name:'UX Collective', url:'https://uxdesign.cc/feed'},
  {name:'A List Apart', url:'https://alistapart.com/main/feed/'},
];
/* Film and Music news below are the same shape of problem as Design's own feed above - a
   handful of well-known publications, merged - so they reuse every piece of it (parseFeedItems,
   htmlToBlocks, the caching route pattern) via the generic fetchNewsFeeds() a few lines down,
   rather than three near-identical copies of the same fetch/parse/merge logic. */
/* Variety and THR are trimmed to their Film/Movies verticals rather than their all-topics feeds
   (TV, music, general business) - the original all-topics feeds were mostly industry-deal news
   with no film-watching interest to it. IndieWire covers cinema culture and criticism rather
   than trade news, and What's on Netflix covers new/upcoming streaming releases - neither
   overlaps with what the trade papers already publish. */
const FILM_FEEDS = [
  {name:'Variety', url:'https://variety.com/v/film/feed/'},
  {name:'The Hollywood Reporter', url:'https://www.hollywoodreporter.com/topic/movies/feed/'},
  {name:'IndieWire', url:'https://www.indiewire.com/feed/'},
  {name:"What's on Netflix", url:'https://www.whats-on-netflix.com/feed/'},
];
const MUSIC_FEEDS = [
  {name:'Resident Advisor', url:'https://ra.co/xml/rss.xml'},
  {name:'DJ Mag', url:'https://djmag.com/feed'},
  {name:'Spotify Newsroom', url:'https://newsroom.spotify.com/feed/'},
];
const SUMMARY_MAX = 220;
/* the reader shows the article inside the app, so the body rides along with the list rather
   than costing a second request per article. Capped because five feeds' worth of full text
   would make this response far bigger than it needs to be; anything longer keeps its last
   paragraph and points at the original. */
const BODY_MAX_CHARS = 2600;
const BODY_MAX_BLOCKS = 24;

function extractTag(xml, tag){
  const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(xml);
  return m ? m[1] : '';
}
function stripCdata(s){
  const m = /^\s*<!\[CDATA\[([\s\S]*)\]\]>\s*$/.exec(s);
  return m ? m[1] : s;
}
function decodeEntities(s){
  return s.replace(/&lt;/g,'<').replace(/&gt;/g,'>')
    .replace(/&quot;/g,'"').replace(/&#0?39;/g,"'").replace(/&nbsp;/g,' ')
    /* BGG's descriptions are thick with numeric entities (&#10; for line breaks, &#226; and
       friends for punctuation), which the named list above doesn't touch */
    .replace(/&#(\d+);/g, (_, n) => { try{ return String.fromCodePoint(+n); }catch(e){ return ' '; } })
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => { try{ return String.fromCodePoint(parseInt(h,16)); }catch(e){ return ' '; } })
    /* last, so an &amp;#39; unwraps to &#39; rather than being decoded twice */
    .replace(/&amp;/g,'&');
}
function stripHtml(s){
  return s.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
}
/* Feed content into structured blocks for the in-app reader.
   Deliberately NOT passing the feed's own HTML through: this is somebody else's markup from a
   site we don't control, and the app would have to inject it into its own page to show it.
   What crosses instead is a description of the article - headings, paragraphs, bold/italic
   runs, list items, quotes and image URLs - with every piece of text carried as text. The app
   builds the tags itself and escapes the text on the way in, so nothing that arrives here can
   become markup there. Rich enough to read properly, with no way to smuggle anything in.

   The control characters below are private markers, inserted after the tags they stand for
   have been recognised and before the rest are stripped, so a block's type survives the split
   into blocks. They're scrubbed from the text at the end. */
function inlineRuns(html){
  const marked = html
    .replace(/<(b|strong)\b[^>]*>/gi, '\u0001B').replace(/<\/(b|strong)\s*>/gi, '\u0001b')
    .replace(/<(i|em)\b[^>]*>/gi, '\u0001I').replace(/<\/(i|em)\s*>/gi, '\u0001i')
    .replace(/<[^>]+>/g, ' ');
  /* a few feeds entity-escape their own markup (&lt;p&gt; instead of a literal <p>), invisible to
     the tag-strip above since it runs before decoding - decodeEntities turns that into a literal
     "<p>" sitting right there in the text, with nothing left downstream to catch it. Stripping
     again after decoding removes whatever decoding just revealed - the same double-encoding case
     extractFeedImage already has to account for. Deliberately a stricter "this actually looks
     like a tag" pattern here (must open with a letter or /) rather than the loose one above: body
     text sometimes uses &lt;/&gt; for genuine less-than/greater-than ("x &lt; y"), and the loose
     <[^>]+> pattern would swallow real prose between an unrelated < and the next > on the line. */
  const text = decodeEntities(marked).replace(/<\/?[a-z][^<>]*>/gi, ' ');
  const runs = [];
  let bold = 0, ital = 0, buf = '';
  const flush = () => {
    if(!buf) return;
    const run = {x: buf.replace(/\s+/g, ' ')};
    if(bold > 0) run.b = 1;
    if(ital > 0) run.i = 1;
    runs.push(run);
    buf = '';
  };
  for(let k = 0; k < text.length; k++){
    if(text[k] === '\u0001'){
      const cmd = text[++k];
      flush();
      if(cmd === 'B') bold++;
      else if(cmd === 'b') bold = Math.max(0, bold - 1);
      else if(cmd === 'I') ital++;
      else if(cmd === 'i') ital = Math.max(0, ital - 1);
      continue;
    }
    buf += text[k];
  }
  flush();
  /* an empty run is noise, but a run that's only a space is the gap between two bold words
     and has to stay */
  const out = runs.filter(r => r.x !== '');
  if(out.length) out[0].x = out[0].x.replace(/^\s+/, '');
  if(out.length) out[out.length-1].x = out[out.length-1].x.replace(/\s+$/, '');
  return out.filter(r => r.x !== '');
}
function htmlToBlocks(html){
  if(!html) return [];
  let h = html.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ');
  /* an image becomes a block of its own, marked so it survives the split below */
  h = h.replace(/<img\b[^>]*>/gi, tag => {
    const src = (/\bsrc=["']([^"']+)["']/i.exec(tag) || [])[1] || '';
    const alt = (/\balt=["']([^"']*)["']/i.exec(tag) || [])[1] || '';
    return src ? `\n\n\u0002IMG\u0003${src}\u0003${alt}\u0002\n\n` : ' ';
  });
  h = h.replace(/<h[1-6]\b[^>]*>/gi, '\n\n\u0002H\u0002')
       .replace(/<li\b[^>]*>/gi, '\n\n\u0002L\u0002')
       .replace(/<blockquote\b[^>]*>/gi, '\n\n\u0002Q\u0002')
       /* close tags mark where one block ends, before the tags themselves are stripped -
          otherwise the whole article arrives as a single wall of text */
       .replace(/<\/(p|div|section|article|li|h[1-6]|blockquote|figcaption|tr|ul|ol)\s*>/gi, '\n\n')
       .replace(/<br\s*\/?>/gi, '\n');

  const blocks = [];
  let chars = 0;
  for(const chunk of h.split(/\n\s*\n/)){
    if(blocks.length >= BODY_MAX_BLOCKS || chars >= BODY_MAX_CHARS) break;
    const raw = chunk.trim();
    if(!raw) continue;
    const img = /^\u0002IMG\u0003([\s\S]*?)\u0003([\s\S]*?)\u0002$/.exec(raw);
    if(img){
      const src = img[1].trim();
      /* https only. A feed can put whatever it likes in a src and this ends up in the app's
         own page, so anything that isn't plainly a remote image is dropped rather than
         cleaned up. */
      if(/^https:\/\/[^"'\s<>]+$/i.test(src)){
        blocks.push({t:'img', src, alt: decodeEntities(img[2].trim()).slice(0,200)});
      }
      continue;
    }
    let t = 'p', body = raw;
    const mark = /^\u0002([HLQ])\u0002/.exec(raw);
    if(mark){
      t = mark[1]==='H' ? 'h' : mark[1]==='L' ? 'li' : 'q';
      body = raw.slice(3);
    }
    body = body.replace(/[\u0002\u0003]/g, ' ');   // leftovers from unbalanced markup
    const runs = inlineRuns(body);
    const len = runs.reduce((n,r) => n + r.x.length, 0);
    if(len < 2) continue;                          // a stray bullet or "|" isn't a block
    blocks.push({t, r: runs});
    chars += len;
  }
  return blocks;
}
/* hand-rolled rather than a real XML parser: Workers have no DOMParser, and RSS/Atom's shape
   is regular enough that pulling each <item>/<entry> block and reading a few known tags out
   of it holds up fine in practice, without pulling in a dependency for it */
/* a feed's lead/featured image, tried in the order feeds most commonly actually carry one:
   Media RSS's own thumbnail/content tags, then an image enclosure, then (worst case) just the
   first <img> anywhere in the item's own markup - usually the article's own body content, which
   for most of these feeds opens on a relevant image anyway. https only, matching the same rule
   inline body images already follow (see htmlToBlocks): the src is untrusted, from a feed this
   app doesn't control. */
function extractFeedImage(block){
  const media = /<media:(?:thumbnail|content)\b[^>]*\burl=["']([^"']+)["']/i.exec(block);
  const enclosure = /<enclosure\b[^>]*\burl=["']([^"']+)["'][^>]*\btype=["']image\/[^"']*["']/i.exec(block)
                  || /<enclosure\b[^>]*\btype=["']image\/[^"']*["'][^>]*\burl=["']([^"']+)["']/i.exec(block);
  /* most feeds wrap description/content in CDATA, where an <img> tag is literal HTML the regex
     below can see directly - a few entity-escape it instead (&lt;img src="..."&gt;), invisible
     to that same regex until decoded first */
  const searchIn = /&lt;img\b/i.test(block) ? decodeEntities(block) : block;
  /* a lazy-loading theme (common on WordPress sites like DJ Mag) ships <img src="1x1.gif"
     data-src="the-real-image.jpg" loading="lazy">, so a plain src= grab finds a real-looking but
     blank placeholder - data-src/data-original/srcset (its first candidate) are checked first,
     the actual src= last, whichever of them turns up a real https URL first wins */
  const inlineImg = /<img\b[^>]*>/i.exec(searchIn);
  const inlineTag = inlineImg ? inlineImg[0] : '';
  const dataSrc = /\bdata-(?:src|original)=["']([^"']+)["']/i.exec(inlineTag);
  const srcset = /\bsrcset=["']([^"',\s]+)/i.exec(inlineTag);
  const plainSrc = /\bsrc=["']([^"']+)["']/i.exec(inlineTag);
  const src = (media && media[1]) || (enclosure && enclosure[1])
    || (dataSrc && dataSrc[1]) || (srcset && srcset[1]) || (plainSrc && plainSrc[1]) || '';
  return /^https:\/\/[^"'\s<>]+$/i.test(src) ? src : '';
}
function parseFeedItems(xml, sourceName){
  const blocks = [];
  const itemRe = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  const entryRe = /<entry\b[^>]*>([\s\S]*?)<\/entry>/gi;
  let m;
  while((m = itemRe.exec(xml))) blocks.push(m[1]);
  if(!blocks.length) while((m = entryRe.exec(xml))) blocks.push(m[1]);

  return blocks.map(block => {
    const title = decodeEntities(stripHtml(stripCdata(extractTag(block,'title')))).trim();
    let link = stripCdata(extractTag(block,'link')).trim();
    if(!link || /^</.test(link)){
      // Atom: <link href="..."/>, sometimes several (rel="self", rel="alternate"...) - the
      // human-readable page is rel="alternate" when that's marked, otherwise just the first
      const altM = /<link\b(?=[^>]*\brel=["']alternate["'])[^>]*\bhref=["']([^"']+)["']/i.exec(block)
                || /<link\b[^>]*\bhref=["']([^"']+)["'](?=[^>]*\brel=["']alternate["'])/i.exec(block);
      const anyM = /<link\b[^>]*\bhref=["']([^"']+)["']/i.exec(block);
      link = (altM && altM[1]) || (anyM && anyM[1]) || '';
    }
    // dc:date last - Dublin Core's date tag, some feeds' only date field when they skip the
    // standard RSS/Atom ones entirely
    const pubRaw = extractTag(block,'pubDate') || extractTag(block,'updated') || extractTag(block,'published') || extractTag(block,'dc:date');
    const date = pubRaw ? new Date(pubRaw) : null;
    let summary = decodeEntities(stripHtml(stripCdata(
      extractTag(block,'description') || extractTag(block,'summary') || extractTag(block,'content:encoded') || ''
    )));
    if(summary.length > SUMMARY_MAX) summary = summary.slice(0, SUMMARY_MAX - 1).trim() + '…';
    /* content:encoded is where a feed puts the whole piece when it publishes one; description
       is usually just the teaser. Take the richest of the two, and let the app decide whether
       there's enough there to be worth reading in place. */
    const rich = stripCdata(extractTag(block,'content:encoded') || extractTag(block,'content') || '');
    const teaser = stripCdata(extractTag(block,'description') || extractTag(block,'summary') || '');
    const body = htmlToBlocks(rich.length > teaser.length ? rich : teaser);
    const image = extractFeedImage(block);
    return {title, link, source: sourceName, date: (date && !isNaN(date)) ? date.toISOString() : null, summary, image, body};
  }).filter(a => a.title && a.link);
}
/* a rough, honest-about-its-limits language filter: no real language detection library runs in
   a Worker, so this catches what's reliably catchable without one - non-Latin scripts (Cyrillic,
   CJK, Arabic...), which show up as a high proportion of non-ASCII characters. It will not catch
   a French or German piece written in the same Latin alphabet as English; that would need real
   language detection, not a character-ratio guess. */
function looksNonEnglish(title, summary){
  const text = ((title||'') + (summary||'')).replace(/\s+/g,'');
  if(text.length < 12) return false;
  let nonAscii = 0;
  for(const ch of text) if(ch.codePointAt(0) > 127) nonAscii++;
  return (nonAscii / text.length) > 0.2;
}
/* same honesty caveat as above - a fixed list of other major cities, matched by name in the
   title/summary. An article that never names a city at all (most Design pieces) always passes
   through untouched; only ones that explicitly name somewhere else, without also naming London,
   get dropped. It won't catch a piece about a place not on this list, and it can't tell "the
   London borough of Hackney" from "Hackney, Georgia" - a keyword match, not real geocoding.
   Design-only (see fetchNewsFeeds' filterLocation flag below): Film and Music are trade press
   covering a global industry - Variety/Hollywood Reporter are LA-centric by nature, Resident
   Advisor/DJ Mag cover Berlin/Ibiza/Amsterdam as core dance-music territory, not "somewhere
   else" - so applying a London-only filter there was dropping nearly everything in both
   categories rather than just the odd genuinely-irrelevant piece. */
const OTHER_CITY_NAMES = ['new york','los angeles','san francisco','chicago','miami','las vegas',
  'detroit','brooklyn','berlin','paris','amsterdam','ibiza','barcelona','tokyo','toronto','sydney'];
function looksOffLocation(title, summary){
  const text = ((title||'') + ' ' + (summary||'')).toLowerCase();
  if(/\blondon\b/.test(text)) return false;
  return OTHER_CITY_NAMES.some(city => new RegExp('\\b'+city+'\\b').test(text));
}
async function fetchNewsFeeds(feeds, logLabel, filterLocation){
  const results = await Promise.allSettled(feeds.map(async f => {
    const res = await fetch(f.url, {headers: {'User-Agent': 'Mozilla/5.0 (compatible; MyTripsNewsFeed/1.0)'}});
    if(!res.ok) throw new Error('status ' + res.status);
    return parseFeedItems(await res.text(), f.name);
  }));
  let articles = [];
  const failures = [];
  results.forEach((r, i) => {
    if(r.status === 'fulfilled') articles = articles.concat(r.value);
    else failures.push({name: feeds[i].name, reason: (r.reason && (r.reason.message || r.reason)) || 'unknown error'});
  });
  // a feed failing isn't fatal to the page (the others still show), but silently swallowing
  // every failure meant "all of them down" looked identical to "nothing published today" -
  // logged here for the Cloudflare dashboard's Logs tab, and (only when EVERY feed failed)
  // passed back to the app so it can say so instead of implying a quiet news day
  failures.forEach(f => console.error(logLabel+' feed failed:', f.name, f.reason));
  articles = articles.filter(a => !looksNonEnglish(a.title, a.summary) && (!filterLocation || !looksOffLocation(a.title, a.summary)));
  articles.sort((a,b) => new Date(b.date || 0) - new Date(a.date || 0));
  const allFailed = failures.length === feeds.length;
  return {articles: articles.slice(0, 40), error: allFailed ? failures[0].reason : undefined};
}
const fetchDesignNews = () => fetchNewsFeeds(DESIGN_FEEDS, 'design-news', true);
const fetchFilmNews = () => fetchNewsFeeds(FILM_FEEDS, 'film-news', false);
const fetchMusicNews = () => fetchNewsFeeds(MUSIC_FEEDS, 'music-news', false);

/* ================= Letterboxd (Films diary import) =================
   Letterboxd's real API is invite-only (email api@letterboxd.com and hope for approval) - not
   something a personal project can get self-serve access to the way Spotify/BGG/RAWG's own
   dashboards allow. Every account does have a free, public, no-auth diary RSS feed though
   (letterboxd.com/<username>/rss/), the same shape of problem Design's feeds above solve, so it
   gets the same fix: fetched and reduced to plain JSON here. Diary-only - your most recently
   logged films (Letterboxd caps a free account's own feed at ~50 entries), not your full
   watched history or watchlist, neither of which are exposed outside the closed API. */
function extractLetterboxdImage(block){
  // the feed doesn't carry a dedicated poster field - the closest thing is an <img> Letterboxd
  // itself embeds in the entry's own description HTML, when there's a poster to show at all
  const desc = stripCdata(extractTag(block, 'description') || '');
  const m = /<img\b[^>]*\bsrc=["']([^"']+)["']/i.exec(desc);
  return (m && /^https:\/\/[^"'\s<>]+$/i.test(m[1])) ? m[1] : '';
}
function parseLetterboxdItems(xml){
  const blocks = [];
  const itemRe = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let m;
  while((m = itemRe.exec(xml))) blocks.push(m[1]);
  return blocks.map(block => {
    let title = decodeEntities(stripHtml(stripCdata(extractTag(block, 'letterboxd:filmTitle')))).trim();
    let year = decodeEntities(stripHtml(stripCdata(extractTag(block, 'letterboxd:filmYear')))).trim();
    if(!title){
      // fallback for anything the namespaced tags didn't cover: the plain <title> reads
      // "Film Name, YYYY - ★★★★" (or without the year/rating for an unrated log)
      const raw = decodeEntities(stripHtml(stripCdata(extractTag(block, 'title')))).trim();
      const parts = /^(.*?),\s*(\d{4})/.exec(raw);
      title = parts ? parts[1].trim() : raw;
      year = year || (parts ? parts[2] : '');
    }
    const ratingRaw = decodeEntities(stripHtml(stripCdata(extractTag(block, 'letterboxd:memberRating')))).trim();
    const rating = ratingRaw ? parseFloat(ratingRaw) : NaN;
    const rewatchRaw = decodeEntities(stripHtml(stripCdata(extractTag(block, 'letterboxd:rewatch')))).trim();
    const watchedDate = decodeEntities(stripHtml(stripCdata(extractTag(block, 'letterboxd:watchedDate')))).trim();
    const link = decodeEntities(stripHtml(stripCdata(extractTag(block, 'link')))).trim();
    const guid = decodeEntities(stripHtml(stripCdata(extractTag(block, 'guid')))).trim();
    const pubRaw = extractTag(block, 'pubDate');
    const pubDate = pubRaw ? new Date(pubRaw) : null;
    return {
      id: guid || link,
      title,
      year: year || null,
      watchedDate: watchedDate || ((pubDate && !isNaN(pubDate)) ? pubDate.toISOString().slice(0,10) : null),
      rating: isNaN(rating) ? null : rating,
      rewatch: /^yes$/i.test(rewatchRaw),
      link,
      image: extractLetterboxdImage(block),
    };
  }).filter(f => f.title);
}
async function fetchLetterboxdDiary(username){
  const u = String(username||'').trim().replace(/^@/, '');
  if(!u || !/^[a-zA-Z0-9_]+$/.test(u)){
    throw Object.assign(new Error('Enter a valid Letterboxd username'), {status:400});
  }
  const res = await fetch(`https://letterboxd.com/${encodeURIComponent(u)}/rss/`, {
    headers: {'User-Agent': 'Mozilla/5.0 (compatible; MyTripsFilmsFeed/1.0)'},
  });
  if(res.status === 404){
    throw Object.assign(new Error("No Letterboxd account found for that username"), {status:404});
  }
  if(!res.ok) throw new Error('Letterboxd returned status ' + res.status);
  return {films: parseLetterboxdItems(await res.text())};
}

/* ================= Spotify (artist lookup for Gigs) =================
   Just the public catalogue - artist name, photo, genres - so the Client Credentials flow is
   enough: an app-level token, no user login. The token is cached in memory between requests
   (one Worker isolate serves many requests before Cloudflare recycles it) and refreshed a
   little before it actually expires.

   Requires SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET set as Worker secrets (dashboard:
   Settings -> Variables and Secrets, or `wrangler secret put SPOTIFY_CLIENT_ID` etc from the
   psn-proxy/ folder) - deliberately NOT hardcoded here the way PSN's CLIENT_ID/SECRET above
   are. Those are a long-published, account-agnostic value the psn-api community reverse-
   engineered; a Spotify app's credentials are tied to your own developer account, and this
   file is in a public repo - anyone reading it would be able to spend your API quota. */
let spotifyToken = null;   // {accessToken, expiresAt} - module scope, reused across requests
async function spotifyAccessToken(env){
  if(spotifyToken && spotifyToken.expiresAt > Date.now()) return spotifyToken.accessToken;
  if(!env.SPOTIFY_CLIENT_ID || !env.SPOTIFY_CLIENT_SECRET){
    throw Object.assign(new Error("Spotify isn't configured - add SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET as Worker secrets"), {status:503});
  }
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`),
    },
    body: 'grant_type=client_credentials',
  });
  if(!res.ok) throw new Error('Spotify rejected the token request (status ' + res.status + ')');
  const data = await res.json();
  // a minute of slack so a token doesn't expire mid-flight on a request that's already using it
  spotifyToken = {accessToken: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000};
  return spotifyToken.accessToken;
}
async function searchSpotifyArtists(env, q){
  if(!q) return {artists:[]};
  const token = await spotifyAccessToken(env);
  const url = 'https://api.spotify.com/v1/search?type=artist&limit=10&q=' + encodeURIComponent(q);
  const res = await fetch(url, {headers: {Authorization: 'Bearer ' + token}});
  if(!res.ok) throw new Error('Spotify search returned status ' + res.status);
  const data = await res.json();
  const items = (data.artists && data.artists.items) || [];
  // Spotify lists an artist's images largest-first; the smallest is plenty for a thumbnail
  const artists = items.map(a => ({
    id: a.id,
    name: a.name,
    image: (a.images && a.images.length) ? a.images[a.images.length-1].url : '',
    genres: a.genres || [],
    spotifyUrl: (a.external_urls && a.external_urls.spotify) || '',
  }));
  return {artists};
}

/* ---------- Spotify user login (for the Gigs artist checklist) ----------
   Who you follow and who you actually listen to are personal library data, not the public
   catalogue - Spotify only hands that over once you've logged in and approved it, so this is a
   real Authorization Code exchange (same shape as PSN's /session and /refresh above) rather
   than the app-only Client Credentials flow searchSpotifyArtists uses.

   The app itself is the redirect target (it's a static SPA with no server-side route to land
   on) - Spotify sends the browser back to SPOTIFY_REDIRECT_URI with a ?code=... query param,
   and the app's own JS reads that on load and posts it to /spotify-callback below. Update this
   constant if you deploy the app somewhere other than the address it's already set to; it also
   has to be added, byte-for-byte, as a Redirect URI in your Spotify app's dashboard settings. */
const SPOTIFY_REDIRECT_URI = 'https://cals-trippin.vercel.app/';
const SPOTIFY_SCOPES = 'user-follow-read user-top-read';
function spotifyLoginUrl(env, state){
  if(!env.SPOTIFY_CLIENT_ID) throw Object.assign(new Error("Spotify isn't configured - add SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET as Worker secrets"), {status:503});
  const p = new URLSearchParams({
    client_id: env.SPOTIFY_CLIENT_ID, response_type: 'code',
    redirect_uri: SPOTIFY_REDIRECT_URI, scope: SPOTIFY_SCOPES,
  });
  // round-tripped through Spotify unchanged and checked again once the app gets it back, so a
  // stray ?code= (or one pointed at a different login) can't get redeemed as if it were this one
  if(state) p.set('state', state);
  return 'https://accounts.spotify.com/authorize?' + p.toString();
}
async function spotifyTokenRequest(env, body){
  if(!env.SPOTIFY_CLIENT_ID || !env.SPOTIFY_CLIENT_SECRET){
    throw Object.assign(new Error("Spotify isn't configured - add SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET as Worker secrets"), {status:503});
  }
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`),
    },
    body,
  });
  if(!res.ok) throw new Error('Spotify rejected the token request (status ' + res.status + ')');
  const data = await res.json();
  return {
    accessToken: data.access_token,
    // a refresh isn't guaranteed a new one back - keep the one already on file when it doesn't
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
  };
}
function exchangeSpotifyCode(env, code){
  return spotifyTokenRequest(env, new URLSearchParams({
    grant_type: 'authorization_code', code, redirect_uri: SPOTIFY_REDIRECT_URI,
  }).toString());
}
function refreshSpotifyToken(env, refreshToken){
  return spotifyTokenRequest(env, new URLSearchParams({
    grant_type: 'refresh_token', refresh_token: refreshToken,
  }).toString());
}
/* every artist you follow, each tagged with its rank (if any) in your top-artists-by-listening
   list - both endpoints paginate, so each is walked to the end before the two are merged.
   Capped well above what anyone plausibly follows/has ranked, just so a huge library can't
   turn one page load into an unbounded number of upstream calls. */
const SPOTIFY_PAGE_CAP = 1000;
async function spotifyPaged(accessToken, path, itemsOf, nextOf){
  const out = [];
  let url = 'https://api.spotify.com/v1' + path;
  while(url && out.length < SPOTIFY_PAGE_CAP){
    const res = await fetch(url, {headers: {Authorization: 'Bearer ' + accessToken}});
    if(res.status === 401) throw Object.assign(new Error('expired'), {status: 401});
    // e.g. 403 if user-follow-read/user-top-read weren't both granted, or the app is in
    // Development Mode and this Spotify account isn't added under its dashboard's user list
    if(!res.ok) throw Object.assign(new Error('Spotify returned status ' + res.status), {status: res.status});
    const data = await res.json();
    out.push(...itemsOf(data));
    // nextOf can hand back either a full URL (Spotify's own "next" field, top-artists) or a
    // relative path built by hand (the followed-artists cursor below) - either way this always
    // fetches a full URL next time, rather than trying fetch() on a bare "/me/..." path
    const next = nextOf(data);
    url = next ? (/^https?:\/\//i.test(next) ? next : 'https://api.spotify.com/v1' + next) : null;
  }
  return out;
}
async function fetchSpotifyArtistChecklist(accessToken){
  const [followed, top] = await Promise.all([
    spotifyPaged(accessToken, '/me/following?type=artist&limit=50',
      d => (d.artists && d.artists.items) || [],
      d => d.artists && d.artists.cursors && d.artists.cursors.after
        ? '/me/following?type=artist&limit=50&after=' + d.artists.cursors.after : null),
    spotifyPaged(accessToken, '/me/top/artists?time_range=long_term&limit=50',
      d => d.items || [], d => d.next || null),
  ]);
  const rankOf = {};
  top.forEach((a, i) => { rankOf[a.id] = i; });
  const artists = followed.map(a => ({
    id: a.id,
    name: a.name,
    image: (a.images && a.images.length) ? a.images[a.images.length-1].url : '',
    genres: a.genres || [],
    spotifyUrl: (a.external_urls && a.external_urls.spotify) || '',
    rank: rankOf[a.id] ?? null,
  }));
  // ranked by how much you actually listen (top-artists order), least/never-played followed
  // artists sorted alphabetically underneath rather than in Spotify's arbitrary follow order
  artists.sort((a, b) => {
    if(a.rank != null && b.rank != null) return a.rank - b.rank;
    if(a.rank != null) return -1;
    if(b.rank != null) return 1;
    return a.name.localeCompare(b.name);
  });
  return {artists};
}
/* the Songs tab's ranked top-tracks list. Spotify only computes three fixed windows - there's
   no real "this week"/"this month"/"this year" (nothing calendar-aligned), so the UI's filter
   chips are labelled honestly as what these actually are rather than approximated to match. */
const SPOTIFY_TIME_RANGES = ['short_term', 'medium_term', 'long_term'];
async function fetchSpotifyTopTracks(accessToken, timeRange){
  const tr = SPOTIFY_TIME_RANGES.includes(timeRange) ? timeRange : 'long_term';
  const res = await fetch('https://api.spotify.com/v1/me/top/tracks?time_range='+tr+'&limit=50',
    {headers: {Authorization: 'Bearer ' + accessToken}});
  if(res.status === 401) throw Object.assign(new Error('expired'), {status: 401});
  if(!res.ok) throw Object.assign(new Error('Spotify returned status ' + res.status), {status: res.status});
  const data = await res.json();
  const tracks = (data.items||[]).map(t => ({
    id: t.id,
    name: t.name,
    artist: (t.artists||[]).map(a=>a.name).join(', '),
    // the smallest of Spotify's three album art sizes is plenty for a 50-row list
    image: (t.album && t.album.images && t.album.images.length) ? t.album.images[t.album.images.length-1].url : '',
    spotifyUrl: (t.external_urls && t.external_urls.spotify) || '',
  }));
  return {tracks};
}

/* Board Games moved to api/board-games.js, a Vercel serverless function alongside index.html
   rather than a route on this Worker - see that file for why (BoardGameGeek's API 401s every
   request that comes from here, and Vercel's network is worth a try instead of Cloudflare's). */

/* ================= Branch (Home's "Made Today / This Week" widget) =================
   Branch is a separate CRM (github.com/chrisjamesseal/branch) built with Next.js + Supabase,
   used to log freelance work as invoice line items - each one timestamped the moment it's
   added, valued at whatever quantity x unit price (or hours x rate) it was entered as - and to
   raise/track invoices against clients. Home's widget pulls two figures out of it: today's line
   items (07:00-23:30 Europe/London) and this week's (Monday 00:00 through now), each with a
   pro-rated day's pay from a separate 9-to-5 job added on top for every weekday that's started,
   without this app needing to know anything else about Branch's data model.

   Supabase's row-level security scopes every table to owner_id = auth.uid(), so reading it
   from here - a server with no logged-in Supabase session of its own - needs a privileged key
   that bypasses RLS: the service_role key from that Supabase project's own dashboard
   (Settings -> API), not the public anon key the Branch app itself uses in the browser.
   Requires BRANCH_SUPABASE_URL and BRANCH_SUPABASE_SERVICE_KEY as Worker secrets;
   BRANCH_ANNUAL_SALARY is optional (see fetchBranchEarnings below for what's skipped
   without it). Unlike every other integration on this Worker, this one has no per-request
   bearer token proving who's asking - the service key above is what authorizes the request,
   not the caller, so setting ALLOWED_ORIGIN (see wrangler.toml) matters more here than it does
   for the others, since anyone who finds this Worker's URL can otherwise call it too. */
const BRANCH_WORKDAYS_PER_YEAR = 260;   // 52 weeks x 5 weekdays - a simple, common approximation
function branchRound2(n){ return Math.round(n * 100) / 100; }
/* Europe/London's current UTC offset (0 in winter, 60 minutes in summer) - used to convert the
   day's 07:00-23:30 local window into the UTC timestamps Supabase actually stores created_at
   as. Computed fresh per request rather than hardcoded so it tracks the BST switch on its own;
   the only day this is ever wrong is the day the offset itself changes mid-window, which
   nothing here needs to be exact about. */
function londonOffsetMinutes(date){
  const parts = new Intl.DateTimeFormat('en-US', {timeZone:'Europe/London', timeZoneName:'shortOffset'}).formatToParts(date);
  const tz = (parts.find(p=>p.type==='timeZoneName') || {}).value || 'GMT';
  const m = /GMT([+-]\d+)?/.exec(tz);
  return (m && m[1]) ? parseInt(m[1],10) * 60 : 0;
}
function londonDateAndWeekday(now){
  const ymd = new Intl.DateTimeFormat('en-CA', {timeZone:'Europe/London', year:'numeric', month:'2-digit', day:'2-digit'}).format(now);
  const weekday = new Intl.DateTimeFormat('en-GB', {timeZone:'Europe/London', weekday:'short'}).format(now);
  return {ymd, weekday};
}
function branchTodayWindow(now){
  const {ymd, weekday} = londonDateAndWeekday(now);
  const offset = londonOffsetMinutes(now);
  const start = new Date(`${ymd}T07:00:00Z`); start.setUTCMinutes(start.getUTCMinutes() - offset);
  const end = new Date(`${ymd}T23:30:00Z`); end.setUTCMinutes(end.getUTCMinutes() - offset);
  return {ymd, start, end, isWeekday: !['Sat','Sun'].includes(weekday)};
}
/* Monday 00:00 Europe/London of the current week through right now - no 07:00-23:30 windowing
   within that (that's specifically a same-day noise filter, not something a week total needs).
   weekdaysSoFar counts Mon..Fri days that have started already this week (today included, if
   today's itself a weekday) - capped at 5 since the whole working week's elapsed by Saturday. */
const WEEKDAY_ORDER = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
function branchWeekWindow(now){
  const {ymd, weekday} = londonDateAndWeekday(now);
  const dayIndex = WEEKDAY_ORDER.indexOf(weekday);
  const offset = londonOffsetMinutes(now);
  const mondayMidnightUTCDateOnly = new Date(`${ymd}T00:00:00Z`);
  mondayMidnightUTCDateOnly.setUTCDate(mondayMidnightUTCDateOnly.getUTCDate() - dayIndex);
  const mondayYmd = mondayMidnightUTCDateOnly.toISOString().slice(0, 10);
  const start = new Date(`${mondayYmd}T00:00:00Z`); start.setUTCMinutes(start.getUTCMinutes() - offset);
  return {start, weekdaysSoFar: Math.min(dayIndex + 1, 5)};
}
async function branchLineItemTotal(env, start, end){
  const url = `${env.BRANCH_SUPABASE_URL.replace(/\/$/,'')}/rest/v1/invoice_line_items` +
    `?select=amount&created_at=gte.${encodeURIComponent(start.toISOString())}&created_at=lte.${encodeURIComponent(end.toISOString())}`;
  const res = await fetch(url, {
    headers: { apikey: env.BRANCH_SUPABASE_SERVICE_KEY, Authorization: 'Bearer ' + env.BRANCH_SUPABASE_SERVICE_KEY },
  });
  // PostgREST's error body (message/code/hint/details) is far more useful for tracking down a
  // 400/401/403 than the bare status code alone - included here (truncated) so it reaches the
  // browser tab this endpoint's own troubleshooting steps have you open directly
  if(!res.ok){
    const body = await res.text().catch(() => '');
    throw new Error('Branch (Supabase) returned status ' + res.status + (body ? ': ' + body.slice(0, 300) : ''));
  }
  const rows = await res.json();
  return rows.reduce((sum, r) => sum + (parseFloat(r.amount) || 0), 0);
}
/* line items count regardless of the invoice they're on being sent/paid yet - they're a log of
   work done, not of money actually collected, which is the whole point of a same-day/same-week
   total (an invoice might not go out, let alone get paid, for weeks). Weekday salary is a flat
   pro-rated add-on for each weekday that's started already, not scaled by how much of a day has
   passed - you're on payroll for the whole day the moment it starts. */
async function fetchBranchEarnings(env){
  if(!env.BRANCH_SUPABASE_URL || !env.BRANCH_SUPABASE_SERVICE_KEY){
    throw Object.assign(new Error("Branch isn't configured - add BRANCH_SUPABASE_URL and BRANCH_SUPABASE_SERVICE_KEY as Worker secrets"), {status:503});
  }
  const now = new Date();
  const {ymd, start: todayStart, end: todayEnd, isWeekday} = branchTodayWindow(now);
  const {start: weekStart, weekdaysSoFar} = branchWeekWindow(now);
  const [todayLineItems, weekLineItems] = await Promise.all([
    branchLineItemTotal(env, todayStart, todayEnd),
    branchLineItemTotal(env, weekStart, now),
  ]);
  const salaryConfigured = !!env.BRANCH_ANNUAL_SALARY;
  const dailySalary = salaryConfigured ? (parseFloat(env.BRANCH_ANNUAL_SALARY) / BRANCH_WORKDAYS_PER_YEAR) : 0;
  const todaySalary = isWeekday ? dailySalary : 0;
  const weekSalary = dailySalary * weekdaysSoFar;
  return {
    date: ymd, isWeekday, salaryConfigured,
    today: {lineItems: branchRound2(todayLineItems), salary: branchRound2(todaySalary), total: branchRound2(todayLineItems + todaySalary)},
    week: {lineItems: branchRound2(weekLineItems), salary: branchRound2(weekSalary), total: branchRound2(weekLineItems + weekSalary)},
  };
}

export default {
  async fetch(request, env, ctx){
    if(request.method === 'OPTIONS') return new Response(null, {headers: corsHeaders(env)});
    const url = new URL(request.url);
    try{
      if(request.method === 'POST' && url.pathname === '/session'){
        const {npsso} = await request.json();
        if(!npsso) return json({error:'npsso is required'}, 400, env);
        const code = await exchangeNpssoForAuthCode(npsso);
        return json(await exchangeAuthCodeForTokens(code), 200, env);
      }
      if(request.method === 'POST' && url.pathname === '/refresh'){
        const {refreshToken} = await request.json();
        if(!refreshToken) return json({error:'refreshToken is required'}, 400, env);
        return json(await refreshTokens(refreshToken), 200, env);
      }
      if(request.method === 'GET' && url.pathname === '/titles'){
        const token = bearerFrom(request);
        if(!token) return json({error:'missing bearer token'}, 401, env);
        return json(await fetchTitles(token, url.searchParams), 200, env);
      }
      if(request.method === 'GET' && url.pathname === '/design-news'){
        // public and identical for everyone, so it's cached rather than re-fetching and
        // re-parsing five feeds on every page load
        const cache = caches.default;
        const cacheKey = new Request(url.toString(), request);
        const cached = await cache.match(cacheKey);
        if(cached) return cached;
        const res = json(await fetchDesignNews(), 200, env);
        res.headers.set('Cache-Control', 'public, max-age=1800');
        ctx.waitUntil(cache.put(cacheKey, res.clone()));
        return res;
      }
      if(request.method === 'GET' && url.pathname === '/film-news'){
        const cache = caches.default;
        const cacheKey = new Request(url.toString(), request);
        const cached = await cache.match(cacheKey);
        if(cached) return cached;
        const res = json(await fetchFilmNews(), 200, env);
        res.headers.set('Cache-Control', 'public, max-age=1800');
        ctx.waitUntil(cache.put(cacheKey, res.clone()));
        return res;
      }
      if(request.method === 'GET' && url.pathname === '/music-news'){
        const cache = caches.default;
        const cacheKey = new Request(url.toString(), request);
        const cached = await cache.match(cacheKey);
        if(cached) return cached;
        const res = json(await fetchMusicNews(), 200, env);
        res.headers.set('Cache-Control', 'public, max-age=1800');
        ctx.waitUntil(cache.put(cacheKey, res.clone()));
        return res;
      }
      if(request.method === 'GET' && url.pathname === '/letterboxd-diary'){
        // public and identical for the same username on every request, so it's cached the same
        // way as /design-news rather than re-fetching and re-parsing on every page load
        const cache = caches.default;
        const cacheKey = new Request(url.toString(), request);
        const cached = await cache.match(cacheKey);
        if(cached) return cached;
        const res = json(await fetchLetterboxdDiary(url.searchParams.get('user')), 200, env);
        res.headers.set('Cache-Control', 'public, max-age=600');
        ctx.waitUntil(cache.put(cacheKey, res.clone()));
        return res;
      }
      if(request.method === 'GET' && url.pathname === '/spotify-search'){
        const q = (url.searchParams.get('q')||'').trim();
        const cache = caches.default;
        const cacheKey = new Request(url.toString(), request);
        const cached = await cache.match(cacheKey);
        if(cached) return cached;
        const res = json(await searchSpotifyArtists(env, q), 200, env);
        res.headers.set('Cache-Control', 'public, max-age=3600');
        ctx.waitUntil(cache.put(cacheKey, res.clone()));
        return res;
      }
      if(request.method === 'GET' && url.pathname === '/spotify-login-url'){
        return json({url: spotifyLoginUrl(env, url.searchParams.get('state'))}, 200, env);
      }
      if(request.method === 'POST' && url.pathname === '/spotify-callback'){
        const {code} = await request.json();
        if(!code) return json({error:'code is required'}, 400, env);
        return json(await exchangeSpotifyCode(env, code), 200, env);
      }
      if(request.method === 'POST' && url.pathname === '/spotify-refresh'){
        const {refreshToken} = await request.json();
        if(!refreshToken) return json({error:'refreshToken is required'}, 400, env);
        return json(await refreshSpotifyToken(env, refreshToken), 200, env);
      }
      if(request.method === 'GET' && url.pathname === '/spotify-me'){
        // personal library data, one bearer token's worth - not public, not cached
        const token = bearerFrom(request);
        if(!token) return json({error:'missing bearer token'}, 401, env);
        return json(await fetchSpotifyArtistChecklist(token), 200, env);
      }
      if(request.method === 'GET' && url.pathname === '/spotify-top-tracks'){
        const token = bearerFrom(request);
        if(!token) return json({error:'missing bearer token'}, 401, env);
        return json(await fetchSpotifyTopTracks(token, url.searchParams.get('time_range')), 200, env);
      }
      if(request.method === 'GET' && url.pathname === '/branch-earnings'){
        // personal financial data, changes through the day - not cached, and (see this
        // section's own comment above) gated by the Supabase service key rather than a
        // per-request bearer token
        return json(await fetchBranchEarnings(env), 200, env);
      }
      return json({error:'not found'}, 404, env);
    }catch(e){
      // the response body already carries e.message, but that's invisible in the Cloudflare
      // Logs stream (which only sees status codes) unless it's also logged here
      console.error(url.pathname, e.stack || e.message || e);
      return json({error: e.message || 'unexpected error'}, e.status || 500, env);
    }
  },
};
