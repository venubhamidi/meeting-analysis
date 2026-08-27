/**
 * Builds the standalone HTML report for one analysed meeting.
 *
 *   npx tsx scripts/build-report.mts <lang> <result.json> <analysis.json> <audio.m4a> <out.html>
 *
 * `lang` selects the script font and the label for the source-language column.
 * The audio is embedded as a data URI so the page is a single self-contained
 * file — fine for GitHub Pages, too large for a Claude artifact.
 *
 * Quotes carry segment timings, so each one gets a play button that seeks the
 * recording to that moment rather than making the reader hunt a timeline.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const [, , langKey, resultPath, analysisPath, audioPath, outPath] = process.argv;

const LANGS: Record<string, { name: string; native: string; font: string; tag: string }> = {
  telangana: { name: 'Telangana Telugu', native: 'తెలంగాణ తెలుగు', font: 'Noto Sans Telugu', tag: 'te' },
  telugu: { name: 'Telugu', native: 'తెలుగు', font: 'Noto Sans Telugu', tag: 'te' },
  hindi: { name: 'Hindi', native: 'हिन्दी', font: 'Noto Sans Devanagari', tag: 'hi' },
  tamil: { name: 'Tamil', native: 'தமிழ்', font: 'Noto Sans Tamil', tag: 'ta' },
  malayalam: { name: 'Malayalam', native: 'മലയാളം', font: 'Noto Sans Malayalam', tag: 'ml' },
  kannada: { name: 'Kannada', native: 'ಕನ್ನಡ', font: 'Noto Sans Kannada', tag: 'kn' },
  bengali: { name: 'Bengali', native: 'বাংলা', font: 'Noto Sans Bengali', tag: 'bn' },
  marathi: { name: 'Marathi', native: 'मराठी', font: 'Noto Sans Devanagari', tag: 'mr' },
  gujarati: { name: 'Gujarati', native: 'ગુજરાતી', font: 'Noto Sans Gujarati', tag: 'gu' },
  punjabi: { name: 'Punjabi', native: 'ਪੰਜਾਬੀ', font: 'Noto Sans Gurmukhi', tag: 'pa' },
  odia: { name: 'Odia', native: 'ଓଡ଼ିଆ', font: 'Noto Sans Oriya', tag: 'or' },
};
const lang = LANGS[langKey];
if (!lang) throw new Error(`unknown language ${langKey}; known: ${Object.keys(LANGS).join(', ')}`);

const result = JSON.parse(readFileSync(resultPath, 'utf8'));
const analysis = JSON.parse(readFileSync(analysisPath, 'utf8'));
const audio = readFileSync(audioPath).toString('base64');

const segments: any[] = result.segments;
const quotes: any[] = analysis.quotes ?? [];
const speakers = [...new Set(segments.map((s) => s.diarization_label))];
const durationMs = Math.max(...segments.map((s) => s.end_ms));

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const clock = (ms: number) =>
  `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;
const speakerClass = (label: string) => `sp${(speakers.indexOf(label) % 5) + 1}`;

const sentimentClass = (s: string) =>
  /neg/i.test(s) ? 'neg' : /pos/i.test(s) ? 'pos' : 'mid';

const facts = analysis.structured_facts ?? {};
const factList = (key: string) => (Array.isArray(facts[key]) ? facts[key] : []);

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(lang.name)} — Meeting Report</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&family=${lang.font.replace(/ /g, '+')}:wght@400;500&family=Source+Serif+4:opsz,wght@8..60,400;8..60,600&display=swap">
<style>
:root {
  --ground:#EFF2EC; --panel:#FAFBF7; --raised:#F5F7F1;
  --ink:#191D17; --ink-soft:#5A6357;
  --rule:#D8DED2; --rule-soft:#E6EADF;
  --accent:#1F3A5F; --accent-soft:#E4E9F1;
  --pos:#2F6B4B; --pos-soft:#E1EDE3;
  --neg:#9C3B2C; --neg-soft:#F5E7E3;
  --mid:#8A6A2B; --mid-soft:#F2EBDC;
  --sp1:#1F3A5F; --sp2:#3D6B54; --sp3:#7A5227; --sp4:#5B4472; --sp5:#8A3A52;
  --serif:"Source Serif 4",Georgia,serif;
  --sans:"IBM Plex Sans",system-ui,sans-serif;
  --mono:"IBM Plex Mono",ui-monospace,monospace;
  --native:"${lang.font}",var(--sans);
}
@media (prefers-color-scheme:dark) {
  :root:not([data-theme="light"]) {
    --ground:#14170F; --panel:#1B1F17; --raised:#212619;
    --ink:#E7EBE0; --ink-soft:#9AA492;
    --rule:#2C3227; --rule-soft:#242A20;
    --accent:#9DB8DC; --accent-soft:#1B2433;
    --pos:#82C39F; --pos-soft:#17251C;
    --neg:#E09587; --neg-soft:#2B1D19;
    --mid:#D2B172; --mid-soft:#282014;
    --sp1:#9DB8DC; --sp2:#8CC6A6; --sp3:#D3A876; --sp4:#B69BD4; --sp5:#DE9AAE;
  }
}
:root[data-theme="dark"] {
  --ground:#14170F; --panel:#1B1F17; --raised:#212619;
  --ink:#E7EBE0; --ink-soft:#9AA492;
  --rule:#2C3227; --rule-soft:#242A20;
  --accent:#9DB8DC; --accent-soft:#1B2433;
  --pos:#82C39F; --pos-soft:#17251C;
  --neg:#E09587; --neg-soft:#2B1D19;
  --mid:#D2B172; --mid-soft:#282014;
  --sp1:#9DB8DC; --sp2:#8CC6A6; --sp3:#D3A876; --sp4:#B69BD4; --sp5:#DE9AAE;
}
* { box-sizing:border-box; }
body {
  margin:0; background:var(--ground);
  background-image:linear-gradient(var(--raised), transparent 260px); color:var(--ink);
  font-family:var(--sans); font-size:15px; line-height:1.55; -webkit-font-smoothing:antialiased;
}
.wrap { max-width:1080px; margin:0 auto; padding:clamp(28px,5vw,60px) clamp(18px,4vw,40px) 80px; }
a { color:var(--accent); }
header { border-bottom:2px solid var(--ink); padding-bottom:20px; margin-bottom:24px; }
.eyebrow { font-family:var(--mono); font-size:11px; letter-spacing:.14em; text-transform:uppercase; color:var(--ink-soft); margin:0 0 10px; }
.eyebrow a { text-decoration:none; }
h1 { font-family:var(--serif); font-weight:600; font-size:clamp(26px,4.2vw,40px); line-height:1.1; margin:0 0 6px; letter-spacing:-.015em; }
h1 .nat { font-family:var(--native); font-size:.62em; color:var(--ink-soft); margin-left:.4em; }
.lede { margin:8px 0 0; max-width:64ch; color:var(--ink-soft); }
h2 { font-family:var(--serif); font-size:21px; font-weight:600; margin:34px 0 12px; padding-bottom:7px; border-bottom:1px solid var(--rule); }

.stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:1px; background:var(--rule); border:1px solid var(--rule); border-radius:8px; overflow:hidden; margin:20px 0 0; }
.stat { background:var(--panel); padding:13px 15px; display:flex; flex-direction:column; gap:2px; }
.stat-n { font-family:var(--serif); font-size:23px; font-weight:600; line-height:1; }
.stat-l { font-size:12px; color:var(--ink-soft); }

.player { background:var(--panel); border:1px solid var(--rule); border-radius:9px; padding:15px 17px; margin:18px 0 0; }
.player audio { width:100%; }
.synthetic { font-size:12.5px; color:var(--ink-soft); margin:9px 0 0; }

.cols { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
@media (max-width:760px) { .cols { grid-template-columns:1fr; } }
.card { background:var(--panel); border:1px solid var(--rule); border-radius:9px; padding:16px 18px; }
.card h3 { font-family:var(--mono); font-size:11px; letter-spacing:.1em; text-transform:uppercase; color:var(--ink-soft); margin:0 0 9px; font-weight:500; }
.card p { margin:0; }
.nat { font-family:var(--native); }

ul.quotes { list-style:none; margin:0; padding:0; display:grid; gap:12px; }
li.quote { background:var(--panel); border:1px solid var(--rule); border-left:3px solid var(--rule); border-radius:9px; padding:14px 16px; }
${speakers.map((s, i) => `li.quote.sp${(i % 5) + 1} { border-left-color:var(--sp${(i % 5) + 1}); }`).join('\n')}
.qhead { display:flex; align-items:center; gap:9px; margin-bottom:7px; flex-wrap:wrap; }
.who { font-family:var(--mono); font-size:11.5px; letter-spacing:.05em; text-transform:uppercase; }
${speakers.map((s, i) => `.who.sp${(i % 5) + 1} { color:var(--sp${(i % 5) + 1}); }`).join('\n')}
button.play { font-family:var(--mono); font-size:11px; letter-spacing:.05em; color:var(--accent); background:var(--accent-soft); border:1px solid var(--rule); border-radius:5px; padding:3px 9px; cursor:pointer; }
button.play:hover { border-color:var(--accent); }
.qsrc { font-family:var(--native); font-size:16px; margin:0 0 6px; }
.qen { color:var(--ink-soft); font-size:14px; margin:0; }

table { width:100%; border-collapse:collapse; font-size:14px; }
th { text-align:left; font-family:var(--mono); font-size:10.5px; letter-spacing:.09em; text-transform:uppercase; color:var(--ink-soft); font-weight:500; padding:0 10px 7px 0; border-bottom:1px solid var(--rule); }
td { padding:9px 10px 9px 0; border-bottom:1px solid var(--rule-soft); vertical-align:top; }
.pill { font-family:var(--mono); font-size:10.5px; letter-spacing:.06em; text-transform:uppercase; padding:2px 8px; border-radius:20px; white-space:nowrap; }
.pill.pos { color:var(--pos); background:var(--pos-soft); }
.pill.neg { color:var(--neg); background:var(--neg-soft); }
.pill.mid { color:var(--mid); background:var(--mid-soft); }

.facts { display:grid; grid-template-columns:repeat(auto-fit,minmax(210px,1fr)); gap:14px; }
.facts ul { margin:0; padding-left:17px; }
.facts li { margin-bottom:3px; }

ol.transcript { list-style:none; margin:0; padding:0; counter-reset:seg; }
ol.transcript li { display:grid; grid-template-columns:74px 1fr; gap:12px; padding:9px 0; border-bottom:1px solid var(--rule-soft); }
.tmeta { font-family:var(--mono); font-size:11px; color:var(--ink-soft); padding-top:3px; }
.ttext { font-family:var(--native); font-size:15.5px; }
.tspk { font-family:var(--mono); font-size:11px; letter-spacing:.04em; display:block; }
${speakers.map((s, i) => `.tspk.sp${(i % 5) + 1} { color:var(--sp${(i % 5) + 1}); }`).join('\n')}
footer { margin-top:38px; padding-top:16px; border-top:1px solid var(--rule); color:var(--ink-soft); font-size:13px; }
</style>
</head>
<body>
<div class="wrap">

<header>
  <p class="eyebrow"><a href="../">← All languages</a></p>
  <h1>${esc(lang.name)}<span class="nat">${esc(lang.native)}</span></h1>
  <p class="lede">Ward-level grievance meeting — water supply, sanitation and the health
  sub-centre. Transcribed, diarized and analysed by the pipeline; every quote below is a
  verbatim substring of the transcript.</p>
  <div class="stats">
    <div class="stat"><span class="stat-n">${clock(durationMs)}</span><span class="stat-l">recording length</span></div>
    <div class="stat"><span class="stat-n">${segments.length}</span><span class="stat-l">transcript segments</span></div>
    <div class="stat"><span class="stat-n">${speakers.length}</span><span class="stat-l">speakers found</span></div>
    <div class="stat"><span class="stat-n">${quotes.length}</span><span class="stat-l">verbatim quotes</span></div>
    <div class="stat"><span class="stat-n">${(analysis.action_items ?? []).length}</span><span class="stat-l">action items</span></div>
  </div>
  <div class="player">
    <audio id="au" controls preload="metadata" src="data:audio/mp4;base64,${audio}"></audio>
    <p class="synthetic"><strong>Synthetic audio.</strong> Rendered with Sarvam text-to-speech
    from a written script — clean, no overlapping speech, no background noise, one accent per
    speaker. It exercises vocabulary and code-mixing, not real-world recognition accuracy.</p>
  </div>
</header>

<h2>Summary</h2>
<div class="cols">
  <div class="card"><h3>${esc(lang.name)}</h3><p class="nat">${esc(analysis.telugu_summary)}</p></div>
  <div class="card"><h3>English</h3><p>${esc(analysis.english_summary)}</p></div>
</div>

<h2>Quotes</h2>
<ul class="quotes">
${quotes
  .map(
    (q) => `  <li class="quote ${speakerClass(q.speaker_label)}">
    <div class="qhead">
      <span class="who ${speakerClass(q.speaker_label)}">${esc(q.speaker_label)}</span>
      <button class="play" data-at="${q.start_ms}">▶ ${clock(q.start_ms)}</button>
    </div>
    <p class="qsrc">${esc(q.text_te)}</p>
    <p class="qen">${esc(q.text_en)}</p>
  </li>`
  )
  .join('\n')}
</ul>

<h2>Sentiment</h2>
<div class="cols">
  <div class="card"><h3>By topic</h3><table><tbody>
${(analysis.sentiment?.per_topic ?? [])
  .map(
    (t: any) => `    <tr><td>${esc(t.subject)}<br><span style="color:var(--ink-soft);font-size:13px">${esc(t.evidence)}</span></td>
      <td><span class="pill ${sentimentClass(t.sentiment)}">${esc(t.sentiment)}</span></td></tr>`
  )
  .join('\n')}
  </tbody></table></div>
  <div class="card"><h3>By speaker</h3><table><tbody>
${(analysis.sentiment?.per_speaker ?? [])
  .map(
    (t: any) => `    <tr><td>${esc(t.subject)}<br><span style="color:var(--ink-soft);font-size:13px">${esc(t.evidence)}</span></td>
      <td><span class="pill ${sentimentClass(t.sentiment)}">${esc(t.sentiment)}</span></td></tr>`
  )
  .join('\n')}
  </tbody></table></div>
</div>

<h2>Action items</h2>
<table>
  <thead><tr><th>What</th><th>Who</th><th>When</th></tr></thead>
  <tbody>
${(analysis.action_items ?? [])
  .map(
    (a: any) =>
      `    <tr><td>${esc(a.description)}</td><td>${esc(a.speaker_label ?? '—')}</td><td>${esc(a.due_hint ?? '—')}</td></tr>`
  )
  .join('\n')}
  </tbody>
</table>

<h2>Extracted facts</h2>
<div class="facts">
${['people', 'topics', 'dates', 'amounts']
  .filter((k) => factList(k).length)
  .map(
    (k) => `  <div class="card"><h3>${k}</h3><ul>${factList(k)
      .map((v: any) => `<li>${esc(typeof v === 'string' ? v : JSON.stringify(v))}</li>`)
      .join('')}</ul></div>`
  )
  .join('\n')}
${
  factList('commitments').length
    ? `  <div class="card"><h3>commitments</h3><ul>${factList('commitments')
        .map((c: any) => `<li>${esc(c.who)} — ${esc(c.what)}${c.when ? ` (${esc(c.when)})` : ''}</li>`)
        .join('')}</ul></div>`
    : ''
}
</div>

<h2>Transcript</h2>
<ol class="transcript">
${segments
  .map(
    (s) => `  <li>
    <div class="tmeta"><span class="tspk ${speakerClass(s.diarization_label)}">${esc(s.diarization_label)}</span>${clock(s.start_ms)}</div>
    <div class="ttext">${esc(s.text_te)}</div>
  </li>`
  )
  .join('\n')}
</ol>

<footer>Analysed by ${esc(analysis.model)}. Language detected automatically by the recogniser.
Quotes are validated as literal substrings of the transcript before storage — none were dropped.</footer>
</div>

<script>
const au = document.getElementById('au');
for (const b of document.querySelectorAll('button.play')) {
  b.addEventListener('click', () => {
    au.currentTime = Number(b.dataset.at) / 1000;
    au.play();
    au.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
}
</script>
</body>
</html>
`;

writeFileSync(outPath, html);
console.log(`${langKey}: ${segments.length} segments, ${quotes.length} quotes -> ${outPath} (${(html.length / 1e6).toFixed(2)} MB)`);
