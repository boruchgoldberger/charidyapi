// ─────────────────────────────────────────────────────────────────────────
// Standalone Charidy donation sync — Agudah campaign
//
// Deliberately its own small service, own database, own Railway deployment.
// The equivalent Tishabav/Bonei Olam sync living inside bgold-ivr was found
// to be adding real load to that app; this exists so Agudah's sync never
// touches bgold-ivr's resources again, and vice versa.
//
// Reuses the EXACT proven Charidy admin-API login/fetch pattern already
// working in bgold-ivr (dashboardapi.charidy.com/orgarea/api/v1, JWT login,
// donation field mapping) — not reinvented, just relocated.
// ─────────────────────────────────────────────────────────────────────────
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const multer = require('multer');
const XLSX = require('xlsx');
const { Pool } = require('pg');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 60 * 1024 * 1024 } });

const app = express();
app.use(cors({ credentials: true, origin: true }));
app.use(express.json({ limit: '5mb' }));
app.use(cookieParser());
app.use(express.static(require('path').join(__dirname, 'public')));

const PORT = process.env.PORT || 8080;
const SYNC_TOKEN = process.env.SYNC_TOKEN || null; // kept as a fallback for API/automation use (e.g. curl) — the dashboard itself now uses a real login instead
const DASHBOARD_USERNAME = process.env.DASHBOARD_USERNAME || 'admin';
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || null;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : false });

// Accepts EITHER a logged-in session cookie (what the dashboard uses) OR the
// raw x-sync-token header (kept for scripts/curl/automation) — either one
// is sufficient. The dashboard no longer asks anyone to paste a token.
async function requireToken(req, res, next) {
  const supplied = req.headers['x-sync-token'] || req.query.token;
  if (SYNC_TOKEN && supplied === SYNC_TOKEN) return next();
  const sid = req.cookies && req.cookies.session;
  if (sid) {
    try {
      const r = await pool.query('SELECT * FROM sessions WHERE id=$1 AND expires_at > NOW()', [sid]);
      if (r.rows.length) return next();
    } catch (e) { /* fall through to 401 */ }
  }
  return res.status(401).json({ error: 'Not logged in.' });
}

// ── Schema ──────────────────────────────────────────────────────────────
async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      expires_at TIMESTAMPTZ
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS donations (
      donation_id TEXT PRIMARY KEY,
      campaign_id TEXT,
      campaign_year TEXT,
      donated_at TIMESTAMPTZ,
      firstname TEXT,
      lastname TEXT,
      email TEXT,
      email_norm TEXT,
      phone_norm TEXT,
      amount NUMERIC,
      currency TEXT,
      utm_source TEXT,
      team TEXT,
      status TEXT,
      display_name TEXT,
      gateway TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE donations ADD COLUMN IF NOT EXISTS campaign_id TEXT`).catch(()=>{});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_donations_year ON donations(campaign_year)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_donations_campaign ON donations(campaign_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_donations_team ON donations(team)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_donations_utm ON donations(utm_source)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_donations_email_norm ON donations(email_norm)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS charidy_sync (
      k TEXT PRIMARY KEY,
      org_id TEXT, campaign_id TEXT, year TEXT,
      auto_enabled BOOLEAN DEFAULT false,
      status TEXT DEFAULT 'idle',
      last_run_started_at TIMESTAMPTZ,
      last_run_finished_at TIMESTAMPTZ,
      last_pulled INT, last_imported INT, last_added INT,
      last_error TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // The real fix for "which donations belong to which season" — every
  // donation now stores its actual campaign_id (from Charidy itself, not a
  // hand-typed label). A campaign gets a human label ("2026", "2025") once,
  // here, instead of being retyped at sync time where a mistake silently
  // merges two seasons together (exactly what happened before this).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS campaign_labels (
      campaign_id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // Lets you combine several raw utm_source values (e.g. case-variants, or
  // several email blasts) under one reporting label, without altering the
  // underlying donation rows.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ref_groups (
      id SERIAL PRIMARY KEY,
      label TEXT NOT NULL,
      sources TEXT[] NOT NULL,
      treat_as_no_ref BOOLEAN DEFAULT false,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE ref_groups ADD COLUMN IF NOT EXISTS treat_as_no_ref BOOLEAN DEFAULT false`).catch(()=>{});
}
function syncKey(org, campaign, year) { return `${org}:${campaign}:${year}`; }
async function getCampaignLabels() {
  const rows = (await pool.query('SELECT * FROM campaign_labels')).rows;
  const byId = {}, byLabel = {};
  for (const r of rows) { byId[r.campaign_id] = r.label; byLabel[r.label] = r.campaign_id; }
  return { byId, byLabel };
}

// ── Login ───────────────────────────────────────────────────────────────
// Constant-time-ish comparison so a wrong password doesn't leak timing info.
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a || ''));
  const bufB = Buffer.from(String(b || ''));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

app.post('/api/login', async (req, res) => {
  try {
    if (!DASHBOARD_PASSWORD) return res.status(500).json({ error: 'DASHBOARD_PASSWORD not configured on the server yet — set it in Railway variables.' });
    await ensureSchema();
    const { username, password } = req.body || {};
    const userOk = safeEqual(username || DASHBOARD_USERNAME, DASHBOARD_USERNAME);
    const passOk = safeEqual(password, DASHBOARD_PASSWORD);
    if (!userOk || !passOk) return res.status(401).json({ error: 'Incorrect username or password.' });
    const sid = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days
    await pool.query('INSERT INTO sessions (id, expires_at) VALUES ($1,$2)', [sid, expires]);
    res.cookie('session', sid, { httpOnly: true, secure: true, sameSite: 'lax', expires, path: '/' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/logout', async (req, res) => {
  try {
    const sid = req.cookies && req.cookies.session;
    if (sid) await pool.query('DELETE FROM sessions WHERE id=$1', [sid]).catch(() => {});
    res.clearCookie('session', { path: '/' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/me', async (req, res) => {
  try {
    await ensureSchema();
    const sid = req.cookies && req.cookies.session;
    if (!sid) return res.json({ loggedIn: false });
    const r = await pool.query('SELECT * FROM sessions WHERE id=$1 AND expires_at > NOW()', [sid]);
    res.json({ loggedIn: r.rows.length > 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ── Charidy admin API — same base URL, login flow, and field mapping as
// the proven bgold-ivr implementation ──────────────────────────────────
const CHARIDY_BASE = 'https://dashboardapi.charidy.com/orgarea/api/v1';
let _token = null, _tokenAt = 0;

function _findJwt(o) {
  if (typeof o === 'string') {
    const p = o.split('.');
    if (p.length === 3 && /^[A-Za-z0-9_-]{10,}$/.test(p[0]) && /^[A-Za-z0-9_-]+$/.test(p[1])) return o;
    return null;
  }
  if (o && typeof o === 'object') { for (const k of Object.keys(o)) { const f = _findJwt(o[k]); if (f) return f; } }
  return null;
}

async function charidyLogin(force) {
  const email = process.env.CHARIDY_EMAIL, password = process.env.CHARIDY_PASSWORD;
  if (!email || !password) throw new Error('Set CHARIDY_EMAIL and CHARIDY_PASSWORD (Agudah\'s Charidy login) as env vars first.');
  if (!force && _token && (Date.now() - _tokenAt) < 30 * 60 * 1000) return _token;
  const r = await fetch(CHARIDY_BASE + '/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password })
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Charidy login failed (' + r.status + '): ' + JSON.stringify(data).slice(0, 200));
  let tok = _findJwt(data) || r.headers.get('authorization') || r.headers.get('x-auth-token') || r.headers.get('x-access-token') || r.headers.get('access-token');
  if (tok && /^Bearer\s+/i.test(tok)) tok = tok.replace(/^Bearer\s+/i, '');
  if (!tok) throw new Error('Charidy login OK but no JWT token found in response.');
  _token = tok; _tokenAt = Date.now();
  return tok;
}

async function charidyGet(path) {
  let tok = await charidyLogin();
  let r = await fetch(CHARIDY_BASE + path, { headers: { Authorization: 'Bearer ' + tok } });
  if (r.status === 401 || r.status === 403) {
    tok = await charidyLogin(true);
    r = await fetch(CHARIDY_BASE + path, { headers: { Authorization: 'Bearer ' + tok } });
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Charidy GET ' + path + ' failed (' + r.status + '): ' + JSON.stringify(data).slice(0, 200));
  return data;
}

function charidyRows(resp) {
  if (Array.isArray(resp)) return resp;
  if (!resp || typeof resp !== 'object') return [];
  return resp.data || resp.donations || resp.rows || (resp.data && resp.data.donations) || [];
}
function _label(v) { if (v == null) return null; const s = String(v).trim(); return s === '' ? null : s; }
function _pick(o, keys) { for (const k of keys) { if (o && o[k] != null && o[k] !== '') return o[k]; } return null; }
function _deepPick(o, keys, depth) {
  depth = depth || 0;
  if (!o || typeof o !== 'object' || depth > 4) return null;
  const lower = keys.map(k => k.toLowerCase());
  for (const k of Object.keys(o)) { if (lower.includes(k.toLowerCase())) { const v = o[k]; if (v != null && v !== '') return v; } }
  for (const k of Object.keys(o)) { const v = o[k]; if (v && typeof v === 'object') { const f = _deepPick(v, keys, depth + 1); if (f != null && f !== '') return f; } }
  return null;
}
function _fromReferrer(str, key) {
  if (!str) return null;
  const m = String(str).match(new RegExp(key + ':([^;]+)'));
  return m ? m[1] : null;
}
function charidyDate(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  if (/^\d{10}$/.test(s)) return new Date(parseInt(s, 10) * 1000).toISOString();
  if (/^\d{13}$/.test(s)) return new Date(parseInt(s, 10)).toISOString();
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString();
}
function normEmail(e) { return e ? String(e).trim().toLowerCase() : null; }
function normPhone(p) { return p ? String(p).replace(/\D/g, '') : null; }

// Team ID → name resolution — same "probe likely paths, cache an hour" pattern.
const TEAM_PATHS = (orgId, campaignId) => ([
  '/organization/' + orgId + '/campaign/' + campaignId + '/team',
  '/organization/' + orgId + '/campaign/' + campaignId + '/teams',
  '/organization/' + orgId + '/campaign/' + campaignId + '/team/list'
]);
const _teamCache = new Map();
async function fetchTeams(orgId, campaignId, force) {
  const key = orgId + ':' + campaignId;
  const cached = _teamCache.get(key);
  if (!force && cached && (Date.now() - cached.at) < 60 * 60 * 1000) return cached.map;
  let map = {};
  for (const p of TEAM_PATHS(orgId, campaignId)) {
    try {
      const r = await charidyGet(p);
      const rows = charidyRows(r);
      if (rows.length) {
        for (const t of rows) {
          const a = (t && t.attributes) ? Object.assign({}, t.attributes, { id: t.id }) : (t || {});
          const id = _pick(a, ['id', 'team_id']);
          const name = _pick(a, ['name', 'title', 'team_name', 'display_name']);
          if (id != null && name) map[String(id)] = String(name);
        }
        if (Object.keys(map).length) break;
      }
    } catch (e) { /* try next path */ }
  }
  _teamCache.set(key, { map, at: Date.now() });
  return map;
}

function charidyMap(item, year, teamNameMap, campaignId) {
  const a = (item && item.attributes) ? Object.assign({}, item.attributes, { id: (item.id != null ? item.id : item.attributes.id) }) : (item || {});
  const email = _label(_deepPick(a, ['email', 'donor_email', 'billing_email', 'payer_email', 'donator_email'])) || '';
  const phone = _label(_deepPick(a, ['phone', 'donor_phone', 'billing_phone', 'phone_number', 'mobile', 'donator_phone'])) || '';
  const referrerStr = _deepPick(a, ['referrer']);
  const utm = _label(_deepPick(a, ['utm_source', 'source', 'utm', 'ref'])) || _fromReferrer(referrerStr, 'utm_source') || _fromReferrer(referrerStr, 'utm_shortlink');
  let team = _label(_deepPick(a, ['team_name', 'team', 'team_slug', 'fundraiser_name']));
  if (team == null) {
    const tid = _deepPick(a, ['team_id']);
    const tlist = a && a.team_id_list;
    let teamIdRaw = null;
    if (tid && Number(tid) > 0) teamIdRaw = String(tid);
    else if (Array.isArray(tlist) && tlist.length && Number(tlist[0]) > 0) teamIdRaw = String(tlist[0]);
    if (teamIdRaw != null) team = (teamNameMap && teamNameMap[teamIdRaw]) || teamIdRaw;
  }
  const fn = _label(_deepPick(a, ['billing_name', 'first_name', 'firstName', 'billing_first_name', 'donor_first_name', 'fname']));
  const ln = _label(_deepPick(a, ['billing_last_name', 'last_name', 'lastName', 'donor_last_name', 'lname']));
  const display = _label(_deepPick(a, ['display_name', 'name', 'full_name', 'donor_name']));
  const nameWhole = (!fn && !ln) ? display : null;
  const amtRaw = _deepPick(a, ['charged_amount', 'effective_amount', 'processing_charged_amount', 'amount', 'donation_amount', 'charge_amount', 'sum', 'total', 'value']);
  const amount = amtRaw != null ? (parseFloat(String(amtRaw).replace(/[^0-9.\-]/g, '')) || null) : null;
  const offlineSource = _label(_deepPick(a, ['offline_donation_source']));
  const bankName = _label(_deepPick(a, ['bank_name']));
  const gateway = (offlineSource && String(offlineSource).trim()) ? 'offline' : (bankName || 'online');
  return {
    donation_id: String(_label(_deepPick(a, ['id', 'donation_id', 'uuid', 'transaction_id', '_id'])) || ('charidy-' + Math.random().toString(36).slice(2))),
    campaign_id: String(campaignId),
    campaign_year: year,
    donated_at: charidyDate(_deepPick(a, ['date', 'created_at', 'donation_date', 'created', 'time', 'donated_at', 'datetime', 'payment_date', 'timestamp'])),
    firstname: fn || (nameWhole ? String(nameWhole).split(' ')[0] : null),
    lastname: ln || (nameWhole ? String(nameWhole).split(' ').slice(1).join(' ') : null),
    email, email_norm: normEmail(email), phone_norm: normPhone(phone),
    amount, currency: _label(_deepPick(a, ['currency', 'currency_code'])),
    utm_source: utm != null ? String(utm) : null,
    team: team != null ? String(team) : null,
    status: _label(_deepPick(a, ['status', 'state', 'payment_status'])),
    display_name: display != null ? String(display) : null,
    gateway: gateway != null ? String(gateway) : null
  };
}

async function upsertDonation(d) {
  await pool.query(`
    INSERT INTO donations (donation_id, campaign_id, campaign_year, donated_at, firstname, lastname, email, email_norm, phone_norm, amount, currency, utm_source, team, status, display_name, gateway, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, NOW())
    ON CONFLICT (donation_id) DO UPDATE SET
      campaign_id=EXCLUDED.campaign_id, campaign_year=EXCLUDED.campaign_year, donated_at=EXCLUDED.donated_at, firstname=EXCLUDED.firstname,
      lastname=EXCLUDED.lastname, email=EXCLUDED.email, email_norm=EXCLUDED.email_norm, phone_norm=EXCLUDED.phone_norm,
      amount=EXCLUDED.amount, currency=EXCLUDED.currency, utm_source=EXCLUDED.utm_source, team=EXCLUDED.team,
      status=EXCLUDED.status, display_name=EXCLUDED.display_name, gateway=EXCLUDED.gateway, updated_at=NOW()
  `, [d.donation_id, d.campaign_id, d.campaign_year, d.donated_at, d.firstname, d.lastname, d.email, d.email_norm, d.phone_norm,
      d.amount, d.currency, d.utm_source, d.team, d.status, d.display_name, d.gateway]);
}

// ── Background sync — mirrors the proven bgold-ivr pattern: respond
// instantly, do the real pull/upsert in the background, persist progress
// so it survives the caller disconnecting. ──────────────────────────────
const _syncRunning = new Set();
async function runSync({ orgId, campaignId, year, mode }) {
  const k = syncKey(orgId, campaignId, year);
  if (_syncRunning.has(k)) return;
  _syncRunning.add(k);
  const startedAt = new Date();
  await pool.query(
    `INSERT INTO charidy_sync (k, org_id, campaign_id, year, status, last_run_started_at, updated_at)
     VALUES ($1,$2,$3,$4,'running',$5,NOW())
     ON CONFLICT (k) DO UPDATE SET status='running', last_run_started_at=$5, last_error=NULL, updated_at=NOW()`,
    [k, orgId, campaignId, year, startedAt]
  );
  let pulled = 0, imported = 0, added = 0;
  try {
    await charidyLogin(true);
    // Auto-create a default label the first time this campaign is synced —
    // editable anytime afterward without needing to re-sync anything, since
    // the real donation rows are tagged by campaign_id, not by this label.
    await pool.query(
      `INSERT INTO campaign_labels (campaign_id, label) VALUES ($1,$2) ON CONFLICT (campaign_id) DO NOTHING`,
      [String(campaignId), year]
    );
    const teamMap = await fetchTeams(orgId, campaignId).catch(() => ({}));
    let page = 1;
    const limit = 200;
    let keepGoing = true;
    while (keepGoing) {
      const resp = await charidyGet(`/organization/${orgId}/campaign/${campaignId}/donations?page=${page}&limit=${limit}`);
      const rows = charidyRows(resp);
      if (!rows.length) break;
      pulled += rows.length;
      for (const raw of rows) {
        const mapped = charidyMap(raw, year, teamMap, campaignId);
        const existing = await pool.query('SELECT donation_id FROM donations WHERE donation_id=$1', [mapped.donation_id]);
        if (mode === 'incremental' && existing.rows.length) { keepGoing = false; break; } // newest-first: hit known donation, stop
        await upsertDonation(mapped);
        imported++;
        if (!existing.rows.length) added++;
      }
      page++;
      if (rows.length < limit) break; // last page
    }
    await pool.query(
      `UPDATE charidy_sync SET status='done', last_run_finished_at=NOW(), last_pulled=$1, last_imported=$2, last_added=$3, updated_at=NOW() WHERE k=$4`,
      [pulled, imported, added, k]
    );
  } catch (e) {
    await pool.query(
      `UPDATE charidy_sync SET status='failed', last_run_finished_at=NOW(), last_error=$1, updated_at=NOW() WHERE k=$2`,
      [String(e.message).slice(0, 500), k]
    );
  } finally {
    _syncRunning.delete(k);
  }
}

// ── Routes ──────────────────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Discover Agudah's org ID and campaign ID — run this FIRST, once, before
// anything else. Needs only CHARIDY_EMAIL / CHARIDY_PASSWORD set.
app.post('/api/campaigns', requireToken, async (req, res) => {
  try {
    await charidyLogin(true);
    const wantOrg = req.query.org || (req.body && req.body.org);
    const tryPaths = ['/organization', '/organizations', '/organization/list', '/me/organizations', '/user/organizations', '/account/organizations', '/orgs'];
    let orgs = [];
    if (!wantOrg) {
      for (const p of tryPaths) {
        try { const r = await charidyGet(p); const rows = charidyRows(r); if (rows.length) { orgs = rows; break; } } catch (e) {}
      }
    }
    const orgIds = wantOrg ? [wantOrg] : orgs.map(o => (o && o.attributes) ? o.id : (o && (o.id || o.organization_id))).filter(v => v != null);
    const discovered = [];
    for (const oid of orgIds) {
      const campPaths = ['/organization/' + oid + '/campaign', '/organization/' + oid + '/campaigns', '/organization/' + oid + '/campaign/list'];
      for (const p of campPaths) {
        try {
          const r = await charidyGet(p);
          const camps = charidyRows(r);
          if (camps.length) {
            discovered.push({
              org_id: oid,
              campaigns: camps.map(c => {
                const a = (c && c.attributes) ? Object.assign({}, c.attributes, { id: c.id }) : (c || {});
                return { campaign_id: _pick(a, ['id', 'campaign_id']), name: _pick(a, ['title', 'name', 'display_name', 'campaign_name']) };
              })
            });
            break;
          }
        } catch (e) {}
      }
    }
    res.json({ ok: true, discovered });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/sync?org=..&campaign=..&year=2025[&mode=full|incremental]
app.post('/api/sync', requireToken, async (req, res) => {
  try {
    await ensureSchema();
    const year = String(req.query.year || (req.body && req.body.year) || '').trim();
    const orgId = req.query.org || (req.body && req.body.org);
    const campaignId = req.query.campaign || (req.body && req.body.campaign);
    const mode = (req.query.mode || (req.body && req.body.mode)) === 'incremental' ? 'incremental' : 'full';
    if (!year || !orgId || !campaignId) return res.status(400).json({ error: 'org, campaign, and year are all required.' });
    const k = syncKey(orgId, campaignId, year);
    if (_syncRunning.has(k)) return res.json({ ok: true, started: false, already_running: true });
    runSync({ orgId, campaignId, year, mode }).catch(e => console.error('[sync bg]', e.message));
    res.json({ ok: true, started: true, mode, org: orgId, campaign: campaignId, year });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/sync/status', requireToken, async (req, res) => {
  try {
    await ensureSchema();
    const { org, campaign, year } = req.query;
    if (org && campaign && year) {
      const r = await pool.query('SELECT * FROM charidy_sync WHERE k=$1', [syncKey(org, campaign, year)]);
      return res.json({ ok: true, exists: !!r.rows.length, sync: r.rows[0] || null });
    }
    const r = await pool.query('SELECT * FROM charidy_sync ORDER BY updated_at DESC');
    res.json({ ok: true, rows: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/autosync', requireToken, async (req, res) => {
  try {
    await ensureSchema();
    const orgId = req.body.org, campaignId = req.body.campaign, year = String(req.body.year || '').trim();
    const enabled = !!req.body.enabled;
    if (!orgId || !campaignId || !year) return res.status(400).json({ error: 'org, campaign, year required.' });
    const k = syncKey(orgId, campaignId, year);
    await pool.query(
      `INSERT INTO charidy_sync (k, org_id, campaign_id, year, auto_enabled, status, updated_at)
       VALUES ($1,$2,$3,$4,$5,'idle',NOW())
       ON CONFLICT (k) DO UPDATE SET auto_enabled=EXCLUDED.auto_enabled, updated_at=NOW()`,
      [k, orgId, campaignId, year, enabled]
    );
    res.json({ ok: true, enabled });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/donations?year=&team=&q=&limit=&refs_only=1
// Resolves ?label=2026 (preferred) or the old ?year= alias to an actual
// campaign_id via campaign_labels, so filtering is based on which real
// Charidy campaign a donation came from — not a hand-typed tag that can
// silently merge two seasons together.
async function resolveCampaignWhere(req, paramsStart) {
  const label = (req.query.label || req.query.year || '').trim();
  if (!label || label === 'all') return { clause: '', params: [] };
  const { byLabel } = await getCampaignLabels();
  const campaignId = byLabel[label];
  if (campaignId) return { clause: `campaign_id = $${paramsStart}`, params: [campaignId] };
  // Fallback for any rows synced before campaign_id existed on this table.
  return { clause: `campaign_year = $${paramsStart}`, params: [label] };
}

async function getRefGroupMap() {
  const rows = (await pool.query('SELECT * FROM ref_groups')).rows;
  const map = {}; // raw source (lowercased) -> group label
  for (const g of rows) for (const s of g.sources) map[String(s).toLowerCase()] = g.label;
  return map;
}
// SQL CASE expression collapsing raw utm_source values into their group
// label where one's been defined, otherwise leaving the raw value as-is.
function refGroupCaseSQL(refGroupRows) {
  if (!refGroupRows.length) return `COALESCE(utm_source,'(direct)')`;
  const cases = refGroupRows.map(g =>
    `WHEN LOWER(utm_source) IN (${g.sources.map(s => `'${String(s).toLowerCase().replace(/'/g, "''")}'`).join(',')}) THEN '${g.label.replace(/'/g, "''")}'`
  ).join(' ');
  return `CASE ${cases} ELSE COALESCE(utm_source,'(direct)') END`;
}

// Shared by /api/donations and /api/export/donations.csv — team/ref each
// support: unset (no filter), "__has__" (must have any value), "__none__"
// (must be blank), or free text (substring match). Plus amount range and
// gateway, since exports need to answer "team+ref, over $X" style questions
// directly, not just eyeball a breakdown table.
function buildDonationFilters(req, paramsStart) {
  const where = [], params = [];
  const idx = () => paramsStart + params.length;
  const team = (req.query.team || '').trim();
  if (team === '__none__') where.push(`(team IS NULL OR team = '')`);
  else if (team === '__has__') where.push(`(team IS NOT NULL AND team <> '')`);
  else if (team) { params.push('%' + team.toLowerCase() + '%'); where.push(`LOWER(COALESCE(team,'')) LIKE $${idx()}`); }
  const ref = (req.query.ref || '').trim();
  if (ref === '__none__') where.push(`(utm_source IS NULL OR utm_source = '')`);
  else if (ref === '__has__') where.push(`(utm_source IS NOT NULL AND utm_source <> '')`);
  else if (ref) { params.push('%' + ref.toLowerCase() + '%'); where.push(`LOWER(COALESCE(utm_source,'')) LIKE $${idx()}`); }
  const gateway = (req.query.gateway || '').trim();
  if (gateway) { params.push(gateway); where.push(`gateway = $${idx()}`); }
  const minAmt = req.query.min_amount !== undefined && req.query.min_amount !== '' ? Number(req.query.min_amount) : null;
  if (minAmt != null && !isNaN(minAmt)) { params.push(minAmt); where.push(`amount >= $${idx()}`); }
  const maxAmt = req.query.max_amount !== undefined && req.query.max_amount !== '' ? Number(req.query.max_amount) : null;
  if (maxAmt != null && !isNaN(maxAmt)) { params.push(maxAmt); where.push(`amount <= $${idx()}`); }
  const q = (req.query.q || '').trim().toLowerCase();
  if (q) {
    params.push('%' + q + '%'); const i = idx();
    where.push(`(LOWER(COALESCE(display_name,'')||' '||COALESCE(firstname,'')||' '||COALESCE(lastname,'')) LIKE $${i} OR LOWER(COALESCE(email,'')) LIKE $${i} OR LOWER(COALESCE(utm_source,'')) LIKE $${i})`);
  }
  return { where, params };
}

app.get('/api/donations', requireToken, async (req, res) => {
  try {
    await ensureSchema();
    const camp = await resolveCampaignWhere(req, 1);
    const f = buildDonationFilters(req, camp.params.length + 1);
    const where = camp.clause ? [camp.clause, ...f.where] : f.where;
    const params = [...camp.params, ...f.params];
    const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 5000);
    const rows = (await pool.query(`SELECT * FROM donations ${clause} ORDER BY donated_at DESC LIMIT ${limit}`, params)).rows;
    const totals = (await pool.query(`SELECT COUNT(*) n, COALESCE(SUM(amount),0) total FROM donations ${clause}`, params)).rows[0];
    res.json({ ok: true, rows, count: Number(totals.n), total_amount: Number(totals.total) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/summary?label=2026 — aggregate totals + full breakdowns +
// segment cross-tabs (team/ref/gateway), the data a comparison dashboard
// actually needs. No caps on the lists — CSV export needs everything, and
// realistically there aren't thousands of distinct sources or teams.
app.get('/api/summary', requireToken, async (req, res) => {
  try {
    await ensureSchema();
    const camp = await resolveCampaignWhere(req, 1);
    const whereSQL = camp.clause ? 'WHERE ' + camp.clause : '';
    const andSQL = camp.clause ? 'WHERE ' + camp.clause + ' AND' : 'WHERE';
    const params = camp.params;
    const refGroupRows = (await pool.query('SELECT * FROM ref_groups')).rows;
    const sourceExpr = refGroupCaseSQL(refGroupRows);

    const totals = (await pool.query(
      `SELECT COUNT(*) n, COALESCE(SUM(amount),0) total, COALESCE(AVG(amount),0) avg_gift, COUNT(DISTINCT email_norm) donors
         FROM donations ${whereSQL}`, params)).rows[0];
    const bySource = (await pool.query(
      `SELECT ${sourceExpr} AS source, COUNT(*) n, COALESCE(SUM(amount),0) total
         FROM donations ${whereSQL} GROUP BY 1 ORDER BY total DESC`, params)).rows;
    const byTeam = (await pool.query(
      `SELECT COALESCE(team,'(no team)') AS team, COUNT(*) n, COALESCE(SUM(amount),0) total
         FROM donations ${whereSQL} GROUP BY 1 ORDER BY total DESC`, params)).rows;
    const byGateway = (await pool.query(
      `SELECT COALESCE(gateway,'unknown') AS gateway, COUNT(*) n, COALESCE(SUM(amount),0) total
         FROM donations ${whereSQL} GROUP BY 1 ORDER BY total DESC`, params)).rows;
    // Segment cross-tab: has a team? has a REAL ref? — sources in a group
    // marked "treat as no ref" (e.g. junk/internal codes that aren't
    // genuine referral sources) count as no-ref here, even though they
    // still show under their own label in the source breakdown above.
    const junkSources = refGroupRows.filter(g => g.treat_as_no_ref).flatMap(g => g.sources.map(s => String(s).toLowerCase()));
    const hasRefExpr = junkSources.length
      ? `(utm_source IS NOT NULL AND utm_source <> '' AND LOWER(utm_source) NOT IN (${junkSources.map(s => `'${s.replace(/'/g, "''")}'`).join(',')}))`
      : `(utm_source IS NOT NULL AND utm_source <> '')`;
    const segRows = (await pool.query(
      `SELECT
         (team IS NOT NULL AND team <> '') AS has_team,
         ${hasRefExpr} AS has_ref,
         COALESCE(gateway,'unknown') AS gateway,
         COUNT(*) n, COALESCE(SUM(amount),0) total
       FROM donations ${whereSQL}
       GROUP BY 1,2,3`, params)).rows;
    const segments = { team_and_ref: {n:0,total:0}, team_no_ref: {n:0,total:0}, no_team_ref: {n:0,total:0}, no_team_no_ref: {n:0,total:0},
                        online: {n:0,total:0}, offline: {n:0,total:0} };
    for (const r of segRows) {
      const properKey = r.has_team && r.has_ref ? 'team_and_ref' : r.has_team && !r.has_ref ? 'team_no_ref' : !r.has_team && r.has_ref ? 'no_team_ref' : 'no_team_no_ref';
      segments[properKey].n += Number(r.n); segments[properKey].total += Number(r.total);
      if (r.gateway === 'offline') { segments.offline.n += Number(r.n); segments.offline.total += Number(r.total); }
      else { segments.online.n += Number(r.n); segments.online.total += Number(r.total); }
    }
    const byDay = (await pool.query(
      `SELECT DATE(donated_at) AS day, COUNT(*) n, COALESCE(SUM(amount),0) total
         FROM donations ${andSQL} donated_at IS NOT NULL GROUP BY 1 ORDER BY 1`, params)).rows;
    res.json({
      ok: true, label: req.query.label || req.query.year || 'all',
      totals: { count: Number(totals.n), amount: Number(totals.total), avg_gift: Number(totals.avg_gift), donors: Number(totals.donors) },
      by_source: bySource.map(r => ({ source: r.source, count: Number(r.n), amount: Number(r.total) })),
      by_team: byTeam.map(r => ({ team: r.team, count: Number(r.n), amount: Number(r.total) })),
      by_gateway: byGateway.map(r => ({ gateway: r.gateway, count: Number(r.n), amount: Number(r.total) })),
      segments,
      by_day: byDay.map(r => ({ day: r.day, count: Number(r.n), amount: Number(r.total) }))
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Campaign labels — rename which real campaign means "2026" etc. ─────
app.get('/api/campaign-labels', requireToken, async (req, res) => {
  try {
    await ensureSchema();
    const rows = (await pool.query('SELECT * FROM campaign_labels ORDER BY label')).rows;
    res.json({ ok: true, rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/campaign-labels', requireToken, async (req, res) => {
  try {
    await ensureSchema();
    const { campaign_id, label } = req.body;
    if (!campaign_id || !label) return res.status(400).json({ error: 'campaign_id and label required.' });
    await pool.query(
      `INSERT INTO campaign_labels (campaign_id, label, updated_at) VALUES ($1,$2,NOW())
       ON CONFLICT (campaign_id) DO UPDATE SET label=EXCLUDED.label, updated_at=NOW()`,
      [String(campaign_id), String(label)]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Ref groups — combine several raw utm_source values under one label ─
app.get('/api/ref-groups', requireToken, async (req, res) => {
  try { await ensureSchema(); const rows = (await pool.query('SELECT * FROM ref_groups ORDER BY label')).rows; res.json({ ok: true, rows }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/ref-groups', requireToken, async (req, res) => {
  try {
    await ensureSchema();
    const { label, sources, treat_as_no_ref } = req.body;
    if (!label || !Array.isArray(sources) || !sources.length) return res.status(400).json({ error: 'label and a non-empty sources array required.' });
    const r = await pool.query('INSERT INTO ref_groups (label, sources, treat_as_no_ref) VALUES ($1,$2,$3) RETURNING id', [label, sources, !!treat_as_no_ref]);
    res.json({ ok: true, id: r.rows[0].id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/ref-groups/:id', requireToken, async (req, res) => {
  try { await ensureSchema(); await pool.query('DELETE FROM ref_groups WHERE id=$1', [req.params.id]); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Historical import from a multi-sheet Charidy export ────────────────
// Some older/archived campaigns may not be reachable via the live sync API
// anymore, so a manual export (one sheet per campaign, campaign_id embedded
// in the sheet name like "cid42916_...") is the real source of truth for
// them. Runs as a background job — tens of thousands of rows, one at a
// time, would otherwise exceed a normal request's time budget.
const _importJobs = new Map(); // jobId -> { status, results, error, startedAt }

function normEmailImp(e) { return e ? String(e).trim().toLowerCase() : null; }
function normPhoneImp(p) { return p ? String(p).replace(/\D/g, '') : null; }

async function runHistoricalImport(jobId, buffer) {
  const job = _importJobs.get(jobId);
  try {
    const wb = XLSX.read(buffer, { type: 'buffer' });
    const results = [];
    for (const sheetName of wb.SheetNames) {
      const m = sheetName.match(/c?id\s*(\d+)/i);
      if (!m) { results.push({ sheet: sheetName, skipped: true, reason: 'no campaign id found in sheet name' }); continue; }
      const campaignId = m[1];
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: null, raw: false });
      let imported = 0;
      const yearCounts = {};
      for (const row of rows) {
        const email = (row['Email'] || '').trim();
        const phone = (row['Phone'] || row['phone_number'] || '').toString();
        const amtRaw = row['Charge Amount Total'] ?? row['Charge Amount'] ?? row['Matched/Total Amount'];
        const amount = amtRaw != null ? (parseFloat(String(amtRaw).replace(/[^0-9.\-]/g, '')) || null) : null;
        let donatedAt = null;
        if (row['Donation Date and Time']) {
          const d = new Date(row['Donation Date and Time']);
          if (!isNaN(d.getTime())) donatedAt = d.toISOString();
        }
        const gatewayRaw = row['gateway'] || '';
        const isOffline = gatewayRaw === 'offline donation' || String(row['offline_donation_received'] || '').toLowerCase() === 'yes';
        const gateway = isOffline ? 'offline' : 'online';
        const donationId = String(row['Donation ID'] || ('import-' + campaignId + '-' + crypto.randomBytes(6).toString('hex')));
        const team = row['great_grandfather_team_name'] || row['Team Name'] || row['great_grandfather_team_id'] || row['Team ID'] || null;
        const year = donatedAt ? new Date(donatedAt).getUTCFullYear() : null;
        if (year) yearCounts[year] = (yearCounts[year] || 0) + 1;
        const fn = row['Billing First Name'] || null, ln = row['Billing Last Name'] || null;
        const display = [fn, ln].filter(Boolean).join(' ') || null;

        await pool.query(`
          INSERT INTO donations (donation_id, campaign_id, campaign_year, donated_at, firstname, lastname, email, email_norm, phone_norm, amount, currency, utm_source, team, status, display_name, gateway, updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, NOW())
          ON CONFLICT (donation_id) DO UPDATE SET
            campaign_id=EXCLUDED.campaign_id, campaign_year=EXCLUDED.campaign_year, donated_at=EXCLUDED.donated_at,
            firstname=EXCLUDED.firstname, lastname=EXCLUDED.lastname, email=EXCLUDED.email, email_norm=EXCLUDED.email_norm,
            phone_norm=EXCLUDED.phone_norm, amount=EXCLUDED.amount, currency=EXCLUDED.currency, utm_source=EXCLUDED.utm_source,
            team=EXCLUDED.team, status=EXCLUDED.status, display_name=EXCLUDED.display_name, gateway=EXCLUDED.gateway, updated_at=NOW()
        `, [donationId, campaignId, String(year || ''), donatedAt, fn, ln, email || null, normEmailImp(email), normPhoneImp(phone),
            amount, row['Currency'] || null, row['utm_source'] || null, team, row['Status'] || null, display, gateway]);
        imported++;
        // Let the event loop breathe every so often on a very long sheet.
        if (imported % 500 === 0) await new Promise(r => setImmediate(r));
      }
      // Guess a label from whichever calendar year most of this sheet's
      // donations actually fall in — only sets it if nothing's been set yet,
      // so it never clobbers a label you already assigned on purpose.
      const guessedYear = Object.entries(yearCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
      if (guessedYear) {
        await pool.query(`INSERT INTO campaign_labels (campaign_id, label) VALUES ($1,$2) ON CONFLICT (campaign_id) DO NOTHING`, [campaignId, guessedYear]);
      }
      results.push({ sheet: sheetName, campaign_id: campaignId, rows_in_sheet: rows.length, imported, guessed_label: guessedYear });
      _importJobs.set(jobId, { status: 'running', results: [...results], startedAt: job.startedAt });
    }
    _importJobs.set(jobId, { status: 'done', results, startedAt: job.startedAt });
  } catch (e) {
    _importJobs.set(jobId, { status: 'failed', error: e.message, results: job.results || [], startedAt: job.startedAt });
  }
}

app.post('/api/import/historical-xlsx', requireToken, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded (field name "file").' });
  await ensureSchema();
  const jobId = crypto.randomBytes(8).toString('hex');
  _importJobs.set(jobId, { status: 'running', results: [], startedAt: Date.now() });
  runHistoricalImport(jobId, req.file.buffer).catch(e => console.error('[import bg]', e.message));
  res.json({ ok: true, job_id: jobId });
});

app.get('/api/import/status/:jobId', requireToken, (req, res) => {
  const job = _importJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Unknown import job (may have expired on a restart).' });
  res.json({ ok: true, ...job });
});

// ── CSV export — everything, since the org's SMS tool (TextMagic) has API
// limits that make exporting and working from spreadsheets the practical
// path for now. ──────────────────────────────────────────────────────────
function toCSV(rows, columns) {
  const esc = (v) => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const header = columns.map(c => c.header).join(',');
  const body = rows.map(r => columns.map(c => esc(typeof c.value === 'function' ? c.value(r) : r[c.value])).join(',')).join('\n');
  return header + '\n' + body;
}

app.get('/api/export/donations.csv', requireToken, async (req, res) => {
  try {
    await ensureSchema();
    const camp = await resolveCampaignWhere(req, 1);
    const f = buildDonationFilters(req, camp.params.length + 1);
    const where = camp.clause ? [camp.clause, ...f.where] : f.where;
    const params = [...camp.params, ...f.params];
    const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const rows = (await pool.query(`SELECT * FROM donations ${clause} ORDER BY donated_at DESC`, params)).rows;
    const csv = toCSV(rows, [
      { header: 'Donation ID', value: 'donation_id' }, { header: 'Campaign ID', value: 'campaign_id' },
      { header: 'Season', value: 'campaign_year' },
      { header: 'Date', value: r => r.donated_at ? new Date(r.donated_at).toISOString() : '' },
      { header: 'First Name', value: 'firstname' }, { header: 'Last Name', value: 'lastname' },
      { header: 'Display Name', value: 'display_name' },
      { header: 'Email', value: 'email' }, { header: 'Phone (normalized)', value: 'phone_norm' },
      { header: 'Amount', value: 'amount' }, { header: 'Currency', value: 'currency' },
      { header: 'Ref', value: 'utm_source' }, { header: 'Team', value: 'team' }, { header: 'Status', value: 'status' },
      { header: 'Gateway', value: 'gateway' }
    ]);
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="donations-${req.query.label||req.query.year||'all'}.csv"`);
    res.send(csv);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/export/summary.csv', requireToken, async (req, res) => {
  try {
    await ensureSchema();
    const type = (req.query.type || 'source') === 'team' ? 'team' : 'source';
    const camp = await resolveCampaignWhere(req, 1);
    const whereSQL = camp.clause ? 'WHERE ' + camp.clause : '';
    const params = camp.params;
    let rows, columns;
    if (type === 'source') {
      const refGroupRows = (await pool.query('SELECT * FROM ref_groups')).rows;
      rows = (await pool.query(`SELECT ${refGroupCaseSQL(refGroupRows)} AS source, COUNT(*) n, COALESCE(SUM(amount),0) total FROM donations ${whereSQL} GROUP BY 1 ORDER BY total DESC`, params)).rows;
      columns = [{ header: 'Source', value: 'source' }, { header: 'Gifts', value: 'n' }, { header: 'Raised', value: 'total' }];
    } else {
      rows = (await pool.query(`SELECT COALESCE(team,'(no team)') AS team, COUNT(*) n, COALESCE(SUM(amount),0) total FROM donations ${whereSQL} GROUP BY 1 ORDER BY total DESC`, params)).rows;
      columns = [{ header: 'Team', value: 'team' }, { header: 'Gifts', value: 'n' }, { header: 'Raised', value: 'total' }];
    }
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${type}-breakdown-${req.query.label||req.query.year||'all'}.csv"`);
    res.send(toCSV(rows, columns));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Wipes all donation rows so a clean re-sync can rebuild them with correct
// campaign_id tagging — needed once, to fix data from before that column
// existed (when two seasons got merged under one hand-typed "year" label).
// GET /api/donors/cross-year?labels=2026,2025,2024&mode=all — finds donors
// (by normalized email) who gave in EVERY one of the given labels ("all",
// i.e. genuine multi-year loyalty) or in ANY of them ("any"). Returns rich
// per-donor summary info, not just an email list.
async function crossYearQuery(req) {
  const labels = String(req.query.labels || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!labels.length) throw Object.assign(new Error('labels required, comma-separated (e.g. ?labels=2026,2025,2024)'), { status: 400 });
  const mode = req.query.mode === 'any' ? 'any' : 'all';
  const f = buildDonationFilters(req, 1);
  const extraWhere = f.where.length ? ' AND ' + f.where.join(' AND ') : '';
  const labelsParamIdx = f.params.length + 1;
  const havingClause = mode === 'all' ? `HAVING COUNT(DISTINCT cl.label) = ${labels.length}` : '';
  const sql = `
    SELECT
      d.email_norm,
      MAX(d.email) AS email,
      MAX(d.firstname) AS firstname, MAX(d.lastname) AS lastname, MAX(d.phone_norm) AS phone_norm,
      COUNT(DISTINCT cl.label) AS years_matched,
      STRING_AGG(DISTINCT cl.label, ', ') AS years,
      COUNT(*) AS gift_count,
      COALESCE(SUM(d.amount),0) AS total_amount,
      MIN(d.donated_at) AS first_gift, MAX(d.donated_at) AS last_gift
    FROM donations d
    JOIN campaign_labels cl ON cl.campaign_id = d.campaign_id
    WHERE cl.label = ANY($${labelsParamIdx}) AND d.email_norm IS NOT NULL AND d.email_norm <> '' ${extraWhere}
    GROUP BY d.email_norm
    ${havingClause}
    ORDER BY total_amount DESC
  `;
  const params = [...f.params, labels];
  const rows = (await pool.query(sql, params)).rows;
  return { labels, mode, rows };
}

app.get('/api/donors/cross-year', requireToken, async (req, res) => {
  try {
    await ensureSchema();
    const { labels, mode, rows } = await crossYearQuery(req);
    res.json({ ok: true, labels, mode, count: rows.length, total_amount: rows.reduce((s, r) => s + Number(r.total_amount), 0), rows });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.get('/api/export/cross-year.csv', requireToken, async (req, res) => {
  try {
    await ensureSchema();
    const { labels, rows } = await crossYearQuery(req);
    const csv = toCSV(rows, [
      { header: 'Email', value: 'email' }, { header: 'First Name', value: 'firstname' }, { header: 'Last Name', value: 'lastname' },
      { header: 'Phone (normalized)', value: 'phone_norm' },
      { header: 'Years Gave', value: 'years' }, { header: 'Years Matched', value: 'years_matched' },
      { header: 'Total Gifts', value: 'gift_count' }, { header: 'Total Amount', value: 'total_amount' },
      { header: 'First Gift', value: r => r.first_gift ? new Date(r.first_gift).toISOString() : '' },
      { header: 'Last Gift', value: r => r.last_gift ? new Date(r.last_gift).toISOString() : '' }
    ]);
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="cross-year-${labels.join('-')}.csv"`);
    res.send(csv);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});


app.post('/api/admin/wipe-donations', requireToken, async (req, res) => {
  try {
    await ensureSchema();
    if (req.body?.confirm !== 'WIPE') return res.status(400).json({ error: 'Pass {"confirm":"WIPE"} to actually do this — it deletes every donation row (safe: re-syncing rebuilds them from Charidy).' });
    const r = await pool.query('DELETE FROM donations');
    res.json({ ok: true, deleted: r.rowCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});



// POST /api/sync/reset — clears a sync job stuck at "running" (e.g. from a
// deploy/restart killing it mid-run) so it can be retried. Only allows
// resetting jobs that have genuinely been running a long time, as a guard
// against accidentally interrupting one that's actually still working.
app.post('/api/sync/reset', requireToken, async (req, res) => {
  try {
    await ensureSchema();
    const { org, campaign, year } = req.body;
    if (!org || !campaign || !year) return res.status(400).json({ error: 'org, campaign, year required.' });
    const k = syncKey(org, campaign, year);
    const row = (await pool.query('SELECT * FROM charidy_sync WHERE k=$1', [k])).rows[0];
    if (!row) return res.status(404).json({ error: 'No sync job found for that org/campaign/year.' });
    const minutesRunning = row.last_run_started_at ? (Date.now() - new Date(row.last_run_started_at).getTime()) / 60000 : 0;
    if (row.status === 'running' && minutesRunning < 5 && !req.body.force) {
      return res.status(409).json({ error: 'Only been running ' + Math.round(minutesRunning) + ' min — likely still genuinely working. Pass force:true to reset anyway.' });
    }
    _syncRunning.delete(k);
    await pool.query(`UPDATE charidy_sync SET status='idle', last_error='Manually reset from a stuck state', updated_at=NOW() WHERE k=$1`, [k]);
    res.json({ ok: true, reset: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


setInterval(async () => {
  try {
    await ensureSchema();
    const jobs = (await pool.query(`SELECT * FROM charidy_sync WHERE auto_enabled=true`)).rows;
    for (const j of jobs) {
      if (_syncRunning.has(syncKey(j.org_id, j.campaign_id, j.year))) continue;
      runSync({ orgId: j.org_id, campaignId: j.campaign_id, year: j.year, mode: 'incremental' }).catch(e => console.error('[autosync]', e.message));
    }
  } catch (e) { console.error('[autosync scheduler]', e.message); }
}, 60 * 1000);

ensureSchema().then(() => {
  app.listen(PORT, '0.0.0.0', () => console.log(`Agudah Charidy sync running on port ${PORT}`));
}).catch(e => { console.error('Failed to initialize schema:', e); process.exit(1); });
