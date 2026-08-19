/* Board Games data, served from Vercel instead of the Cloudflare Worker (psn-proxy/) the rest
   of the proxy endpoints use. BoardGameGeek's XML API 401s every request from that Worker
   regardless of what headers are sent - the general consensus is BGG's API itself is fine, so
   that pointed at Cloudflare Workers' own network being blocked by BGG's side, not anything
   fixable in the request. This runs on Vercel's network instead (already hosting this app, no
   new account needed) on the chance that isn't blocked the same way.

   Deliberately not proxied through psn-proxy/worker.js: this endpoint is same-origin with the
   app itself (served from /api/board-games on this same Vercel deployment), so there's no CORS
   header to add and no separate deploy step - it goes out with every ordinary `git push`.

   If this is STILL 401ing after landing here too, BGG (or whatever's fronting it) is blocking
   on something no proxy's network location can route around, and Board Games may need a
   different data source entirely. */
export const config = { runtime: 'edge' };

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

const BGG = 'https://boardgamegeek.com/xmlapi2';
const BGG_UA = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/xml,application/xml,text/html,*/*',
  'Accept-Language': 'en-US,en;q=0.9',
};
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

export default async function handler(request){
  const url = new URL(request.url);
  const q = (url.searchParams.get('q')||'').trim();
  try{
    const data = await fetchBoardGames(q);
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        // BGG's hot list barely moves day to day; a search is worth re-checking sooner
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
