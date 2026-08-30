# SaturnDEX Listing App

Static web app (browse + submit) for the SaturnDEX assets listing flow.

Users visit `listing.saturndex.org`, authorize with GitHub, fill in their token
metadata, and the app opens a pull request against
[`Saturn-DEX/assets`](https://github.com/Saturn-DEX/assets) `main` (from the
user's fork). The PR is validated automatically by the `Validate Asset PR`
workflow in the assets repo and reviewed by the Saturn team before merge.

## Architecture

```
listing.saturndex.org ── Cloudflare Pages (this repo, main branch)
  app ── OAuth code → worker/exchange.js (Cloudflare Worker, holds client_secret) → access token
  app ── fork assets → token/{chain}/{addr} → PUT info.json + logo.png → PR base=main
github.saturndex.org ── GitHub Pages on Saturn-DEX/assets main ── token info.json + logos (CDN)
```

- **Token data** lives in the `assets` repo (`ethereum/0x…/`, `classic/0x…/`).
- **Logos & info.json** are served via the GitHub Pages CDN at
  `https://github.saturndex.org/{chain}/{address}/logo.png` (and `info.json`),
  falling back to `raw.githubusercontent.com`.
- **OAuth** uses a GitHub OAuth App; the code→token exchange runs in a
  Cloudflare Worker so the client secret never reaches the browser.

## Setup

### 1. GitHub OAuth App

1. GitHub → Settings → Developer settings → OAuth Apps → **New OAuth App**.
2. Homepage URL: `https://listing.saturndex.org`
3. Authorization callback URL: `https://listing.saturndex.org` (exact match —
   the app uses `window.location.origin`).
4. Requested scope: `public_repo` (fork + push + open PR).

### 2. Cloudflare Worker (OAuth exchange)

1. Create a Worker from `worker/exchange.js` (e.g. `wrangler deploy`).
2. Bindings:
   - `GITHUB_CLIENT_ID` (var)
   - `GITHUB_CLIENT_SECRET` (secret)
   - `ALLOWED_ORIGIN` (var, default `https://listing.saturndex.org`)
3. Route (optional custom domain): `https://oauth-exchange.saturndex.org/*`.

### 3. App config (`js/app.js` → `GITHUB_CONFIG`)

```js
clientId:    'YOUR-OAUTH-APP-CLIENT-ID',
exchangeUrl: 'https://oauth-exchange.saturndex.org/exchange',
```

### 4. Cloudflare Pages

1. Connect this repo (main branch), build command: none, output dir: `/`.
2. Custom domain: `listing.saturndex.org`.
3. Push to main → auto-deploys.

### 5. Prerequisites in the assets repo

- GitHub Pages enabled on `Saturn-DEX/assets` `main` with custom domain
  `github.saturndex.org` (serves token info.json + logos).
- `.github/workflows/validate-pr.yml` present on assets `main` (runs on fork
  PRs; result shown as the `Validate Asset PR` check).
- Branch protection on assets `main`: require the `Validate Asset PR` check +
  1 reviewer approval.

## Development

No build step. Serve statically (`npx serve .`) and open the page.

## Notes

- The access token is stored in `sessionStorage` only.
- PRs are created from the user's fork with `base: main` and a
  `token/{chain}/{address}` branch; re-submitting returns the already-open PR.