// GitHub OAuth code -> token exchange — Cloudflare Worker
//
// GitHub's web flow REQUIRES the OAuth App client_secret during the
// code->token exchange, and that exchange must happen server-side
// (no PKCE for GitHub OAuth Apps). This Worker keeps the secret out of
// the browser. The static listing app POSTs its `code` here and receives
// the access token.
//
// Environment (Cloudflare Worker secrets / vars):
//   GITHUB_CLIENT_ID     (required) — OAuth App client id
//   GITHUB_CLIENT_SECRET (required) — OAuth App client secret (secret binding)
//   ALLOWED_ORIGIN       (optional, default https://listing.saturndex.org)
//   GITHUB_ACCESS_TOKEN_URL (optional, default https://github.com/login/oauth/access_token)

const DEFAULT_ALLOWED_ORIGIN = 'https://listing.saturndex.org';
const DEFAULT_TOKEN_URL = 'https://github.com/login/oauth/access_token';

export default {
  async fetch(request, env) {
    const origin = env.ALLOWED_ORIGIN || DEFAULT_ALLOWED_ORIGIN;
    const cors = {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin'
    };

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    if (request.method !== 'POST') {
      return json({ error: 'Method not allowed' }, 405, cors);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Invalid JSON body' }, 400, cors);
    }

    const code = body.code;
    if (!code || typeof code !== 'string') {
      return json({ error: 'Missing "code" in request body' }, 400, cors);
    }

    if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
      return json({ error: 'Worker is not configured (missing GitHub OAuth credentials)' }, 500, cors);
    }

    const tokenUrl = env.GITHUB_ACCESS_TOKEN_URL || DEFAULT_TOKEN_URL;
    const tokenResponse = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'saturndex-listing-app'
      },
      body: JSON.stringify({
        client_id: env.GITHUB_CLIENT_ID,
        client_secret: env.GITHUB_CLIENT_SECRET,
        code
      })
    });

    const data = await tokenResponse.json();

    if (data.error || !data.access_token) {
      const message =
        data.error_description || data.error || 'Token exchange failed';
      return json({ error: message }, 400, cors);
    }

    // Return only what the app needs; never expose the secret.
    return json({
      access_token: data.access_token,
      token_type: data.token_type || 'bearer',
      scope: data.scope || ''
    }, 200, cors);
  }
};

function json(payload, status, cors) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors }
  });
}