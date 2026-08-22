/* Streaming availability for a film - shown under Home's Watch Next widget and each Watchlist
   card. Served from Vercel alongside the app (same reasoning as film-search.js), backed by
   TMDb's watch/providers endpoint, which sources its data from JustWatch. Reuses the exact same
   TMDB_API_KEY environment variable film-search.js already needs - if Log Film's title search
   already works, this needs no extra setup at all.

   No TMDb id is stored against a logged/watchlisted film anywhere in this app (see
   simplify() in film-search.js - the id only ever existed for the duration of that one search),
   so this resolves title (+ year, when given) to an id via the same /search/movie call on every
   request, then asks for that id's watch providers. Region is hardcoded to GB - this app has no
   region setting anywhere else either, and JustWatch/TMDb's provider data is genuinely
   region-specific (a title's UK streaming availability is unrelated to its US one).

   Only flatrate (subscription, e.g. Netflix) and free (ad-supported, e.g. Freevee) providers are
   returned - not rent/buy - since "what streaming site is this on" is a subscription-library
   question, not a pay-per-title one. TMDb's own terms for this specific endpoint require
   crediting JustWatch and linking back to their site when the data is shown - the `link` this
   returns is that attribution link, shown by the app alongside the provider logos it's paired
   with. */
export const config = { runtime: 'edge' };

const TMDB_SEARCH = 'https://api.themoviedb.org/3/search/movie';
const TMDB_PROVIDERS = id => `https://api.themoviedb.org/3/movie/${id}/watch/providers`;
const TMDB_LOGO = 'https://image.tmdb.org/t/p/w92';

function apiKey(){
  const key = process.env.TMDB_API_KEY;
  if(!key) throw Object.assign(new Error("Film search isn't configured - add TMDB_API_KEY as a Vercel environment variable"), {status:503});
  return key;
}

async function resolveId(key, title, year){
  const url = new URL(TMDB_SEARCH);
  url.searchParams.set('api_key', key);
  url.searchParams.set('query', title);
  url.searchParams.set('include_adult', 'false');
  if(year) url.searchParams.set('year', year);
  const res = await fetch(url.toString());
  if(!res.ok) throw new Error('Film search returned '+res.status);
  const data = await res.json();
  const first = (data.results||[])[0];
  return first ? first.id : null;
}

/* a provider can legitimately appear in both flatrate and free (rare, but seen for ad-supported
   tiers of otherwise-paid services) - de-duped by provider_id so it isn't shown twice */
function dedupeProviders(list){
  const seen = new Set();
  return list.filter(p => {
    if(seen.has(p.provider_id)) return false;
    seen.add(p.provider_id);
    return true;
  }).sort((a,b) => (a.display_priority||0) - (b.display_priority||0))
    .map(p => ({id: p.provider_id, name: p.provider_name, logo: p.logo_path ? TMDB_LOGO+p.logo_path : ''}));
}

async function fetchProviders(title, year){
  const key = apiKey();
  const id = await resolveId(key, title, year);
  if(!id) return {providers: []};
  const res = await fetch(TMDB_PROVIDERS(id) + '?api_key=' + key);
  if(!res.ok) throw new Error('Watch providers returned '+res.status);
  const data = await res.json();
  const gb = (data.results||{}).GB;
  if(!gb) return {providers: []};
  return {
    providers: dedupeProviders([...(gb.flatrate||[]), ...(gb.free||[])]),
    link: gb.link || '',
  };
}

export default async function handler(request){
  const url = new URL(request.url);
  const title = (url.searchParams.get('title')||'').trim();
  const year = (url.searchParams.get('year')||'').trim();
  try{
    if(!title) return new Response(JSON.stringify({providers: []}), {
      status: 200, headers: {'Content-Type': 'application/json'},
    });
    const data = await fetchProviders(title, year);
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        // provider lineups change rarely - a day's caching is plenty and cuts the two upstream
        // TMDb calls this makes (search + providers) down to roughly one per title per day
        'Cache-Control': 'public, max-age=86400',
      },
    });
  }catch(e){
    return new Response(JSON.stringify({error: e.message || 'unexpected error'}), {
      status: e.status || 500,
      headers: {'Content-Type': 'application/json'},
    });
  }
}
