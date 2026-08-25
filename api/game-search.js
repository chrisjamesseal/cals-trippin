/* Upcoming/new video game search for the Games tab's Wishlist, served from Vercel alongside
   the app (same reasoning as api/board-games.js: same-origin, no CORS header to add, ships
   with an ordinary `git push`, no separate deploy). Backed by RAWG (rawg.io/apidocs), which
   has a real free tier and a plain API-key-in-query-string auth model - no OAuth dance, no
   registered-app Bearer token the way BGG now needs.

   Needs a free RAWG API key set as the RAWG_API_KEY environment variable on this Vercel
   project - see psn-proxy/README.md. Without it every request 401s from RAWG's side, not this
   file's. */
export const config = { runtime: 'edge' };

const RAWG = 'https://api.rawg.io/api/games';
const PAGE_SIZE = 24;

function apiKey(){
  const key = process.env.RAWG_API_KEY;
  if(!key) throw Object.assign(new Error("Game search isn't configured - add RAWG_API_KEY as a Vercel environment variable"), {status:503});
  return key;
}
function isoDate(d){ return d.toISOString().slice(0,10); }

/* trims RAWG's much larger payload down to what the Wishlist card actually shows. id is cast
   to a string - RAWG returns it as a number, but every id elsewhere in this app (Board Games'
   BGG ids included) is a string, and onclick handlers round-trip ids through HTML attributes
   as strings anyway, so a stray === comparison against the number would quietly always fail. */
function simplify(game){
  return {
    id: String(game.id),
    name: game.name,
    image: game.background_image || '',
    released: game.released || '',
    tba: !!game.tba,
    platforms: (game.platforms||[]).map(p => p.platform && p.platform.name).filter(Boolean),
    rating: game.rating || null,
  };
}

async function fetchGames(q){
  const key = apiKey();
  const url = new URL(RAWG);
  url.searchParams.set('key', key);
  url.searchParams.set('page_size', String(PAGE_SIZE));
  // this app only tracks a PlayStation library, so upcoming/search results stay PlayStation-only
  // too - RAWG's parent platform id 2 covers the whole PS1-PS5 family in one filter
  url.searchParams.set('parent_platforms', '2');
  if(q){
    // a plain name search, newest/most relevant first - the "gta vi" case
    url.searchParams.set('search', q);
    url.searchParams.set('ordering', '-released');
  }else{
    // no query: what's coming - unreleased or released in roughly the last month, ranked by
    // how much attention RAWG's own community is giving it right now
    const today = new Date();
    const from = new Date(today); from.setMonth(from.getMonth()-1);
    const to = new Date(today); to.setFullYear(to.getFullYear()+2);
    url.searchParams.set('dates', isoDate(from)+','+isoDate(to));
    url.searchParams.set('ordering', '-added');
  }
  const res = await fetch(url.toString());
  if(!res.ok) throw new Error('Game search returned '+res.status);
  const data = await res.json();
  return {games: (data.results||[]).map(simplify)};
}

export default async function handler(request){
  const url = new URL(request.url);
  const q = (url.searchParams.get('q')||'').trim();
  try{
    const data = await fetchGames(q);
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        // the coming-soon list barely moves hour to hour; a search is worth re-checking sooner
        'Cache-Control': 'public, max-age=' + (q ? 3600 : 21600),
      },
    });
  }catch(e){
    return new Response(JSON.stringify({error: e.message || 'unexpected error'}), {
      status: e.status || 500,
      headers: {'Content-Type': 'application/json'},
    });
  }
}
