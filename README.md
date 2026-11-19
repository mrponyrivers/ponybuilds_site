# Pony Builds — website

Wake up. Build something.

## What's here
- `index.html` — the whole site (Matrix hero, shipped builds, kits, pricing, free kit, FAQ)
- `package.json` — lets Railway serve the site
- `.gitignore`

## Launch it (record this for YouTube)

1. **GitHub** — make a new repo called `pony-builds-site`, upload these files, commit.
2. **Railway** — New Project → Deploy from GitHub repo → pick `pony-builds-site`.
   Railway sees `package.json` and runs `npm start` on its own. Wait for the green "Success".
3. **Railway → Settings → Networking → Generate Domain** — open the link. Site is live.
4. **Stripe** — Product catalog → add product "Pony Builds — Builder", $19 / month, recurring.
   Add a second product "Pony Builds — Inner Circle", $49 / month.
   For each one: Create payment link → copy the link.
5. **Paste the links** — in `index.html`, near the bottom, fill in:
   ```js
   const PB = {
     stripeBuilder: 'https://buy.stripe.com/...',
     stripeInner:   'https://buy.stripe.com/...',
     instagram:     'https://instagram.com/...'
   };
   ```
   Commit on GitHub. Railway redeploys by itself in about a minute.
6. **Your domain (optional)** — buy `ponybuilds.com` (or similar) on Porkbun,
   then Railway → Settings → Custom Domain, and copy the DNS record it gives you into Porkbun.

## Next build (episode 2)
Member access: a Stripe webhook creates the member and emails a magic login link,
then the kits page only opens for paying members. Same pattern as Always Collect.
