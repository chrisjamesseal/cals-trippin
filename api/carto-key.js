/* Hands the client its own CartoDB API key for the Voyager map tiles the Itinerary route map
   and Next Trip dashboard preview use, read from the CARTO_API_KEY Vercel environment variable
   rather than pasted into index.html directly - this is a static site with no build step, so a
   Vercel env var never reaches a plain <script> on its own; this one small endpoint is what
   actually gets it there.

   Not a secret in the way an upstream API token is: it only ever gates map tile *images*, the
   same way a client-side Google Maps key does, and CartoDB's own key setup lets you restrict it
   to specific domains - so handing it back to the browser here is the same trust boundary the
   tiles it unlocks already sit at (a public GET, cacheable, no per-user data). Missing/blank
   just means the map still loads, watermarked, same as today. */
export const config = { runtime: 'edge' };

export default async function handler(){
  return new Response(JSON.stringify({key: process.env.CARTO_API_KEY || ''}), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      // this only ever changes when someone edits the Vercel env var, not per request - a short
      // cache still means a stale key can take a few minutes to clear after being rotated
      'Cache-Control': 'public, max-age=300',
    },
  });
}
