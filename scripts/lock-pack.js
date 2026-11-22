// Locks a pack zip so it can sit in the public repo.
// Usage:  PACK_KEY=... node scripts/lock-pack.js website path/to/pack.zip
// Writes packs/<pack>.enc . The same PACK_KEY must be set in Railway.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const [pack, zip] = process.argv.slice(2);
const key = Buffer.from(process.env.PACK_KEY || '', 'base64');
if (!pack || !zip || key.length !== 32) { console.error('usage: PACK_KEY=<base64 32 bytes> node scripts/lock-pack.js <pack> <file.zip>'); process.exit(1); }
const iv = crypto.randomBytes(12);
const c = crypto.createCipheriv('aes-256-gcm', key, iv);
const body = Buffer.concat([c.update(fs.readFileSync(zip)), c.final()]);
const out = path.join(process.env.PACKS_DIR || path.join(__dirname, '..', 'packs'), `${pack}.enc`);
fs.writeFileSync(out, Buffer.concat([iv, c.getAuthTag(), body]));
console.log(`locked ${zip} -> ${path.relative(process.cwd(), out)} (${fs.statSync(out).size} bytes)`);
