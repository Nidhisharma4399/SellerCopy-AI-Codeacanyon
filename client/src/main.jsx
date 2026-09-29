import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';

const api = async (url, method = 'GET', body) => {
  const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (localStorage.token || '') }, body: body && JSON.stringify(body) });
  const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || 'Request failed'); return d;
};
function parseCSV(t) {
  const rows = []; let r = [], c = '', q = false;
  for (let i = 0; i < t.length; i++) { const ch = t[i];
    if (q) { if (ch === '"') { if (t[i + 1] === '"') { c += '"'; i++; } else q = false; } else c += ch; }
    else if (ch === '"') q = true; else if (ch === ',') { r.push(c); c = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && t[i + 1] === '\n') i++; r.push(c); c = ''; if (r.some(x => x.trim())) rows.push(r); r = []; }
    else c += ch; }
  r.push(c); if (r.some(x => x.trim())) rows.push(r); return rows;
}
const esc = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
const download = (name, text) => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' })); a.download = name; a.click(); };
const copy = t => navigator.clipboard.writeText(t);

function Auth({ onDone, siteName }) {
  const [mode, setMode] = useState('login'), [email, setEmail] = useState(''), [password, setPassword] = useState(''), [err, setErr] = useState('');
  const submit = async () => { try { const d = await api('/api/' + mode, 'POST', { email, password }); localStorage.token = d.token; onDone(); } catch (e) { setErr(e.message); } };
  return <div className="wrap" style={{ maxWidth: 420 }}><div className="card"><h2>{siteName}</h2><p className="muted">AI copywriting for online sellers</p>
    <input placeholder="Email" value={email} onChange={e => setEmail(e.target.value)} />
    <input type="password" placeholder="Password" value={password} onChange={e => setPassword(e.target.value)} onKeyDown={e => e.key === 'Enter' && submit()} />
    <p className="err">{err}</p><button onClick={submit}>{mode === 'login' ? 'Login' : 'Create account'}</button>{' '}
    <button className="ghost" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setErr(''); }}>{mode === 'login' ? 'Need an account?' : 'Have an account?'}</button></div></div>;
}

function Options({ meta, o, setO }) {
  return <div className="grid">
    <div><label>Content type</label><select value={o.template} onChange={e => setO({ ...o, template: e.target.value })}>{meta.templates.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}</select></div>
    <div><label>Tone</label><select value={o.tone} onChange={e => setO({ ...o, tone: e.target.value })}>{meta.tones.map(t => <option key={t}>{t}</option>)}</select></div>
    <div><label>Language</label><select value={o.language} onChange={e => setO({ ...o, language: e.target.value })}>{meta.languages.map(t => <option key={t}>{t}</option>)}</select></div></div>;
}

function Generate({ meta, setCredits }) {
  const [o, setO] = useState({ template: 'product_description', tone: 'Professional', language: 'English' });
  const [product, setProduct] = useState(''), [features, setFeatures] = useState(''), [out, setOut] = useState(''), [err, setErr] = useState(''), [busy, setBusy] = useState(false), [copied, setCopied] = useState(false);
  const go = async () => { setBusy(true); setErr(''); setOut(''); try { const d = await api('/api/generate', 'POST', { ...o, product, features }); setOut(d.output); setCredits(d.credits); } catch (e) { setErr(e.message); } setBusy(false); };
  return <div className="card"><Options meta={meta} o={o} setO={setO} />
    <label>Product name</label><input placeholder="e.g. Stainless steel water bottle" value={product} onChange={e => setProduct(e.target.value)} />
    <label>Key features (optional)</label><textarea rows="3" placeholder="Insulated, 750ml, leak-proof, BPA-free" value={features} onChange={e => setFeatures(e.target.value)} />
    <p><button disabled={busy || !product.trim()} onClick={go}>{busy ? 'Generating... (free models can take 10-30s)' : 'Generate (1 credit)'}</button></p><p className="err">{err}</p>
    {out && <><pre>{out}</pre><button className="ghost" onClick={() => { copy(out); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>{copied ? 'Copied!' : 'Copy'}</button></>}</div>;
}

function Bulk({ meta, setCredits }) {
  const [o, setO] = useState({ template: 'product_description', tone: 'Professional', language: 'English' });
  const [rows, setRows] = useState([]), [res, setRes] = useState([]), [err, setErr] = useState(''), [busy, setBusy] = useState(false);
  const onFile = async e => { setErr(''); setRes([]); const f = e.target.files[0]; if (!f) return;
    const t = parseCSV(await f.text()); if (t.length < 2) return setErr('CSV needs a header row and at least one product');
    const h = t[0].map(x => x.trim().toLowerCase()), pi = h.indexOf('product'), fi = h.indexOf('features');
    if (pi < 0) return setErr('CSV must have a "product" column (and optional "features")');
    setRows(t.slice(1).map(r => ({ product: r[pi] || '', features: fi >= 0 ? r[fi] || '' : '' })).filter(r => r.product.trim()).slice(0, 25)); };
  const run = async () => { setBusy(true); setErr(''); try { const d = await api('/api/bulk', 'POST', { ...o, rows }); setRes(d.results); setCredits(d.credits); } catch (e) { setErr(e.message); } setBusy(false); };
  const sample = () => download('sample.csv', 'product,features\n"Stainless steel water bottle","Insulated, 750ml, leak-proof"\n"Yoga mat","Non-slip, 6mm, eco-friendly"\n');
  const dl = () => download('results.csv', 'product,output\n' + res.map(r => esc(r.product) + ',' + esc(r.error ? 'ERROR: ' + r.error : r.output)).join('\n'));
  return <div className="card"><h3>Bulk generation</h3><p className="muted">Upload a CSV with columns <b>product</b> and <b>features</b> (max 25 rows per batch, 1 credit per row). <a href="#" onClick={e => { e.preventDefault(); sample(); }}>Download sample CSV</a></p>
    <Options meta={meta} o={o} setO={setO} /><label>CSV file</label><input type="file" accept=".csv" onChange={onFile} />
    {rows.length > 0 && <p>{rows.length} products ready. <button disabled={busy} onClick={run}>{busy ? 'Working... this can take a few minutes' : `Generate all (${rows.length} credits)`}</button></p>}
    <p className="err">{err}</p>
    {res.length > 0 && <><p className="ok">{res.filter(r => !r.error).length} of {res.length} done.</p><button onClick={dl}>Download results CSV</button>
      {res.map((r, i) => <div key={i}><b>{r.product}</b>{r.error ? <p className="err">{r.error}</p> : <pre>{r.output}</pre>}</div>)}</>}</div>;
}

function History({ meta }) {
  const [h, setH] = useState([]), [q, setQ] = useState('');
  const load = async () => setH(await api('/api/history')); useEffect(() => { load(); }, []);
  const label = id => meta.templates.find(t => t.id === id)?.label || id;
  const list = h.filter(x => (x.input + x.output).toLowerCase().includes(q.toLowerCase()));
  return <div><input placeholder="Search history..." value={q} onChange={e => setQ(e.target.value)} />
    {list.length === 0 && <div className="card muted">Nothing here yet.</div>}
    {list.map(x => <div className="card" key={x.id}><div className="bar"><span><b>{label(x.template)}</b> <span className="muted">{x.created}</span></span>
      <span><button className="ghost" onClick={() => copy(x.output)}>Copy</button> <button className="ghost" onClick={async () => { await api('/api/history/' + x.id, 'DELETE'); load(); }}>Delete</button></span></div>
      <p className="muted">{x.input}</p><pre>{x.output}</pre></div>)}</div>;
}

function Buy() {
  const [p, setP] = useState(null), [err, setErr] = useState('');
  useEffect(() => { api('/api/packs').then(setP); }, []);
  const buy = async k => { try { location.href = (await api('/api/checkout', 'POST', { pack: k })).url; } catch (e) { setErr(e.message); } };
  return <div className="card"><h3>Credit packs</h3>{location.search.includes('paid') && <p className="ok">Payment received. Credits appear in a few seconds - refresh the page.</p>}
    {p && !p.enabled && <p className="err">Payments are not configured (admin: add Stripe keys in .env).</p>}
    {p && Object.entries(p.packs).map(([k, x]) => <div className="bar" key={k} style={{ margin: '10px 0' }}><span><b>{x.name}</b> - {x.credits} credits - ${(x.cents / 100).toFixed(2)}</span><button disabled={!p.enabled} onClick={() => buy(k)}>Buy</button></div>)}<p className="err">{err}</p></div>;
}

function Admin() {
  const [users, setUsers] = useState([]), [s, setS] = useState(null), [msg, setMsg] = useState(''), [key, setKey] = useState('');
  const load = async () => { setUsers(await api('/api/admin/users')); setS(await api('/api/admin/settings')); }; useEffect(() => { load(); }, []);
  const save = async () => { try { await api('/api/admin/settings', 'POST', { ...s, api_key: key }); setKey(''); setMsg('Saved'); load(); } catch (e) { setMsg(e.message); } };
  if (!s) return null;
  return <><div className="card"><h3>Settings</h3><div className="grid">
    <div><label>Site name</label><input value={s.site_name} onChange={e => setS({ ...s, site_name: e.target.value })} /></div>
    <div><label>Free credits for new users</label><input type="number" value={s.free_credits} onChange={e => setS({ ...s, free_credits: e.target.value })} /></div>
    <div><label>AI provider</label><select value={s.provider} onChange={e => setS({ ...s, provider: e.target.value })}><option value="openrouter">OpenRouter</option><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option></select></div>
    <div><label>Model</label><input value={s.model} onChange={e => setS({ ...s, model: e.target.value })} /></div></div>
    <label>API key {s.api_key_set ? '(set - leave blank to keep)' : '(not set)'}</label><input type="password" placeholder="Paste API key" value={key} onChange={e => setKey(e.target.value)} />
    <p><button onClick={save}>Save settings</button> <span className={msg === 'Saved' ? 'ok' : 'err'}>{msg}</span></p></div>
    <div className="card"><h3>Users</h3>{users.map(u => <div className="bar" key={u.id} style={{ margin: '8px 0' }}><span>{u.email} ({u.role}) - {u.credits} credits</span><button className="ghost" onClick={async () => { await api('/api/admin/credits', 'POST', { id: u.id, amount: 10 }); load(); }}>+10 credits</button></div>)}</div></>;
}

function App() {
  const [me, setMe] = useState(null), [meta, setMeta] = useState(null), [tab, setTab] = useState('gen'), [cfg, setCfg] = useState({ siteName: 'SellerCopy AI' });
  const [dark, setDark] = useState(localStorage.theme === 'dark');
  useEffect(() => { document.documentElement.dataset.theme = dark ? 'dark' : 'light'; localStorage.theme = dark ? 'dark' : 'light'; }, [dark]);
  const load = async () => { try { setMe(await api('/api/me')); setMeta(await api('/api/templates')); } catch { delete localStorage.token; setMe(false); } };
  useEffect(() => { fetch('/api/config').then(r => r.json()).then(c => { setCfg(c); document.title = c.siteName; }); load(); }, []);
  if (me === null) return null;
  if (!me) return <Auth onDone={load} siteName={cfg.siteName} />;
  if (!meta) return null;
  const T = ([k, l]) => <button key={k} className={tab === k ? 'on' : 'ghost'} onClick={() => setTab(k)}>{l}</button>;
  return <div className="wrap"><div className="card bar"><b style={{ fontSize: 18 }}>{cfg.siteName}</b>
    <div className="tabs"><span className="badge">{me.credits} credits</span>
      {[['gen', 'Generate'], ['bulk', 'Bulk CSV'], ['hist', 'History'], ['buy', 'Buy credits'], ...(me.role === 'admin' ? [['admin', 'Admin']] : [])].map(T)}
      <button className="ghost" onClick={() => setDark(!dark)}>{dark ? 'Light' : 'Dark'}</button>
      <button className="ghost" onClick={() => { delete localStorage.token; setMe(false); }}>Logout</button></div></div>
    {tab === 'gen' && <Generate meta={meta} setCredits={c => setMe({ ...me, credits: c })} />}
    {tab === 'bulk' && <Bulk meta={meta} setCredits={c => setMe({ ...me, credits: c })} />}
    {tab === 'hist' && <History meta={meta} />}{tab === 'buy' && <Buy />}{tab === 'admin' && <Admin />}</div>;
}
createRoot(document.getElementById('root')).render(<App />);
