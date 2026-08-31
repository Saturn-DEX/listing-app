# Deploying the Listing App to Cloudflare

Step-by-step guide for putting the app on Cloudflare:

| Piece | Hosting | URL |
| --- | --- | --- |
| Static site (`public/`) | Cloudflare Pages | `listing.saturndex.org` |
| OAuth exchange (`worker/exchange.js`) | Cloudflare Worker | `oauth-exchange.saturndex.org` |

Everything is deployed from the terminal with `wrangler`. The only dashboard step
is attaching the custom domains (Cloudflare doesn't expose that in the CLI) — it is
two clicks, or you can use the REST API alternative if you prefer scripting.

> The app has no build step. `public/` is the deployable site directory.

---

## 0. Prerequisites

- [ ] A Cloudflare account (free tier is fine).
- [ ] The `saturndex.org` domain **in Cloudflare** (DNS managed by CF) — enables
      the custom domains + automatic DNS/HTTPS. If the zone lives elsewhere you can
      still deploy and point DNS records manually; the curl verification below
      works either way.
- [ ] The repo cloned locally and `wrangler` installed:
      ```sh
      git clone https://github.com/Saturn-DEX/listing-app.git
      cd listing-app
      npm i -g wrangler        # or: npx wrangler ... below works too
      wrangler login           # opens browser, authorizes your account
      wrangler whoami          # confirm you're logged in as the right account
      ```
- [ ] A GitHub OAuth App **Client ID + Client Secret** (created in step 1).
      Have them handy — you'll paste them twice.

## 1. Create the GitHub OAuth App

1. GitHub → **Settings → Developer settings → OAuth Apps → New OAuth App**.
2. Application name: anything, e.g. `SaturnDEX Listing`.
3. Homepage URL: `https://listing.saturndex.org`
4. Authorization callback URL: `https://listing.saturndex.org` — **exact match is
   required**. The app sends `redirect_uri = window.location.origin` explicitly,
   and GitHub rejects any callback URL that doesn't equal the registered one.
5. Register, then copy the **Client ID** and click **Generate a new client secret**
   and copy that too.

> **Testing on `*.pages.dev` first?** The callback must match the origin the app
> actually runs on. While the custom domain isn't live yet, temporarily set the
> callback to your future Pages URL (e.g. `https://listing-app.pages.dev`), then
> switch it back to `https://listing.saturndex.org` in step 6.

## 2. Configure the repo (one-time)

All of this is already done in the repo — verify, don't redo:

- `public/index.html` + `public/js/app.js` — the static site (moved from the root
  so `wrangler pages deploy` uploads only site files; `wrangler pages deploy` has
  no exclude option, so the worker source in `/worker` must not be in the upload dir).
- `wrangler.toml` — worker config (name `oauth-exchange`, env bindings, optional route).
- `public/js/app.js` → `GITHUB_CONFIG.clientId` — **paste your real Client ID here**
  (it is public, safe to commit). `exchangeUrl`, `cdnBase`, `rawBase`,
  `owner`/`repo` are already correct.
- `README.md` → points here.

```js
// public/js/app.js
const GITHUB_CONFIG = {
    owner: 'Saturn-DEX',
    repo: 'assets',
    clientId: '<YOUR-OAUTH-APP-CLIENT-ID>',   // ← paste here
    exchangeUrl: 'https://oauth-exchange.saturndex.org/exchange',
    // ...
};
```

## 3. Deploy the OAuth Worker

From the repo root (uses `wrangler.toml`):

```sh
wrangler deploy
```

Then set the **secret** (only this is secret; `GITHUB_CLIENT_ID` and
`ALLOWED_ORIGIN` are plain vars already in `wrangler.toml`):

```sh
wrangler secret put GITHUB_CLIENT_SECRET
# paste the OAuth App client secret when prompted
```

This deploys to `<your-subdomain>.workers.dev`. The custom domain
`oauth-exchange.saturndex.org` binding is configured in the cloudflare account —
see step 5 below for both domains.

**Verify the worker is alive:**

```sh
# CORS preflight → expect 204 with Access-Control-Allow-Origin for the listing origin
curl -i -X OPTIONS <worker-url>/exchange

# missing code → expect 400 { "error": "Missing \"code\" in request body" }
curl -i -X POST <worker-url>/exchange -H 'Content-Type: application/json' -d '{}'

# bogus code → expect 400 with GitHub's error (proves credentials reach GitHub)
curl -i -X POST <worker-url>/exchange -H 'Content-Type: application/json' -d '{"code":"not-a-real-code"}'
```

Replace `<worker-url>` with `https://oauth-exchange.saturndex.org` once the custom
domain is live, or the `*.workers.dev` URL while testing.

## 4. Deploy the site to Cloudflare Pages

```sh
# one time: create the project (production branch = main)
wrangler pages project create listing-app --production-branch main

# every deploy: upload the static site
wrangler pages deploy public --project-name listing-app --branch main
```

The site is now live at `https://listing-app.pages.dev`.

- Direct-upload projects deploy **only when you run the command** — pushing to
  GitHub does not auto-deploy (that requires the dashboard's Git integration,
  which this CLI-only setup deliberately avoids). Deploy after every change:

  ```sh
  wrangler pages deploy public --project-name listing-app --branch main
  ```

- Previews: deploy with `--branch <anything-else>` to get a preview URL on that branch.

## 5. Attach the custom domains

Cloudflare only exposes this in the dashboard (or the REST API) — there is no
`wrangler pages domain` command.

1. **Listing site** — dashboard: **Workers & Pages → `listing-app` → Custom domains
   → Set up a domain** → `listing.saturndex.org` → Continue. With `saturndex.org`
   on Cloudflare DNS the record is created automatically; otherwise add a `CNAME`
   `listing → listing-app.pages.dev` manually.

2. **OAuth worker (free plan — use Route, not Custom Domain)**

   > **Custom Domains require a paid Workers plan.** On the free plan, use a
   > **Route** instead. The dashboard tab is now **Settings → Domains & Routes**
   > (the old "Triggers" tab was removed).

   **Dashboard method:**
   1. [Workers & Pages](https://dash.cloudflare.com/?to=/:account/workers-and-pages)
      → click **`oauth-exchange`**
   2. **Settings** → **Domains & Routes** → **Add** → **Route**
   3. Zone: `saturndex.org`, pattern: `oauth-exchange.saturndex.org/*`
   4. Click **Add route**

   > You also need a **proxied DNS record** for the subdomain. Go to
   > **DNS → Records** → **Add record**: Type `CNAME`, Name `oauth-exchange`,
   > Target `<your-subdomain>.workers.dev`, Proxy **ON** (orange cloud).
   > Wrangler auto-creates this if you use Option B below.

   **Wrangler method (recommended — repeatable & committed):**

   Uncomment the `routes` block in `wrangler.toml`:

   ```toml
   routes = [
     { pattern = "oauth-exchange.saturndex.org/*", zone_name = "saturndex.org" }
   ]
   ```

   Then deploy — wrangler creates the route + DNS record automatically:

   ```sh
   wrangler deploy
   ```

Prefer scripting? Same calls via the API (token needs `Account > Cloudflare Pages >
Edit`):

```sh
curl -X POST "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/pages/projects/listing-app/domains" \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"listing.saturndex.org"}'
```

## 6. Final wiring

1. Make sure `public/js/app.js` has the real `GITHUB_CLIENT_ID` (step 2), then
   redeploy the site: `wrangler pages deploy public --project-name listing-app --branch main`.
2. In the GitHub OAuth App settings, confirm the callback URL is
   `https://listing.saturndex.org` — exactly, no trailing slash, no query string.
3. Rotate-check the exchange endpoint once more against the custom domain
   (the curl commands from step 3, with `<worker-url>` =
   `https://oauth-exchange.saturndex.org`).

Also confirm the `assets` repo side is ready (per README): GitHub Pages on
`Saturn-DEX/assets` `main` with custom domain `github.saturndex.org`, the
`validate-pr.yml` workflow, and branch protection on `main`.

## 7. Verify end-to-end

- [ ] `https://listing.saturndex.org` loads, token list renders (browse tab),
      chain filter + search work.
- [ ] **Connect GitHub** → OAuth page → authorize with `public_repo` scope →
      redirect back to the site.
- [ ] The exchange URL in `js/app.js` must return the token (devtools: network tab
      shows `POST oauth-exchange.saturndex.org/exchange` → `200` with
      `access_token`; never shows the client secret).
- [ ] Submit tab: fill a token, observe fork → commit → PR creation against
      `Saturn-DEX/assets` `main`. You can abort before merge — the PR simply stays
      open for review.
- [ ] CORS sanity: `curl -i -X OPTIONS https://oauth-exchange.saturndex.org/exchange`
      returns `Access-Control-Allow-Origin: https://listing.saturndex.org` (204).
      If you deployed from a `*.pages.dev` preview instead, set `ALLOWED_ORIGIN`
      in `wrangler.toml` to that origin and `wrangler deploy` again.

## 8. Day-to-day operations

| Task | Command |
| --- | --- |
| Deploy site changes | `wrangler pages deploy public --project-name listing-app --branch main` |
| Deploy worker changes | `wrangler deploy` |
| Rotate GitHub client secret | `wrangler secret put GITHUB_CLIENT_SECRET` |
| New environment var | edit `[vars]` in `wrangler.toml`, then `wrangler deploy` |
| Check worker logs | `wrangler tail` |

## Troubleshooting

- **OAuth "redirect_uri mismatch"** — callback in the OAuth App settings must be
  byte-for-byte equal to the origin you're running on (custom domain → custom
  domain; pages.dev preview → pages.dev URL).
- **`Access-Control-Allow-Origin` wrong** — the worker's `ALLOWED_ORIGIN` (default
  `https://listing.saturndex.org`) must equal the page's origin; update
  `wrangler.toml` → `wrangler deploy`.
- **Worker returns 500 "not configured"** — `GITHUB_CLIENT_ID` var or
  `GITHUB_CLIENT_SECRET` secret is unset: `wrangler secret put …` / edit `[vars]`.
- **Token list / logos broken** — browse uses `github.saturndex.org`
  (`cdnBase`) with a fallback to `raw.githubusercontent.com`; confirm the assets
  repo's GitHub Pages + custom domain are configured (README §5).
- **401 from GitHub during submit** — `public_repo` scope missing on the OAuth app,
  or the token exchange worked but the fork/PR endpoint returned 401 (check
  `wrangler tail` for the exchange response).
