/* Theatre search for the Log Show / Add-to-Watchlist forms, served from Vercel alongside the
   app (same reasoning as api/film-search.js: same-origin, no CORS header to add, ships with an
   ordinary `git push`, no separate deploy). Backed by Ticketmaster's Discovery API
   (developer.ticketmaster.com/products-and-docs/apis/discovery-api/v2), filtered to its Arts &
   Theatre segment - there's no dedicated stage-show catalogue with an open API the way TMDb
   covers films, so this is ticketed-event data rather than a curated show database: a
   long-closed or non-touring production may not turn up. Has a real free tier (5,000 calls/day)
   and a plain API-key-in-query-string auth model - no OAuth dance.

   Needs a free Ticketmaster API key set as the TICKETMASTER_API_KEY environment variable on this
   Vercel project - see psn-proxy/README.md. Without it every request 401s from Ticketmaster's
   side, not this file's. */
export const config = { runtime: 'edge' };

const TM_SEARCH = 'https://app.ticketmaster.com/discovery/v2/events.json';

function apiKey(){
  const key = process.env.TICKETMASTER_API_KEY;
  if(!key) throw Object.assign(new Error("Show search isn't configured - add TICKETMASTER_API_KEY as a Vercel environment variable"), {status:503});
  return key;
}

/* Ticketmaster's own images array carries several crops/resolutions per event, no single
   "the poster" - the widest one reads best as a thumbnail here, same idea as picking TMDb's own
   fixed poster size in film-search.js, just without a fixed size to ask for up front. */
function pickImage(images){
  if(!images || !images.length) return '';
  const sorted = [...images].sort((a,b)=>(b.width||0)-(a.width||0));
  return (sorted[0]||{}).url || '';
}

function simplify(e){
  const venue = e._embedded && e._embedded.venues && e._embedded.venues[0];
  return {
    id: e.id,
    title: e.name || '',
    venue: venue ? [venue.name, venue.city && venue.city.name].filter(Boolean).join(', ') : '',
    date: (e.dates && e.dates.start && e.dates.start.localDate) || '',
    image: pickImage(e.images),
  };
}

/* the same show sells tickets as a separate event per performance/venue date, so a plain
   keyword search comes back with the same title many times over - keeps just the first
   (Ticketmaster's own relevance order) result per title, case-insensitively, same as picking
   one representative result per film already works in film-search.js */
function dedupeByTitle(shows){
  const seen = new Set();
  const out = [];
  for(const s of shows){
    const key = s.title.toLowerCase().trim();
    if(!key || seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

async function searchShows(q){
  if(!q) return {shows: []};
  const key = apiKey();
  const url = new URL(TM_SEARCH);
  url.searchParams.set('apikey', key);
  url.searchParams.set('keyword', q);
  url.searchParams.set('classificationName', 'Arts & Theatre');
  url.searchParams.set('size', '20');
  const res = await fetch(url.toString());
  if(!res.ok) throw new Error('Show search returned '+res.status);
  const data = await res.json();
  const events = (data._embedded && data._embedded.events) || [];
  return {shows: dedupeByTitle(events.map(simplify).filter(s=>s.title))};
}

export default async function handler(request){
  const url = new URL(request.url);
  const q = (url.searchParams.get('q')||'').trim();
  try{
    const data = await searchShows(q);
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=3600',
      },
    });
  }catch(e){
    return new Response(JSON.stringify({error: e.message || 'unexpected error'}), {
      status: e.status || 500,
      headers: {'Content-Type': 'application/json'},
    });
  }
}
