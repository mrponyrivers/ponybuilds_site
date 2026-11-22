// End-to-end test of the delivery flow with a fake Stripe API.
// Run: npm test
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const Stripe = require('stripe');

const ROOT = path.join(__dirname, '..');
const now = () => Math.floor(Date.now() / 1000);
const product = (meta, name = 'Motion Website — Build Pack') => ({ id: 'prod_1', object: 'product', name, metadata: meta });
const session = (id, o = {}) => ({
  id, object: 'checkout.session', status: 'complete', payment_status: 'paid', created: now() - 60,
  customer_details: { email: 'buyer@example.com' },
  line_items: { object: 'list', data: [{ id: 'li_1', object: 'item', price: { id: 'price_1', object: 'price', product: product({ pack: 'website' }) } }] },
  ...o,
});
const SESSIONS = {
  cs_test_paidOK1234567890: session('cs_test_paidOK1234567890'),
  cs_test_unpaid1234567890: session('cs_test_unpaid1234567890', { status: 'open', payment_status: 'unpaid' }),
  cs_test_oldone1234567890: session('cs_test_oldone1234567890', { created: now() - 40 * 86400 }),
  cs_test_nopack1234567890: session('cs_test_nopack1234567890', { line_items: { object: 'list', data: [{ price: { product: product({}, 'Something else') } }] } }),
  cs_test_byname1234567890: session('cs_test_byname1234567890', { line_items: { object: 'list', data: [{ price: { product: product({}, 'Motion Website') } }] } }),
  cs_test_free01234567890: session('cs_test_free01234567890', { payment_status: 'no_payment_required' }),
};

let fake, srv, base, logs = '', tmp, zipBytes;
const KEY = crypto.randomBytes(32).toString('base64');
const WHSEC = 'whsec_test_' + crypto.randomBytes(16).toString('hex');

test.before(async () => {
  // fake Stripe
  fake = http.createServer((req, res) => {
    const m = req.url.match(/^\/v1\/checkout\/sessions\/([^?]+)/);
    const s = m && SESSIONS[decodeURIComponent(m[1])];
    res.setHeader('Content-Type', 'application/json');
    if (!s) { res.statusCode = 404; return res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'No such checkout.session' } })); }
    assert.match(req.url, /expand/);
    res.end(JSON.stringify(s));
  }).listen(0);
  await new Promise(r => fake.once('listening', r));

  // a pack file, locked with the test key
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-'));
  zipBytes = crypto.randomBytes(5000);
  fs.writeFileSync(path.join(tmp, 'p.zip'), zipBytes);
  execFileSync('node', [path.join(ROOT, 'scripts/lock-pack.js'), 'website', path.join(tmp, 'p.zip')], { env: { ...process.env, PACK_KEY: KEY, PACKS_DIR: tmp } });

  const port = 4100 + Math.floor(Math.random() * 500);
  srv = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), STRIPE_SECRET_KEY: 'sk_test_fake', STRIPE_TEST_HOST: `http://127.0.0.1:${fake.address().port}`,
      STRIPE_WEBHOOK_SECRET: ' ' + WHSEC + '\n', PACK_KEY: KEY, PACKS_DIR: tmp, SMTP_URL: 'json', SITE_URL: 'https://ponybuilds.com' },
  });
  srv.stdout.on('data', d => { logs += d; });
  srv.stderr.on('data', d => { logs += d; });
  base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) { try { await fetch(base + '/healthz'); return; } catch { await new Promise(r => setTimeout(r, 100)); } }
  throw new Error('server did not start\n' + logs);
});
test.after(() => { srv && srv.kill(); fake && fake.close(); });

test('home page still loads', async () => {
  const r = await fetch(base + '/');
  assert.equal(r.status, 200);
  assert.match(await r.text(), /PONY BUILDS|Pony Builds/);
});

test('server code and locked files are not public', async () => {
  for (const p of ['/server.js', '/packs/website.enc', '/package.json', '/scripts/lock-pack.js', '/.env']) {
    assert.equal((await fetch(base + p)).status, 404, p);
  }
});

test('healthz reports setup', async () => {
  const j = await (await fetch(base + '/healthz')).json();
  assert.deepEqual([j.stripe, j.stripe_mode, j.webhook, j.email, j.packs_unlocked], [true, 'test', true, true, ['website']]);
});

test('paid buyer: thanks page shows download, download gives the exact file', async () => {
  const t = await fetch(base + '/thanks?session_id=cs_test_paidOK1234567890');
  assert.equal(t.status, 200);
  const html = await t.text();
  assert.match(html, /Motion Website pack is ready/);
  assert.match(html, /buyer@example\.com/);
  assert.match(html, /href="\/download\?session_id=cs_test_paidOK1234567890"/);
  const d = await fetch(base + '/download?session_id=cs_test_paidOK1234567890');
  assert.equal(d.status, 200);
  assert.equal(d.headers.get('content-type'), 'application/zip');
  assert.match(d.headers.get('content-disposition'), /pony-builds-motion-website\.zip/);
  assert.ok(Buffer.from(await d.arrayBuffer()).equals(zipBytes));
});

test('100% coupon and product-name fallback also deliver', async () => {
  assert.equal((await fetch(base + '/download?session_id=cs_test_free01234567890')).status, 200);
  assert.equal((await fetch(base + '/download?session_id=cs_test_byname1234567890')).status, 200);
});

test('no download without a real, paid, recent purchase', async () => {
  const cases = {
    '': 400, 'abc': 400, 'cs_test_<script>': 400,
    cs_test_doesnotexist12345: 404, cs_test_unpaid1234567890: 402, cs_test_oldone1234567890: 410, cs_test_nopack1234567890: 404,
  };
  for (const [id, code] of Object.entries(cases)) {
    const r = await fetch(base + '/download?session_id=' + encodeURIComponent(id));
    assert.equal(r.status, code, id);
    assert.notEqual(r.headers.get('content-type'), 'application/zip');
  }
});

test('webhook: signed event emails the buyer once; forged event rejected', async () => {
  const payload = JSON.stringify({ id: 'evt_1', object: 'event', type: 'checkout.session.completed', data: { object: { id: 'cs_test_paidOK1234567890', object: 'checkout.session' } } });
  const sig = Stripe.webhooks.generateTestHeaderString({ payload, secret: WHSEC });
  const send = h => fetch(base + '/stripe/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8', 'Stripe-Signature': h }, body: payload });
  const r1 = await (await send(sig)).json();
  assert.deepEqual(r1, { received: true, delivered: true, emailed: true });
  assert.match(logs, /buyer@example\.com/);
  assert.match(logs, /Your Motion Website Build Pack is ready/);
  assert.match(logs, /https:\/\/ponybuilds\.com\/thanks\?session_id=cs_test_paidOK1234567890/);
  const r2 = await (await send(Stripe.webhooks.generateTestHeaderString({ payload, secret: WHSEC }))).json();
  assert.equal(r2.emailed, false); // Stripe retry: no second email
  const bad = await send(Stripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_wrong' }));
  assert.equal(bad.status, 400);
});
