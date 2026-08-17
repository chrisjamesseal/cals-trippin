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
    earnedTrophies: {
      total: (t.earnedTrophies && (t.earnedTrophies.bronze + t.earnedTrophies.silver + t.earnedTrophies.gold + t.earnedTrophies.platinum)) || 0,
    },
    definedTrophies: {
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
   is fetched independently and the rest still come through (see fetchDesignNews). */
const DESIGN_FEEDS = [
  {name:'Smashing Magazine', url:'https://www.smashingmagazine.com/feed/'},
  {name:'Nielsen Norman Group', url:'https://www.nngroup.com/feed/rss/'},
  {name:'UX Collective', url:'https://uxdesign.cc/feed'},
  {name:'A List Apart', url:'https://alistapart.com/main/feed/'},
  {name:'UX Planet', url:'https://uxplanet.org/feed'},
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
  const text = decodeEntities(marked);
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
    const pubRaw = extractTag(block,'pubDate') || extractTag(block,'updated') || extractTag(block,'published');
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
    const body = htmlToParagraphs(rich.length > teaser.length ? rich : teaser);
    return {title, link, source: sourceName, date: (date && !isNaN(date)) ? date.toISOString() : null, summary, body};
  }).filter(a => a.title && a.link);
}
async function fetchDesignNews(){
  const results = await Promise.allSettled(DESIGN_FEEDS.map(async f => {
    const res = await fetch(f.url, {headers: {'User-Agent': 'Mozilla/5.0 (compatible; MyTripsDesignFeed/1.0)'}});
    if(!res.ok) throw new Error('status ' + res.status);
    return parseFeedItems(await res.text(), f.name);
  }));
  let articles = [];
  results.forEach(r => { if(r.status === 'fulfilled') articles = articles.concat(r.value); });
  articles.sort((a,b) => new Date(b.date || 0) - new Date(a.date || 0));
  return {articles: articles.slice(0, 40)};
}

/* ================= Board games (BoardGameGeek) =================
   BGG's XML API is the only public source for this. Same three problems as the RSS feeds and
   then some: no CORS headers, XML in a Worker with no DOMParser (so the same hand-rolled
   reading as parseFeedItems), and a rate limiter that will start refusing you. Everything here
   is cached hard because of that last one, and each request is two calls at most: one for a
   list of ids (BGG's hot list, or a search), then ONE batched call for all their details. */
const BGG = 'https://boardgamegeek.com/xmlapi2';
const BGG_UA = {'User-Agent': 'Mozilla/5.0 (compatible; MyTripsBoardGames/1.0)'};
const BGG_MAX = 36;

/* <minplayers value="2"/> - the data hangs off attributes rather than element text. The \b
   matters: without it <average> would also match <averageweight>. */
function attrOf(block, tag){
  const m = new RegExp('<'+tag+'\\b[^>]*\\bvalue="([^"]*)"', 'i').exec(block);
  return m ? decodeEntities(m[1]) : '';
}
function numAttr(block, tag){
  const v = parseFloat(attrOf(block, tag));
  return isNaN(v) ? null : v;
}
function textOf(block, tag){
  const m = new RegExp('<'+tag+'>([\\s\\S]*?)</'+tag+'>', 'i').exec(block);
  return m ? m[1].trim() : '';
}
/* categories and mechanics both arrive as <link type="..." value="..."/> rows */
function linkValues(block, type){
  const re = new RegExp('<link\\b[^>]*\\btype="'+type+'"[^>]*\\bvalue="([^"]*)"', 'gi');
  const out = []; let m;
  while((m = re.exec(block))) out.push(decodeEntities(m[1]));
  return out;
}
/* each match keeps its own opening tag, because the id is an attribute on it */
function itemBlocks(xml){
  const out = []; let m;
  const paired = /<item\b[^>]*>[\s\S]*?<\/item>/gi;
  while((m = paired.exec(xml))) out.push(m[0]);
  if(!out.length){
    const selfClosing = /<item\b[^>]*\/>/gi;
    while((m = selfClosing.exec(xml))) out.push(m[0]);
  }
  return out;
}
function itemId(block){
  const m = /<item\b[^>]*\bid="(\d+)"/i.exec(block);
  return m ? m[1] : '';
}
const round2 = n => n==null ? null : Math.round(n*100)/100;

async function bggIds(path){
  const res = await fetch(BGG+path, {headers: BGG_UA});
  if(!res.ok) throw new Error('BoardGameGeek returned '+res.status);
  return itemBlocks(await res.text()).map(itemId).filter(Boolean).slice(0, BGG_MAX);
}
async function bggDetails(ids){
  if(!ids.length) return [];
  const res = await fetch(`${BGG}/thing?id=${ids.join(',')}&stats=1`, {headers: BGG_UA});
  if(!res.ok) throw new Error('BoardGameGeek returned '+res.status);
  const byId = {};
  itemBlocks(await res.text()).forEach(b => {
    const id = itemId(b);
    if(!id) return;
    // a game carries every language's name; the one people know it by is type="primary"
    const nameM = /<name\b[^>]*\btype="primary"[^>]*\bvalue="([^"]*)"/i.exec(b);
    /* BGG double-encodes descriptions - an apostrophe reaches us as "&amp;#039;", which is the
       XML-escaped form of "&#039;" - so this decodes twice where the feeds decode once, and
       strips tags afterwards to catch any that only appear once the second pass has run. */
    let description = stripHtml(decodeEntities(decodeEntities(textOf(b,'description'))));
    if(description.length > 240) description = description.slice(0, 239).trim() + '…';
    byId[id] = {
      id,
      name: nameM ? decodeEntities(nameM[1]) : '',
      year: numAttr(b,'yearpublished'),
      thumb: textOf(b,'thumbnail'),
      image: textOf(b,'image'),
      minPlayers: numAttr(b,'minplayers'),
      maxPlayers: numAttr(b,'maxplayers'),
      minTime: numAttr(b,'minplaytime'),
      maxTime: numAttr(b,'maxplaytime'),
      playTime: numAttr(b,'playingtime'),
      weight: round2(numAttr(b,'averageweight')),   // BGG's complexity, 1-5
      rating: round2(numAttr(b,'average')),
      categories: linkValues(b,'boardgamecategory'),
      mechanics: linkValues(b,'boardgamemechanic'),
      description
    };
  });
  // back into the order the list endpoint gave them, which is the ranking we asked for
  return ids.map(id => byId[id]).filter(g => g && g.name);
}
async function fetchBoardGames(q){
  const ids = q
    ? await bggIds('/search?type=boardgame&query='+encodeURIComponent(q))
    : await bggIds('/hot?type=boardgame');
  return {games: await bggDetails(ids)};
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
      if(request.method === 'GET' && url.pathname === '/board-games'){
        // public and identical for everyone, and BGG rate limits hard, so this leans on the
        // cache more than /design-news does: the hot list barely moves day to day
        const q = (url.searchParams.get('q')||'').trim();
        const cache = caches.default;
        const cacheKey = new Request(url.toString(), request);
        const cached = await cache.match(cacheKey);
        if(cached) return cached;
        const res = json(await fetchBoardGames(q), 200, env);
        res.headers.set('Cache-Control', 'public, max-age=' + (q ? 3600 : 21600));
        ctx.waitUntil(cache.put(cacheKey, res.clone()));
        return res;
      }
      return json({error:'not found'}, 404, env);
    }catch(e){
      return json({error: e.message || 'unexpected error'}, e.status || 500, env);
    }
  },
};
