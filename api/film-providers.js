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

/* TMDb lists every billing tier/storefront SKU as its own provider - "Amazon Prime Video",
   "Prime Video Channels" and "Prime Video with Ads" for one brand, "Paramount Plus",
   "Paramount Plus Amazon Channel" and "Paramount Plus with Ads" for another - technically
   accurate but reads as several unrelated services all repeating the same name. This strips the
   storefront/tier qualifier to get a brand key and keeps one representative per brand (the
   shortest/least-qualified name in the group, which is consistently the plain listing). Brands
   are never merged into each other by this - "Paramount Plus Amazon Channel" collapses down to
   "Paramount Plus", not "Amazon Prime Video", since it's a separate subscription cost on top of
   a plain Prime one even though it's bought through Amazon's storefront. */
function providerBrandKey(name){
  return name
    .replace(/\s*(Apple TV|Amazon|Roku|Google Play|Sky Store)\s*Channel\s*$/i, '')
    .replace(/\s*with Ads\s*$/i, '')
    .replace(/\s*Premium\s*$/i, '')
    .replace(/\s*Channels?\s*$/i, '')
    // TMDb isn't consistent about the "Amazon" prefix on Prime Video's own tiers (the base
    // listing has it, the Channels/with-Ads ones sometimes don't) - stripped as a leading word
    // rather than folded into the storefront-suffix regex above, since here it's part of the
    // brand name itself, not a qualifier on some other brand's listing
    .replace(/^Amazon\s+/i, '')
    .trim()
    .toLowerCase();
}
function dedupeProviders(list){
  const seenIds = new Set();
  const byBrand = new Map();
  list.forEach(p => {
    if(seenIds.has(p.provider_id)) return;
    seenIds.add(p.provider_id);
    const key = providerBrandKey(p.provider_name);
    const existing = byBrand.get(key);
    if(!existing || p.provider_name.length < existing.provider_name.length) byBrand.set(key, p);
  });
  return [...byBrand.values()]
    .sort((a,b) => (a.display_priority||0) - (b.display_priority||0))
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
