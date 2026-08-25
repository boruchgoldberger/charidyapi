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
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

const PORT = process.env.PORT || 8080;
const SYNC_TOKEN = process.env.SYNC_TOKEN || null; // set this in Railway; protects admin endpoints
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : false });

function requireToken(req, res, next) {
  if (!SYNC_TOKEN) return res.status(500).json({ error: 'SYNC_TOKEN not configured on the server — set it before use.' });
  const supplied = req.headers['x-sync-token'] || req.query.token;
  if (supplied !== SYNC_TOKEN) return res.status(401).json({ error: 'Invalid or missing sync token (x-sync-token header, or ?token=).' });
  next();
}

// ── Schema ──────────────────────────────────────────────────────────────
async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS donations (
      donation_id TEXT PRIMARY KEY,
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
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_donations_year ON donations(campaign_year)`);
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
}
function syncKey(org, campaign, year) { return `${org}:${campaign}:${year}`; }

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

function charidyMap(item, year, teamNameMap) {
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
    INSERT INTO donations (donation_id, campaign_year, donated_at, firstname, lastname, email, email_norm, phone_norm, amount, currency, utm_source, team, status, display_name, gateway, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, NOW())
    ON CONFLICT (donation_id) DO UPDATE SET
      campaign_year=EXCLUDED.campaign_year, donated_at=EXCLUDED.donated_at, firstname=EXCLUDED.firstname,
      lastname=EXCLUDED.lastname, email=EXCLUDED.email, email_norm=EXCLUDED.email_norm, phone_norm=EXCLUDED.phone_norm,
      amount=EXCLUDED.amount, currency=EXCLUDED.currency, utm_source=EXCLUDED.utm_source, team=EXCLUDED.team,
      status=EXCLUDED.status, display_name=EXCLUDED.display_name, gateway=EXCLUDED.gateway, updated_at=NOW()
  `, [d.donation_id, d.campaign_year, d.donated_at, d.firstname, d.lastname, d.email, d.email_norm, d.phone_norm,
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
        const mapped = charidyMap(raw, year, teamMap);
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
app.get('/api/donations', requireToken, async (req, res) => {
  try {
    await ensureSchema();
    const where = [], params = [];
    const year = (req.query.year || '').trim();
    if (year && year !== 'all') { params.push(year); where.push(`campaign_year=$${params.length}`); }
    const team = (req.query.team || '').trim();
    if (team) { params.push('%' + team.toLowerCase() + '%'); where.push(`LOWER(COALESCE(team,'')) LIKE $${params.length}`); }
    const q = (req.query.q || '').trim().toLowerCase();
    if (q) {
      params.push('%' + q + '%'); const i = params.length;
      where.push(`(LOWER(COALESCE(display_name,'')||' '||COALESCE(firstname,'')||' '||COALESCE(lastname,'')) LIKE $${i} OR LOWER(COALESCE(email,'')) LIKE $${i} OR LOWER(COALESCE(utm_source,'')) LIKE $${i})`);
    }
    if (req.query.refs_only === '1') where.push(`utm_source IS NOT NULL AND utm_source NOT IN ('bonei','c_whatsapp')`);
    const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 2000);
    const rows = (await pool.query(`SELECT * FROM donations ${clause} ORDER BY donated_at DESC LIMIT ${limit}`, params)).rows;
    const totals = (await pool.query(`SELECT COUNT(*) n, COALESCE(SUM(amount),0) total FROM donations ${clause}`, params)).rows[0];
    res.json({ ok: true, rows, count: Number(totals.n), total_amount: Number(totals.total) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Once-a-minute in-process auto-sync scheduler (incremental) ──────────
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
