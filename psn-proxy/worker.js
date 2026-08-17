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

function extractTag(xml, tag){
  const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(xml);
  return m ? m[1] : '';
}
function stripCdata(s){
  const m = /^\s*<!\[CDATA\[([\s\S]*)\]\]>\s*$/.exec(s);
  return m ? m[1] : s;
}
function decodeEntities(s){
  return s.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
    .replace(/&quot;/g,'"').replace(/&#0?39;/g,"'").replace(/&nbsp;/g,' ');
}
function stripHtml(s){
  return s.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
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
    return {title, link, source: sourceName, date: (date && !isNaN(date)) ? date.toISOString() : null, summary};
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
      return json({error:'not found'}, 404, env);
    }catch(e){
      return json({error: e.message || 'unexpected error'}, e.status || 500, env);
    }
  },
};
