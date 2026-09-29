require('dotenv').config();
const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const rateLimit = require('express-rate-limit');
const Stripe = require('stripe');

const app = express();
const db = new Database(process.env.DB_FILE || 'data.db');
db.exec(`
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, email TEXT UNIQUE, pass TEXT, role TEXT DEFAULT 'user', credits INTEGER);
CREATE TABLE IF NOT EXISTS generations(id INTEGER PRIMARY KEY, user_id INTEGER, template TEXT, input TEXT, output TEXT, created DATETIME DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS payments(session_id TEXT PRIMARY KEY, user_id INTEGER, credits INTEGER, created DATETIME DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, v TEXT);
`);

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const ENV_MAP = { provider: 'AI_PROVIDER', api_key: 'AI_API_KEY', model: 'AI_MODEL', site_name: 'SITE_NAME', free_credits: 'FREE_CREDITS' };
const DEFAULTS = { provider: 'openrouter', model: 'openrouter/free', site_name: 'SellerCopy AI', free_credits: '5' };
const getSetting = k => db.prepare('SELECT v FROM settings WHERE k=?').get(k)?.v || process.env[ENV_MAP[k]] || DEFAULTS[k] || '';
const setSetting = (k, v) => db.prepare('INSERT INTO settings(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, String(v));

const TONES = ['Professional', 'Friendly', 'Persuasive', 'Luxury', 'Playful'];
const LANGUAGES = ['English', 'Hindi', 'Spanish', 'French', 'German', 'Portuguese', 'Arabic', 'Indonesian'];
const TEMPLATES = {
  product_description: { label: 'Product Description', task: 'Write a persuasive, benefit-led e-commerce product description with a short bullet list.' },
  amazon_listing: { label: 'Amazon Listing', task: 'Write an Amazon listing: a title (under 200 characters), 5 bullet points, and a line of backend keywords.' },
  ad_copy: { label: 'Ad Copy', task: 'Write 3 short, high-converting Facebook/Google ad copy variations.' },
  seo_meta: { label: 'SEO Title & Meta', task: 'Write an SEO title (max 60 characters) and meta description (max 155 characters) for this product page.' },
  email: { label: 'Promo Email', task: 'Write a promotional email for an online store: subject line plus body.' },
  social: { label: 'Social Captions', task: 'Write 5 engaging Instagram/TikTok captions with hashtags.' },
};
const clean = (v, n) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, n);
function buildPrompt({ template, product, features, tone, language }) {
  const t = TEMPLATES[template];
  if (!t || !clean(product, 200)) throw Object.assign(new Error('Template and product name are required'), { status: 400 });
  return `${t.task}\nProduct: ${clean(product, 200)}\nKey features: ${clean(features, 800) || 'not provided'}\nTone: ${TONES.includes(tone) ? tone : 'Professional'}\nLanguage: ${LANGUAGES.includes(language) ? language : 'English'}\nReturn only the finished copy, with no introduction or explanation.`;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function callAI(prompt) {
  const provider = getSetting('provider'), key = getSetting('api_key'), model = getSetting('model');
  if (!key) throw new Error('AI API key is not set. Admin: open Admin > Settings or edit .env');
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 60000);
      let r, text;
      if (provider === 'anthropic') {
        r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', signal: ctl.signal,
          headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model, max_tokens: 1500, messages: [{ role: 'user', content: prompt }] }) });
      } else {
        const url = provider === 'openai' ? 'https://api.openai.com/v1/chat/completions'
          : (process.env.OPENROUTER_URL || 'https://openrouter.ai/api/v1/chat/completions');
        r = await fetch(url, { method: 'POST', signal: ctl.signal,
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key, 'X-Title': getSetting('site_name') },
          body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }] }) });
      }
      clearTimeout(timer);
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { const e = new Error(d.error?.message || d.error || 'AI request failed (' + r.status + ')'); e.retry = r.status === 429 || r.status >= 500; throw e; }
      text = provider === 'anthropic' ? (d.content || []).map(c => c.text || '').join('') : d.choices?.[0]?.message?.content;
      if (!text || !text.trim()) { const e = new Error('The AI returned an empty answer, please try again'); e.retry = true; throw e; }
      return text.trim();
    } catch (e) {
      lastErr = e.name === 'AbortError' ? Object.assign(new Error('AI request timed out'), { retry: true })
        : e instanceof TypeError ? Object.assign(new Error('Could not reach the AI service (check internet / provider URL)'), { retry: true }) : e;
      if (!lastErr.retry || attempt === 2) break;
      await sleep(2500 * (attempt + 1));
    }
  }
  throw lastErr;
}

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const PACKS = { starter: { name: 'Starter', credits: 50, cents: 500 }, pro: { name: 'Pro', credits: 200, cents: 1500 }, business: { name: 'Business', credits: 600, cents: 3900 } };

app.set('trust proxy', 1);
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  if (!stripe) return res.status(400).end();
  let ev;
  try { ev = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET); }
  catch { return res.status(400).send('Bad signature'); }
  if (ev.type === 'checkout.session.completed') {
    const m = ev.data.object.metadata || {}, credits = Number(m.credits), uid = Number(m.userId);
    const done = db.prepare('INSERT OR IGNORE INTO payments(session_id,user_id,credits) VALUES(?,?,?)').run(ev.data.object.id, uid, credits);
    if (done.changes && credits > 0) db.prepare('UPDATE users SET credits=credits+? WHERE id=?').run(credits, uid);
  }
  res.json({ received: true });
});
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => { res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'SAMEORIGIN', 'Referrer-Policy': 'same-origin' }); next(); });
app.use('/api/login', rateLimit({ windowMs: 15 * 60 * 1000, max: 30 }));
app.use('/api/register', rateLimit({ windowMs: 60 * 60 * 1000, max: 20 }));
app.use('/api/generate', rateLimit({ windowMs: 60 * 1000, max: 20 }));
app.use('/api/bulk', rateLimit({ windowMs: 60 * 1000, max: 3 }));
app.use(express.static(path.join(__dirname, 'public')));

const sign = u => jwt.sign({ id: u.id, role: u.role }, JWT_SECRET, { expiresIn: '7d' });
const auth = (req, res, next) => {
  try { req.user = jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), JWT_SECRET);
    const u = db.prepare('SELECT id,role FROM users WHERE id=?').get(req.user.id);
    if (!u) throw 0; req.user.role = u.role; next(); }
  catch { res.status(401).json({ error: 'Unauthorized' }); }
};
const admin = (req, res, next) => req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Admin only' });
const wrap = fn => (req, res) => Promise.resolve(fn(req, res)).catch(e => res.status(e.status || 500).json({ error: e.message }));

app.get('/api/config', (_, res) => res.json({ siteName: getSetting('site_name') }));

app.post('/api/register', (req, res) => {
  const { email, password } = req.body;
  if (!/^\S+@\S+\.\S+$/.test(email || '') || (password || '').length < 6) return res.status(400).json({ error: 'Valid email and 6+ character password required' });
  const first = db.prepare('SELECT COUNT(*) c FROM users').get().c === 0;
  try {
    const r = db.prepare('INSERT INTO users(email,pass,role,credits) VALUES(?,?,?,?)')
      .run(email.toLowerCase(), bcrypt.hashSync(password, 10), first ? 'admin' : 'user', Number(getSetting('free_credits')) || 0);
    res.json({ token: sign({ id: r.lastInsertRowid, role: first ? 'admin' : 'user' }) });
  } catch { res.status(400).json({ error: 'Email already registered' }); }
});
app.post('/api/login', (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE email=?').get((req.body.email || '').toLowerCase());
  if (!u || !bcrypt.compareSync(req.body.password || '', u.pass)) return res.status(400).json({ error: 'Invalid credentials' });
  res.json({ token: sign(u) });
});
app.get('/api/me', auth, (req, res) => res.json(db.prepare('SELECT id,email,role,credits FROM users WHERE id=?').get(req.user.id)));
app.get('/api/templates', auth, (_, res) => res.json({
  templates: Object.entries(TEMPLATES).map(([id, t]) => ({ id, label: t.label })), tones: TONES, languages: LANGUAGES }));

const charge = uid => db.prepare('UPDATE users SET credits=credits-1 WHERE id=? AND credits>=1').run(uid).changes === 1;
const save = (uid, template, p, output) => db.prepare('INSERT INTO generations(user_id,template,input,output) VALUES(?,?,?,?)')
  .run(uid, template, clean(p.product, 200) + (p.features ? ' | ' + clean(p.features, 300) : ''), output);
const credits = uid => db.prepare('SELECT credits FROM users WHERE id=?').get(uid).credits;

app.post('/api/generate', auth, wrap(async (req, res) => {
  const prompt = buildPrompt(req.body);
  if (credits(req.user.id) < 1) return res.status(402).json({ error: 'No credits left. Buy more credits.' });
  const output = await callAI(prompt);
  charge(req.user.id); save(req.user.id, req.body.template, req.body, output);
  res.json({ output, credits: credits(req.user.id) });
}));

app.post('/api/bulk', auth, wrap(async (req, res) => {
  const rows = (req.body.rows || []).slice(0, 25);
  if (!rows.length) return res.status(400).json({ error: 'No rows provided (max 25 per batch)' });
  if (credits(req.user.id) < rows.length) return res.status(402).json({ error: `Need ${rows.length} credits, you have ${credits(req.user.id)}` });
  const results = [];
  for (const row of rows) {
    const p = { ...row, template: req.body.template, tone: req.body.tone, language: req.body.language };
    try { const output = await callAI(buildPrompt(p)); if (!charge(req.user.id)) throw new Error('No credits left'); save(req.user.id, p.template, p, output); results.push({ product: row.product, output }); }
    catch (e) { results.push({ product: row.product, output: '', error: e.message }); }
  }
  res.json({ results, credits: credits(req.user.id) });
}));

app.get('/api/history', auth, (req, res) => res.json(db.prepare('SELECT id,template,input,output,created FROM generations WHERE user_id=? ORDER BY id DESC LIMIT 200').all(req.user.id)));
app.delete('/api/history/:id', auth, (req, res) => { db.prepare('DELETE FROM generations WHERE id=? AND user_id=?').run(req.params.id, req.user.id); res.json({ ok: true }); });

app.get('/api/packs', auth, (_, res) => res.json({ enabled: !!stripe, packs: PACKS }));
app.post('/api/checkout', auth, wrap(async (req, res) => {
  const p = PACKS[req.body.pack];
  if (!stripe || !p) return res.status(400).json({ error: 'Payments not configured' });
  const session = await stripe.checkout.sessions.create({ mode: 'payment', success_url: BASE_URL + '/?paid=1', cancel_url: BASE_URL + '/',
    line_items: [{ quantity: 1, price_data: { currency: process.env.CURRENCY || 'usd', unit_amount: p.cents, product_data: { name: p.name + ' - ' + p.credits + ' credits' } } }],
    metadata: { userId: String(req.user.id), credits: String(p.credits) } });
  res.json({ url: session.url });
}));

app.get('/api/admin/users', auth, admin, (_, res) => res.json(db.prepare('SELECT id,email,role,credits FROM users').all()));
app.post('/api/admin/credits', auth, admin, (req, res) => { db.prepare('UPDATE users SET credits=credits+? WHERE id=?').run(Number(req.body.amount) || 0, req.body.id); res.json({ ok: true }); });
app.get('/api/admin/settings', auth, admin, (_, res) => res.json({ provider: getSetting('provider'), model: getSetting('model'), site_name: getSetting('site_name'),
  free_credits: getSetting('free_credits'), api_key_set: !!getSetting('api_key') }));
app.post('/api/admin/settings', auth, admin, (req, res) => {
  const b = req.body;
  if (['openrouter', 'openai', 'anthropic'].includes(b.provider)) setSetting('provider', b.provider);
  for (const k of ['model', 'site_name']) if (clean(b[k], 100)) setSetting(k, clean(b[k], 100));
  if (b.free_credits !== undefined && b.free_credits !== '') setSetting('free_credits', Math.max(0, parseInt(b.free_credits) || 0));
  if (clean(b.api_key, 300)) setSetting('api_key', clean(b.api_key, 300));
  res.json({ ok: true });
});

app.listen(process.env.PORT || 3000, () => console.log('SellerCopy AI running on http://localhost:' + (process.env.PORT || 3000)));
