import { Router, type Request, type Response } from 'express';
import type { Sql } from '../sql.js';

/**
 * Read-only dashboard over analysed meetings (list, filter, drill down).
 *
 * Auth is deliberately crude: a single `DASHBOARD_TOKEN`, accepted as a bearer
 * header or a `?token=` query parameter so a browser can reach it. The app's
 * device-token scheme (§13.1) assumes a native client that can set headers, and
 * proper per-user roles are a separate piece of work. Unset token disables the
 * dashboard outright rather than leaving it open.
 */
export function dashboardRoutes(sql: Sql, env = process.env): Router {
  const router = Router();
  const token = env.DASHBOARD_TOKEN;

  router.use((req: Request, res: Response, next) => {
    if (!token) {
      res.status(503).json({ error: 'dashboard disabled: DASHBOARD_TOKEN is not set' });
      return;
    }
    const supplied =
      (req.header('authorization') ?? '').replace(/^Bearer\s+/i, '') || String(req.query.token ?? '');
    if (supplied !== token) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  });

  /** Filter options, computed from the data rather than hardcoded. */
  router.get('/api/facets', async (_req, res) => {
    const languages = await sql.query<{ language: string | null; n: string }>(
      `SELECT language, count(*) AS n FROM meetings GROUP BY language ORDER BY n DESC`
    );
    const sentiments = await sql.query<{ sentiment: string; n: string }>(
      `SELECT t->>'sentiment' AS sentiment, count(*) AS n
         FROM analyses a, jsonb_array_elements(a.sentiment->'per_topic') t
        GROUP BY 1 ORDER BY n DESC`
    );
    const statuses = await sql.query<{ status: string; n: string }>(
      `SELECT status, count(*) AS n FROM meetings GROUP BY status ORDER BY n DESC`
    );
    res.json({
      languages: languages.rows.map((r) => ({ value: r.language, count: Number(r.n) })),
      sentiments: sentiments.rows.map((r) => ({ value: r.sentiment, count: Number(r.n) })),
      statuses: statuses.rows.map((r) => ({ value: r.status, count: Number(r.n) })),
    });
  });

  router.get('/api/meetings', async (req, res) => {
    const { language, sentiment, status, from, to, q } = req.query as Record<string, string>;
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (clause: string, value: unknown) => {
      params.push(value);
      where.push(clause.replace('$?', `$${params.length}`));
    };

    if (language) add('m.language = $?', language);
    if (status) add('m.status = $?', status);
    if (from) add('m.created_at >= $?', from);
    if (to) add('m.created_at <= $?', to);
    if (sentiment)
      add(
        `EXISTS (SELECT 1 FROM jsonb_array_elements(a.sentiment->'per_topic') t
                  WHERE t->>'sentiment' = $?)`,
        sentiment
      );
    // Free text runs against the transcript's tsvector, not the summary, so a
    // hit means someone actually said it.
    if (q)
      add(
        `EXISTS (SELECT 1 FROM transcript_segments s
                  WHERE s.meeting_id = m.id AND s.tsv @@ plainto_tsquery('simple', $?))`,
        q
      );

    const { rows } = await sql.query<any>(
      `SELECT m.id::text, m.created_at, m.duration_seconds, m.status, m.language,
              m.language_probability, m.tags,
              a.english_summary,
              (SELECT count(*) FROM transcript_segments s WHERE s.meeting_id = m.id) AS segments,
              jsonb_array_length(coalesce(a.quotes, '[]'::jsonb)) AS quotes,
              jsonb_array_length(coalesce(a.action_items, '[]'::jsonb)) AS action_items,
              (SELECT count(DISTINCT s.diarization_label) FROM transcript_segments s
                WHERE s.meeting_id = m.id) AS speakers
         FROM meetings m
         LEFT JOIN analyses a ON a.meeting_id = m.id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY m.created_at DESC
        LIMIT 200`,
      params
    );
    res.json({ meetings: rows });
  });

  router.get('/api/meetings/:id', async (req, res) => {
    const id = req.params.id;
    const meeting = await sql.query<any>(
      `SELECT m.*, a.telugu_summary, a.english_summary, a.quotes, a.sentiment,
              a.action_items, a.structured_facts, a.model
         FROM meetings m LEFT JOIN analyses a ON a.meeting_id = m.id
        WHERE m.id = $1`,
      [id]
    );
    if (meeting.rows.length === 0) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const segments = await sql.query<any>(
      `SELECT seq, diarization_label, start_ms, end_ms, text_te, low_confidence
         FROM transcript_segments WHERE meeting_id = $1 ORDER BY seq`,
      [id]
    );
    res.json({ meeting: meeting.rows[0], segments: segments.rows });
  });

  router.get('/', (_req, res) => {
    res.type('html').send(PAGE);
  });

  return router;
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Meetings — Dashboard</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&family=Noto+Sans+Devanagari:wght@400&family=Noto+Sans+Tamil:wght@400&family=Noto+Sans+Telugu:wght@400&family=Source+Serif+4:opsz,wght@8..60,400;8..60,600&display=swap">
<style>
:root{--ground:#EFF2EC;--panel:#FAFBF7;--raised:#F5F7F1;--ink:#191D17;--ink-soft:#5A6357;
--rule:#D8DED2;--rule-soft:#E6EADF;--accent:#1F3A5F;--accent-soft:#E4E9F1;
--pos:#2F6B4B;--pos-soft:#E1EDE3;--neg:#9C3B2C;--neg-soft:#F5E7E3;--mid:#8A6A2B;--mid-soft:#F2EBDC;
--serif:"Source Serif 4",Georgia,serif;--sans:"IBM Plex Sans",system-ui,sans-serif;--mono:"IBM Plex Mono",ui-monospace,monospace;}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--ground:#14170F;--panel:#1B1F17;--raised:#212619;
--ink:#E7EBE0;--ink-soft:#9AA492;--rule:#2C3227;--rule-soft:#242A20;--accent:#9DB8DC;--accent-soft:#1B2433;
--pos:#82C39F;--pos-soft:#17251C;--neg:#E09587;--neg-soft:#2B1D19;--mid:#D2B172;--mid-soft:#282014;}}
*{box-sizing:border-box}
body{margin:0;background:var(--ground);background-image:linear-gradient(var(--raised),transparent 220px);
color:var(--ink);font-family:var(--sans);font-size:15px;line-height:1.5;-webkit-font-smoothing:antialiased}
.wrap{max-width:1180px;margin:0 auto;padding:clamp(22px,4vw,48px) clamp(16px,3vw,32px) 70px}
header{border-bottom:2px solid var(--ink);padding-bottom:16px;margin-bottom:20px}
.eyebrow{font-family:var(--mono);font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-soft);margin:0 0 8px}
h1{font-family:var(--serif);font-weight:600;font-size:clamp(24px,3.6vw,34px);margin:0;letter-spacing:-.015em}
.filters{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;margin:18px 0 6px}
.field{display:flex;flex-direction:column;gap:4px}
label{font-family:var(--mono);font-size:10.5px;letter-spacing:.09em;text-transform:uppercase;color:var(--ink-soft)}
select,input{font-family:var(--sans);font-size:14px;padding:7px 9px;border:1px solid var(--rule);
border-radius:6px;background:var(--panel);color:var(--ink);min-width:140px}
input[type=search]{min-width:220px}
button{font-family:var(--mono);font-size:11.5px;letter-spacing:.06em;text-transform:uppercase;
padding:8px 14px;border-radius:6px;border:1px solid var(--rule);background:var(--accent-soft);color:var(--accent);cursor:pointer}
button:hover{border-color:var(--accent)}
button.ghost{background:transparent;color:var(--ink-soft)}
.count{font-family:var(--mono);font-size:12px;color:var(--ink-soft);margin:10px 0 14px}
table{width:100%;border-collapse:collapse;font-size:14px}
th{text-align:left;font-family:var(--mono);font-size:10.5px;letter-spacing:.09em;text-transform:uppercase;
color:var(--ink-soft);font-weight:500;padding:0 12px 8px 0;border-bottom:1px solid var(--rule)}
td{padding:11px 12px 11px 0;border-bottom:1px solid var(--rule-soft);vertical-align:top}
tr.row{cursor:pointer}
tr.row:hover td{background:var(--panel)}
.pill{font-family:var(--mono);font-size:10.5px;letter-spacing:.05em;padding:2px 8px;border-radius:20px;white-space:nowrap}
.pill.te{color:var(--accent);background:var(--accent-soft)}
.pill.hi{color:var(--mid);background:var(--mid-soft)}
.pill.ta{color:var(--pos);background:var(--pos-soft)}
.pill.low{color:var(--neg);background:var(--neg-soft)}
.sum{color:var(--ink-soft);font-size:13.5px;max-width:52ch}
.empty{padding:40px 0;text-align:center;color:var(--ink-soft)}
dialog{border:1px solid var(--rule);border-radius:11px;background:var(--ground);color:var(--ink);
max-width:900px;width:92vw;padding:0}
dialog::backdrop{background:rgba(0,0,0,.45)}
.dhead{position:sticky;top:0;background:var(--ground);border-bottom:1px solid var(--rule);
padding:16px 20px;display:flex;justify-content:space-between;align-items:center;gap:12px}
.dbody{padding:18px 20px 26px;max-height:74vh;overflow:auto}
.dbody h3{font-family:var(--mono);font-size:11px;letter-spacing:.1em;text-transform:uppercase;
color:var(--ink-soft);margin:20px 0 8px;font-weight:500}
.dbody h3:first-child{margin-top:0}
.card{background:var(--panel);border:1px solid var(--rule);border-radius:8px;padding:13px 15px;margin-bottom:9px}
.nat{font-family:"Noto Sans Telugu","Noto Sans Devanagari","Noto Sans Tamil",var(--sans)}
.seg{display:grid;grid-template-columns:80px 1fr;gap:10px;padding:7px 0;border-bottom:1px solid var(--rule-soft)}
.seg .m{font-family:var(--mono);font-size:10.5px;color:var(--ink-soft)}
</style></head>
<body><div class="wrap">
<header>
  <p class="eyebrow">Meeting Intelligence</p>
  <h1>Meetings</h1>
</header>

<div class="filters">
  <div class="field"><label for="language">Language</label><select id="language"><option value="">All</option></select></div>
  <div class="field"><label for="sentiment">Topic sentiment</label><select id="sentiment"><option value="">Any</option></select></div>
  <div class="field"><label for="status">Status</label><select id="status"><option value="">Any</option></select></div>
  <div class="field"><label for="from">From</label><input type="date" id="from"></div>
  <div class="field"><label for="to">To</label><input type="date" id="to"></div>
  <div class="field"><label for="q">Spoken words</label><input type="search" id="q" placeholder="searches the transcript"></div>
  <button id="apply">Filter</button>
  <button id="reset" class="ghost">Reset</button>
</div>
<p class="count" id="count">Loading…</p>

<table>
  <thead><tr><th>Recorded</th><th>Language</th><th>Length</th><th>Speakers</th><th>Quotes</th><th>Actions</th><th>Summary</th></tr></thead>
  <tbody id="rows"></tbody>
</table>

<dialog id="detail"><div class="dhead"><strong id="dtitle"></strong><button id="close" class="ghost">Close</button></div>
<div class="dbody" id="dbody"></div></dialog>
</div>
<script>
const token = new URLSearchParams(location.search).get('token') || '';
const api = (path, params = {}) => {
  const u = new URLSearchParams({ ...params, token });
  return fetch(path + '?' + u).then((r) => r.json());
};
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const clock = (s) => Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
const langPill = (l, p) => {
  if (!l) return '<span class="pill">unknown</span>';
  const cls = l.slice(0, 2);
  const low = p != null && p < 0.7 ? ' <span class="pill low" title="low confidence">p=' + p.toFixed(2) + '</span>' : '';
  return '<span class="pill ' + cls + '">' + esc(l) + '</span>' + low;
};

async function facets() {
  const f = await api('/dashboard/api/facets');
  const fill = (id, items) => {
    const el = document.getElementById(id);
    for (const it of items) {
      if (it.value == null) continue;
      const o = document.createElement('option');
      o.value = it.value; o.textContent = it.value + ' (' + it.count + ')';
      el.append(o);
    }
  };
  fill('language', f.languages); fill('sentiment', f.sentiments); fill('status', f.statuses);
}

function params() {
  const p = {};
  for (const k of ['language','sentiment','status','from','to','q']) {
    const v = document.getElementById(k).value.trim();
    if (v) p[k] = v;
  }
  return p;
}

async function load() {
  const { meetings } = await api('/dashboard/api/meetings', params());
  document.getElementById('count').textContent =
    meetings.length + (meetings.length === 1 ? ' meeting' : ' meetings');
  const rows = document.getElementById('rows');
  rows.innerHTML = meetings.length ? '' : '<tr><td colspan="7" class="empty">No meetings match these filters.</td></tr>';
  for (const m of meetings) {
    const tr = document.createElement('tr');
    tr.className = 'row';
    tr.innerHTML =
      '<td>' + new Date(m.created_at).toLocaleDateString() + '</td>' +
      '<td>' + langPill(m.language, m.language_probability) + '</td>' +
      '<td>' + clock(m.duration_seconds ?? 0) + '</td>' +
      '<td>' + (m.speakers ?? 0) + '</td>' +
      '<td>' + (m.quotes ?? 0) + '</td>' +
      '<td>' + (m.action_items ?? 0) + '</td>' +
      '<td class="sum">' + esc((m.english_summary ?? '').slice(0, 150)) + '…</td>';
    tr.addEventListener('click', () => open(m.id));
    rows.append(tr);
  }
}

async function open(id) {
  const { meeting, segments } = await api('/dashboard/api/meetings/' + id);
  document.getElementById('dtitle').textContent =
    (meeting.language ?? 'unknown') + ' · ' + clock(meeting.duration_seconds ?? 0) + ' · ' + segments.length + ' segments';
  const quotes = meeting.quotes ?? [];
  const topics = meeting.sentiment?.per_topic ?? [];
  document.getElementById('dbody').innerHTML =
    '<h3>English summary</h3><div class="card">' + esc(meeting.english_summary) + '</div>' +
    '<h3>Source-language summary</h3><div class="card nat">' + esc(meeting.telugu_summary) + '</div>' +
    (topics.length ? '<h3>Sentiment by topic</h3>' + topics.map((t) =>
      '<div class="card">' + esc(t.subject) + ' — <strong>' + esc(t.sentiment) + '</strong><br>' +
      '<span class="sum">' + esc(t.evidence) + '</span></div>').join('') : '') +
    (quotes.length ? '<h3>Quotes</h3>' + quotes.map((q) =>
      '<div class="card"><span class="pill">' + esc(q.speaker_label) + '</span>' +
      '<p class="nat">' + esc(q.text_te) + '</p><p class="sum">' + esc(q.text_en) + '</p></div>').join('') : '') +
    '<h3>Transcript</h3>' + segments.map((s) =>
      '<div class="seg"><div class="m">' + esc(s.diarization_label) + '<br>' + clock(Math.floor(s.start_ms / 1000)) +
      '</div><div class="nat">' + esc(s.text_te) + '</div></div>').join('');
  document.getElementById('detail').showModal();
}

document.getElementById('apply').addEventListener('click', load);
document.getElementById('q').addEventListener('keydown', (e) => { if (e.key === 'Enter') load(); });
document.getElementById('reset').addEventListener('click', () => {
  for (const k of ['language','sentiment','status','from','to','q']) document.getElementById(k).value = '';
  load();
});
document.getElementById('close').addEventListener('click', () => document.getElementById('detail').close());
facets().then(load);
</script>
</body></html>`;
