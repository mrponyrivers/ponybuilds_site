// Pony Builds — website + automatic Build Pack delivery
//
// How a sale works:
//   1. Buyer pays on a Stripe Payment Link.
//   2. Stripe sends them to  /thanks?session_id=cs_...
//      The server asks Stripe "was this paid, and for which pack?" and shows a download button.
//   3. Stripe also calls  /stripe/webhook . The server emails the buyer the same private link.
//   4. /download?session_id=cs_...  checks the payment again, then sends the pack file.
//
// Pack files live in packs/<pack>.enc, locked with PACK_KEY, so the public GitHub repo
// never exposes them. See README.md for the settings Railway needs.

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const Stripe = require('stripe');
const nodemailer = require('nodemailer');

const PORT = Number(process.env.PORT || 3000);
const SITE_URL = (process.env.SITE_URL || 'https://ponybuilds.com').replace(/\/+$/, '');
const LINK_DAYS = Number(process.env.LINK_DAYS || 30);        // how long a buyer's link keeps working
const PACKS_DIR = process.env.PACKS_DIR || path.join(__dirname, 'packs');
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'hello@ponybuilds.com';   // where buyers write for help
const MAIL_FROM = process.env.MAIL_FROM || `Pony Builds <${SUPPORT_EMAIL}>`;

// Every pack the site sells. `pack` must match the "pack" metadata on the Stripe product.
const PACKS = {
  website: { name: 'Motion Website', file: 'pony-builds-motion-website.zip' },
  bizsite: { name: 'Business Site + Payments', file: 'pony-builds-business-site.zip' },
  clipper: { name: 'Stream Clipper', file: 'pony-builds-stream-clipper.zip' },
  studio:  { name: 'AI Film Studio', file: 'pony-builds-ai-film-studio.zip' },
};

// ---------- Stripe ----------
function stripeClient() {
  if (!process.env.STRIPE_SECRET_KEY) return null;
  const opts = {};
  // Only used by the automated tests (points Stripe at a fake server).
  if (process.env.STRIPE_TEST_HOST) {
    const u = new URL(process.env.STRIPE_TEST_HOST);
    Object.assign(opts, { host: u.hostname, port: u.port, protocol: u.protocol.replace(':', '') });
  }
  return new Stripe(process.env.STRIPE_SECRET_KEY, opts);
}
const stripe = stripeClient();

const SESSION_RE = /^cs_(test|live)_[A-Za-z0-9]{10,200}$/;

function packFromProduct(product) {
  if (!product || typeof product !== 'object') return null;
  const key = (product.metadata && product.metadata.pack || '').trim().toLowerCase();
  if (PACKS[key]) return key;
  const name = (product.name || '').toLowerCase();   // fallback: match on the product name
  for (const [k, p] of Object.entries(PACKS)) if (name.includes(p.name.toLowerCase())) return k;
  return null;
}

// Returns { ok:true, pack, email, sessionId } or { ok:false, code, message }
async function checkPurchase(sessionId) {
  if (!stripe) return { ok: false, code: 503, message: `Downloads are not switched on yet. Please email ${SUPPORT_EMAIL} and I'll send your pack.` };
  if (!SESSION_RE.test(sessionId || '')) return { ok: false, code: 400, message: 'This link is not complete. Use the link from your email or checkout.' };
  let s;
  try {
    s = await stripe.checkout.sessions.retrieve(sessionId, { expand: ['line_items.data.price.product'] });
  } catch (e) {
    console.error('[stripe] could not load session', sessionId.slice(0, 16), e.message);
    return { ok: false, code: 404, message: `I couldn't find that purchase. Use the link from your email, or email ${SUPPORT_EMAIL}.` };
  }
  const paid = s.status === 'complete' && (s.payment_status === 'paid' || s.payment_status === 'no_payment_required');
  if (!paid) return { ok: false, code: 402, message: 'This payment hasn\'t gone through yet. If you were charged, refresh in a minute.' };
  const ageDays = (Date.now() / 1000 - s.created) / 86400;
  if (ageDays > LINK_DAYS) return { ok: false, code: 410, message: `This link was for ${LINK_DAYS} days and has run out. Email ${SUPPORT_EMAIL} with your receipt and I'll send a new one.` };
  const items = (s.line_items && s.line_items.data) || [];
  const pack = items.map(i => packFromProduct(i.price && i.price.product)).find(Boolean);
  if (!pack) {
    console.error('[stripe] paid session has no known pack', sessionId.slice(0, 16));
    return { ok: false, code: 404, message: `Your payment went through, but I couldn't match it to a pack. Email ${SUPPORT_EMAIL} and I'll sort it out today.` };
  }
  const email = (s.customer_details && s.customer_details.email) || s.customer_email || null;
  return { ok: true, pack, email, sessionId };
}

// ---------- pack files (AES-256-GCM: [12-byte IV][16-byte tag][data]) ----------
function packKey() {
  const raw = process.env.PACK_KEY || '';
  const key = Buffer.from(raw, 'base64');
  return key.length === 32 ? key : null;
}
function readPack(pack) {
  const key = packKey();
  const file = path.join(PACKS_DIR, `${pack}.enc`);
  if (!key || !fs.existsSync(file)) return null;
  const buf = fs.readFileSync(file);
  const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]);
}

// ---------- email ----------
let mailer = null;
if (process.env.SMTP_URL === 'json') mailer = nodemailer.createTransport({ jsonTransport: true }); // tests
else if (process.env.SMTP_URL) mailer = nodemailer.createTransport(process.env.SMTP_URL);
const sentEmails = new Set(); // stops a double email if Stripe sends the same event twice

function downloadLink(sessionId) { return `${SITE_URL}/thanks?session_id=${encodeURIComponent(sessionId)}`; }

async function sendPackEmail({ email, pack, sessionId }) {
  if (!mailer || !email || sentEmails.has(sessionId)) return false;
  const p = PACKS[pack];
  const link = downloadLink(sessionId);
  const info = await mailer.sendMail({
    from: MAIL_FROM,
    to: email,
    subject: `Your ${p.name} Build Pack is ready`,
    text: `Thanks for buying the ${p.name} Build Pack.\n\nDownload it here:\n${link}\n\nThis link is just for you and works for ${LINK_DAYS} days. Download the pack and keep the file.\n\nStart with START_HERE.pdf inside the zip.\n\nQuestions? Just reply to this email.\n\nPony\nponybuilds.com`,
    html: emailHtml(p.name, link),
  });
  sentEmails.add(sessionId);
  if (process.env.SMTP_URL === 'json') console.log('[mail]', info.message);
  return true;
}

function emailHtml(name, link) {
  return `<!doctype html><html><body style="margin:0;background:#000;padding:32px 16px;font-family:Menlo,Consolas,monospace;color:#f1f5f1">
<table role="presentation" width="100%" style="max-width:560px;margin:0 auto;border:1px solid #123d1e;border-left:3px solid #39ff6a;background:#000">
<tr><td style="padding:28px 26px">
<p style="margin:0 0 6px;color:#39ff6a;font-size:13px">&gt; order --complete</p>
<h1 style="margin:0 0 14px;font-family:Impact,'Anton',sans-serif;font-weight:400;font-size:34px;letter-spacing:.01em;color:#fff">YOUR ${esc(name).toUpperCase()} PACK IS READY</h1>
<p style="margin:0 0 22px;color:#8b968e;font-size:15px;line-height:1.6">Thanks for buying. This link is just for you and works for ${LINK_DAYS} days. Download the pack and keep the file.</p>
<a href="${esc(link)}" style="display:inline-block;background:#39ff6a;color:#000;font-weight:800;text-decoration:none;padding:14px 22px;font-size:15px">Download your pack</a>
<p style="margin:24px 0 0;color:#8b968e;font-size:13px;line-height:1.6">Start with START_HERE.pdf inside the zip. Questions? Just reply to this email.<br><br>Pony · <a href="${SITE_URL}" style="color:#39ff6a">ponybuilds.com</a></p>
</td></tr></table></body></html>`;
}

// ---------- pages ----------
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function page(title, body) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)} — Pony Builds</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Anton&family=JetBrains+Mono:wght@400;700;800&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#000;color:#f1f5f1;font-family:'JetBrains Mono',ui-monospace,Menlo,monospace;min-height:100svh;display:flex;flex-direction:column}
a{color:inherit}
header{padding:18px clamp(18px,4vw,48px)}
.mark{display:inline-flex;align-items:center;gap:10px;text-decoration:none}
.mark b{font-family:Anton,Impact,sans-serif;font-weight:400;font-size:22px;color:#000;background:#39ff6a;padding:2px 7px 0;line-height:1.25}
.mark span{font-family:Anton,Impact,sans-serif;font-size:20px;letter-spacing:.04em}
main{flex:1;display:flex;align-items:center;justify-content:center;padding:24px clamp(18px,4vw,48px) 64px}
.card{max-width:620px;width:100%;border:1px solid #123d1e;border-left:3px solid #39ff6a;padding:clamp(24px,5vw,44px)}
.prompt{color:#39ff6a;font-size:14px;margin-bottom:10px}.prompt::before{content:'> '}
h1{font-family:Anton,Impact,sans-serif;font-weight:400;font-size:clamp(36px,7vw,58px);line-height:1.02;letter-spacing:.01em;margin-bottom:16px}
p{color:#8b968e;font-size:15px;line-height:1.65;margin-bottom:14px}
p strong{color:#f1f5f1}
.btn{display:inline-block;margin:10px 0 22px;background:#39ff6a;color:#000;font-weight:800;text-decoration:none;padding:15px 24px;font-size:16px}
.btn:hover{background:#f1f5f1}
ol{margin:4px 0 0 20px;color:#f1f5f1;font-size:14px;line-height:1.9}
.err{border-left-color:#ff4d4d}.err .prompt{color:#ff4d4d}
</style></head><body>
<header><a class="mark" href="/"><b>PB</b><span>PONY BUILDS</span></a></header>
<main>${body}</main></body></html>`;
}

function errorPage(res, r) {
  res.status(r.code).send(page('Download', `<div class="card err"><p class="prompt">error</p><h1>Hold on</h1><p>${esc(r.message)}</p><p><a href="/">Back to ponybuilds.com</a></p></div>`));
}

// ---------- app ----------
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

// Stripe needs the raw body to check the signature, so this route comes before any JSON parsing.
app.post('/stripe/webhook', express.raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!stripe || !secret) return res.status(503).send('webhook not configured');
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], secret);
  } catch (e) {
    console.warn('[webhook] bad signature:', e.message);
    return res.status(400).send('bad signature');
  }
  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    const sessionId = event.data.object.id;
    try {
      const r = await checkPurchase(sessionId);
      if (!r.ok) {
        console.log('[webhook] not delivering', sessionId.slice(0, 16), r.code);
        return res.json({ received: true, delivered: false });
      }
      const sent = await sendPackEmail(r);
      console.log(`[webhook] ${r.pack} sold, email ${sent ? 'sent' : 'skipped'}`);
      return res.json({ received: true, delivered: true, emailed: sent });
    } catch (e) {
      console.error('[webhook] failed', e.message);
      return res.status(500).send('try again'); // Stripe will retry
    }
  }
  res.json({ received: true });
});

app.get('/thanks', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const r = await checkPurchase(String(req.query.session_id || ''));
  if (!r.ok) return errorPage(res, r);
  const p = PACKS[r.pack];
  const dl = `/download?session_id=${encodeURIComponent(r.sessionId)}`;
  const emailed = mailer && r.email ? `<p>I also emailed this link to <strong>${esc(r.email)}</strong>.</p>` : '';
  res.send(page('Your pack', `<div class="card">
<p class="prompt">order --complete</p>
<h1>Your ${esc(p.name)} pack is ready</h1>
<p>Thanks for buying. Download it now and keep the file. This page works for ${LINK_DAYS} days, so bookmark it if you want to come back.</p>
<a class="btn" href="${dl}">Download your pack (.zip)</a>
${emailed}
<p><strong>What to do next</strong></p>
<ol><li>Unzip the file.</li><li>Open START_HERE.pdf.</li><li>Follow the build video step by step.</li></ol>
<p style="margin-top:18px">Questions? Email <a href="mailto:${esc(SUPPORT_EMAIL)}">${esc(SUPPORT_EMAIL)}</a>.</p>
</div>`));
});

app.get('/download', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const r = await checkPurchase(String(req.query.session_id || ''));
  if (!r.ok) return errorPage(res, r);
  let data;
  try { data = readPack(r.pack); } catch (e) { console.error('[download] could not unlock pack', r.pack, e.message); }
  if (!data) {
    console.error('[download] pack file missing or PACK_KEY wrong:', r.pack);
    return errorPage(res, { code: 503, message: `Your payment is confirmed, but the file isn't ready on my side. Email ${SUPPORT_EMAIL} and I'll send it right away.` });
  }
  console.log(`[download] ${r.pack} ${r.sessionId.slice(0, 16)}…`);
  res.set('Content-Type', 'application/zip');
  res.set('Content-Disposition', `attachment; filename="${PACKS[r.pack].file}"`);
  res.send(data);
});

app.get('/healthz', (req, res) => res.json({
  ok: true,
  stripe: !!stripe,
  stripe_mode: !process.env.STRIPE_SECRET_KEY ? 'off' : (/^(sk|rk)_live_/.test(process.env.STRIPE_SECRET_KEY) ? 'live' : 'test'),
  webhook: !!process.env.STRIPE_WEBHOOK_SECRET,
  email: !!mailer,
  packs_unlocked: Object.keys(PACKS).filter(k => { try { return !!readPack(k); } catch { return false; } }),
}));

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.use((req, res) => res.status(404).send(page('Not found', '<div class="card err"><p class="prompt">404</p><h1>Nothing here</h1><p><a href="/">Back to ponybuilds.com</a></p></div>')));

if (require.main === module) {
  app.listen(PORT, () => console.log(`Pony Builds on :${PORT} — stripe ${stripe ? 'on' : 'off'}, email ${mailer ? 'on' : 'off'}`));
}
module.exports = { app, checkPurchase, readPack, PACKS };
