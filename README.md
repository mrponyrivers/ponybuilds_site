# Pony Builds — ponybuilds.com

The website plus automatic Build Pack delivery. Runs on Railway from this repo.

## How a sale works
1. The buyer pays on a Stripe Payment Link.
2. Stripe sends them to `/thanks?session_id=...`. The server checks with Stripe that it's paid and which pack it is, then shows a download button.
3. Stripe also calls `/stripe/webhook`, and the server emails the buyer the same private link (if email is set up).
4. `/download?session_id=...` checks the payment again, then sends the zip. Links work for 30 days.

Pack files sit in `packs/<pack>.enc`, locked with `PACK_KEY`, so nobody can grab them from this public repo.

## Files
- `public/index.html` — the website
- `server.js` — the server (site, thanks page, downloads, webhook)
- `packs/` — locked pack files
- `scripts/lock-pack.js` — locks a new pack zip
- `test/` — `npm test` runs the whole flow against a fake Stripe

## Railway settings (Variables tab)
| Name | What | Needed |
|---|---|---|
| `STRIPE_SECRET_KEY` | Stripe → Developers → API keys → Secret key (`sk_test_...` for testing, `sk_live_...` for real sales) | yes |
| `STRIPE_WEBHOOK_SECRET` | Stripe → Developers → Webhooks → your endpoint → Signing secret (`whsec_...`) | for emails |
| `PACK_KEY` | The key the pack files were locked with | yes |
| `SMTP_URL` | Email login, e.g. `smtps://you%40gmail.com:APP_PASSWORD@smtp.gmail.com:465` | for emails |
| `MAIL_FROM` | e.g. `Pony Builds <you@gmail.com>` | for emails |
| `SUPPORT_EMAIL` | Where buyers write for help (default hello@ponybuilds.com) | optional |

Check the setup at **ponybuilds.com/healthz**.

## Stripe setup per pack
1. Product with metadata `pack` = `website` / `bizsite` / `clipper` / `studio`.
2. Payment Link → After payment → **Redirect** to `https://ponybuilds.com/thanks?session_id={CHECKOUT_SESSION_ID}`
3. Paste the Payment Link into `PB.packs` in `public/index.html`.
4. One webhook for everything: `https://ponybuilds.com/stripe/webhook`, event `checkout.session.completed`.

## Add a new pack
```
PACK_KEY=... node scripts/lock-pack.js clipper path/to/pony-builds-stream-clipper.zip
git add packs/clipper.enc && git commit -m "Add Stream Clipper pack" && git push
```
