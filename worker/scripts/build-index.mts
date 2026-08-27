/**
 * Builds the landing page that links every published language report.
 *
 *   npx tsx scripts/build-index.mts scripts/reports.json <out.html>
 *
 * The manifest is the single place a new language is registered; the counts
 * shown on each card are read from that language's result/analysis JSON rather
 * than typed by hand, so they cannot drift from the report they link to.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const [, , manifestPath, outPath] = process.argv;

type Entry = {
  slug: string;
  name: string;
  native: string;
  tag: string;
  note?: string;
  /** Set for a report published without a local result/analysis pair. */
  live?: boolean;
  /** Supply both to have the card's counts read from the data itself. */
  result?: string;
  analysis?: string;
};

const entries: Entry[] = JSON.parse(readFileSync(manifestPath, 'utf8'));
const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

const FONTS: Record<string, string> = {
  te: 'Noto Sans Telugu', hi: 'Noto Sans Devanagari', mr: 'Noto Sans Devanagari',
  ta: 'Noto Sans Tamil', ml: 'Noto Sans Malayalam', kn: 'Noto Sans Kannada',
  bn: 'Noto Sans Bengali', gu: 'Noto Sans Gujarati', pa: 'Noto Sans Gurmukhi',
  or: 'Noto Sans Oriya',
};
const fonts = [...new Set(entries.map((e) => FONTS[e.tag]).filter(Boolean))];

function card(e: Entry): string {
  let detail = e.note ?? '';
  let action = '<span class="tag">Pending</span>';
  if (e.result && e.analysis) {
    const segs = JSON.parse(readFileSync(e.result, 'utf8')).segments as any[];
    const quotes = (JSON.parse(readFileSync(e.analysis, 'utf8')).quotes ?? []).length;
    const ms = Math.max(...segs.map((s) => s.end_ms));
    const speakers = new Set(segs.map((s) => s.diarization_label)).size;
    const clock = `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;
    detail = `${detail}${detail ? ' ' : ''}Meeting of ${clock}, ${speakers} speakers detected, ${quotes} verbatim quotes.`;
    action = `<a class="open" href="${esc(e.slug)}/">Open</a>`;
  } else if (e.live) {
    action = `<a class="open" href="${esc(e.slug)}/">Open</a>`;
  } else {
    detail = `${detail}${detail ? ' ' : ''}Script written; recording not yet processed.`;
  }
  return `  <li class="report${e.result || e.live ? ' live' : ''}">
    <p class="name">${esc(e.name)} <span class="native ${esc(e.tag)}">${esc(e.native)}</span></p>
    ${action}
    <p class="detail">${esc(detail)}</p>
  </li>`;
}

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Meeting Intelligence — Language Reports</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&${fonts
  .map((f) => `family=${f.replace(/ /g, '+')}:wght@400;500`)
  .join('&')}&family=Source+Serif+4:opsz,wght@8..60,400;8..60,600&display=swap">
<style>
/* Palette shared with the reports so the set reads as one system. */
:root {
  --ground:#EFF2EC; --panel:#FAFBF7; --raised:#F5F7F1;
  --ink:#191D17; --ink-soft:#5A6357;
  --rule:#D8DED2; --rule-soft:#E6EADF;
  --accent:#1F3A5F; --accent-soft:#E4E9F1;
  --pos:#2F6B4B; --pos-soft:#E1EDE3;
  --mid:#8A6A2B; --mid-soft:#F2EBDC;
  --serif:"Source Serif 4",Georgia,serif;
  --sans:"IBM Plex Sans",system-ui,sans-serif;
  --mono:"IBM Plex Mono",ui-monospace,monospace;
}
@media (prefers-color-scheme:dark) {
  :root:not([data-theme="light"]) {
    --ground:#14170F; --panel:#1B1F17; --raised:#212619;
    --ink:#E7EBE0; --ink-soft:#9AA492;
    --rule:#2C3227; --rule-soft:#242A20;
    --accent:#9DB8DC; --accent-soft:#1B2433;
    --pos:#82C39F; --pos-soft:#17251C;
    --mid:#D2B172; --mid-soft:#282014;
  }
}
:root[data-theme="dark"] {
  --ground:#14170F; --panel:#1B1F17; --raised:#212619;
  --ink:#E7EBE0; --ink-soft:#9AA492;
  --rule:#2C3227; --rule-soft:#242A20;
  --accent:#9DB8DC; --accent-soft:#1B2433;
  --pos:#82C39F; --pos-soft:#17251C;
  --mid:#D2B172; --mid-soft:#282014;
}
* { box-sizing:border-box; }
body {
  margin:0; background:var(--ground);
  background-image:linear-gradient(var(--raised), transparent 260px); color:var(--ink);
  font-family:var(--sans); font-size:15px; line-height:1.55; -webkit-font-smoothing:antialiased;
}
.wrap { max-width:900px; margin:0 auto; padding:clamp(28px,5vw,64px) clamp(18px,4vw,40px) 80px; }
header { border-bottom:2px solid var(--ink); padding-bottom:22px; margin-bottom:26px; }
.eyebrow { font-family:var(--mono); font-size:11px; letter-spacing:.14em; text-transform:uppercase; color:var(--ink-soft); margin:0 0 10px; }
h1 { font-family:var(--serif); font-weight:600; font-size:clamp(28px,4.4vw,40px); line-height:1.1; margin:0 0 12px; text-wrap:balance; letter-spacing:-.015em; }
.lede { margin:0; max-width:62ch; color:var(--ink-soft); font-size:16px; }
ul.reports { list-style:none; margin:0; padding:0; display:grid; gap:14px; }
li.report { background:var(--panel); border:1px solid var(--rule); border-radius:10px; padding:18px 20px; display:grid; gap:4px; grid-template-columns:1fr auto; align-items:start; }
li.report.live { border-left:3px solid var(--pos); }
.name { font-family:var(--serif); font-size:20px; font-weight:600; margin:0; }
.native { font-size:15px; color:var(--ink-soft); }
${Object.entries(FONTS)
  .filter(([tag]) => entries.some((e) => e.tag === tag))
  .map(([tag, font]) => `.native.${tag} { font-family:"${font}",var(--sans); }`)
  .join('\n')}
.detail { grid-column:1/-1; color:var(--ink-soft); font-size:14px; margin:2px 0 0; }
a.open { font-family:var(--mono); font-size:12px; letter-spacing:.06em; text-transform:uppercase; color:var(--accent); background:var(--accent-soft); border:1px solid var(--rule); padding:7px 13px; border-radius:6px; text-decoration:none; white-space:nowrap; }
a.open:hover { border-color:var(--accent); }
.tag { font-family:var(--mono); font-size:11px; letter-spacing:.08em; text-transform:uppercase; padding:7px 13px; border-radius:6px; white-space:nowrap; color:var(--mid); background:var(--mid-soft); border:1px solid var(--rule); }
footer { margin-top:34px; padding-top:18px; border-top:1px solid var(--rule); color:var(--ink-soft); font-size:13px; max-width:70ch; }
</style>
</head>
<body>
<div class="wrap">
<header>
  <p class="eyebrow">Meeting Intelligence</p>
  <h1>Language reports</h1>
  <p class="lede">Per-meeting analysis of recorded community meetings — transcript, speaker
  attribution, verbatim quotes and sentiment — one report per language variant.</p>
</header>

<ul class="reports">
${entries.map(card).join('\n')}
</ul>

<footer>Every report other than Telugu uses the same meeting — identical facts, speakers and
structure — so the variants can be compared directly against one another. Their audio is
synthetic text-to-speech and does not establish real-world recognition accuracy.</footer>
</div>
</body>
</html>
`;

writeFileSync(outPath, html);
console.log(`index: ${entries.length} languages (${entries.filter((e) => e.result || e.live).length} live) -> ${outPath}`);
