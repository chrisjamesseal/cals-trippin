/* ============================================================================================
   PSN proxy for the Games tab in My Trips (../index.html)
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

export default {
  async fetch(request, env){
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
      return json({error:'not found'}, 404, env);
    }catch(e){
      return json({error: e.message || 'unexpected error'}, e.status || 500, env);
    }
  },
};
