/* Film search for the Films tab's Log Film form, served from Vercel alongside the app (same
   reasoning as api/game-search.js: same-origin, no CORS header to add, ships with an ordinary
   `git push`, no separate deploy). Backed by TMDb (themoviedb.org/documentation/api), which has
   a real free tier and a plain API-key-in-query-string auth model - no OAuth dance.

   Needs a free TMDb API key set as the TMDB_API_KEY environment variable on this Vercel
   project - see psn-proxy/README.md. Without it every request 401s from TMDb's side, not this
   file's. */
export const config = { runtime: 'edge' };

const TMDB_SEARCH = 'https://api.themoviedb.org/3/search/movie';
const TMDB_IMG = 'https://image.tmdb.org/t/p/w342';

function apiKey(){
  const key = process.env.TMDB_API_KEY;
  if(!key) throw Object.assign(new Error("Film search isn't configured - add TMDB_API_KEY as a Vercel environment variable"), {status:503});
  return key;
}

/* id is cast to a string - TMDb returns it as a number, but every id elsewhere in this app
   (Board Games' BGG ids included) is a string, and onclick handlers round-trip ids through HTML
   attributes as strings anyway, so a stray === comparison against the number would quietly
   always fail. */
function simplify(m){
  return {
    id: String(m.id),
    title: m.title || m.original_title || '',
    year: (m.release_date||'').slice(0,4) || null,
    image: m.poster_path ? TMDB_IMG + m.poster_path : '',
  };
}

async function searchMovies(q){
  if(!q) return {films: []};
  const key = apiKey();
  const url = new URL(TMDB_SEARCH);
  url.searchParams.set('api_key', key);
  url.searchParams.set('query', q);
  url.searchParams.set('include_adult', 'false');
  const res = await fetch(url.toString());
  if(!res.ok) throw new Error('Film search returned '+res.status);
  const data = await res.json();
  return {films: (data.results||[]).map(simplify).filter(f=>f.title)};
}

export default async function handler(request){
  const url = new URL(request.url);
  const q = (url.searchParams.get('q')||'').trim();
  try{
    const data = await searchMovies(q);
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
