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
    rating: game.rating || null,
  };
}

async function fetchGames(q){
  const key = apiKey();
  const url = new URL(RAWG);
  url.searchParams.set('key', key);
  url.searchParams.set('page_size', String(PAGE_SIZE));
  // this app only tracks a PS5 library, so upcoming/search results stay PS5-only too - RAWG's
  // platform id 187 is PS5 specifically (parent_platforms=2 would pull in the whole PS1-PS5
  // family, PC/Xbox cross-releases included, neither of which the Add Game modal shows)
  url.searchParams.set('platforms', '187');
  if(q){
    // a plain name search, newest/most relevant first - the "gta vi" case
    url.searchParams.set('search', q);
    url.searchParams.set('ordering', '-released');
  }else{
    // no query: a general "what's worth adding" browse, not just new/upcoming - no date window,
    // so an already-released game (a classic you never got around to, not just this month's
    // releases) shows up too, ranked by RAWG's own all-time library-add count
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
        // the default browse barely moves hour to hour; a search is worth re-checking sooner
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
