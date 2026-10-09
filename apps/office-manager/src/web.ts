import { renderMarkdown } from './markdown';

/**
 * The web chat. One self-contained page, served with a per-request CSP nonce.
 *
 * Design: a contractor's estimate pad. Cool graph-paper ground, navy ink,
 * Archivo / Archivo Narrow with tabular figures for money. The one loud
 * element is the trace strip under each answer, which shows how the answer was
 * produced: route and model, tools, the Estimator delegation over A2A, any
 * blocked write, and the cost. That strip is the point of this demo.
 *
 * The API key lives in sessionStorage (gone when the tab closes) and is only
 * ever sent as a Bearer header to this origin (CSP connect-src 'self').
 */
export function chatPage(nonce: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Office Manager</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link nonce="${nonce}" rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600&family=Archivo+Narrow:wght@500;600&display=swap">
<style nonce="${nonce}">
  :root {
    --paper: #f5f7f6; --grid: #dfe6e4; --sheet: #ffffff; --ink: #1d2b3a; --graphite: #5d6672;
    --rule: #c9d3d1; --highlight: #f4d63e; --ok: #2f6b4f; --stop: #a8322a; --focus: #2b5fb8;
    --narrow: 'Archivo Narrow', 'Arial Narrow', 'Helvetica Neue', Arial, sans-serif;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; }
  body {
    font: 16px/1.55 Archivo, 'Helvetica Neue', Arial, sans-serif; color: var(--ink);
    background-color: var(--paper);
    background-image: linear-gradient(var(--grid) 1px, transparent 1px), linear-gradient(90deg, var(--grid) 1px, transparent 1px);
    background-size: 24px 24px; min-height: 100vh;
    font-variant-numeric: tabular-nums;
  }
  :focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; }
  button { font: inherit; cursor: pointer; }
  .wrap { max-width: 760px; margin: 0 auto; padding: 24px 20px 160px; }
  header { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; padding-bottom: 14px; border-bottom: 2px solid var(--ink); }
  h1 { font-family: var(--narrow); font-weight: 600; font-size: 30px; letter-spacing: -0.01em; margin: 0; }
  .tools { display: flex; gap: 6px; flex-wrap: wrap; }
  .linkbtn { background: none; border: 0; color: var(--graphite); padding: 4px 6px; text-decoration: underline; text-underline-offset: 3px; }
  .linkbtn:hover { color: var(--ink); }
  .lede { color: var(--graphite); margin: 12px 0 28px; max-width: 60ch; }

  .connect { background: var(--sheet); border: 1px solid var(--rule); padding: 20px; margin-bottom: 24px; }
  .connect label { display: block; font-weight: 600; margin-bottom: 6px; }
  .connect p { color: var(--graphite); margin: 0 0 12px; font-size: 14px; }
  .row { display: flex; gap: 8px; }
  input[type=password], textarea {
    font: inherit; color: var(--ink); background: var(--sheet); border: 1px solid var(--rule); padding: 10px 12px; width: 100%;
  }
  .primary { background: var(--ink); color: #fff; border: 0; padding: 10px 18px; font-weight: 600; white-space: nowrap; }
  .primary:disabled { opacity: .5; cursor: default; }

  .examples { display: grid; gap: 8px; margin-bottom: 28px; }
  .examples button { text-align: left; background: var(--sheet); border: 1px solid var(--rule); padding: 10px 14px; color: var(--ink); }
  .examples button:hover { border-color: var(--ink); }

  .you { margin: 22px 0 8px auto; max-width: 85%; width: fit-content; background: var(--ink); color: #fff; padding: 10px 14px; }
  .answer { background: var(--sheet); border: 1px solid var(--rule); border-top: 4px solid var(--ink); padding: 16px 18px 12px; }
  .answer p { margin: 0 0 10px; }
  .answer ul, .answer ol { margin: 0 0 10px; padding-left: 22px; }
  .answer table { border-collapse: collapse; margin: 4px 0 12px; width: 100%; font-size: 15px; display: block; overflow-x: auto; }
  .answer th { font-family: var(--narrow); font-weight: 600; text-align: left; border-bottom: 2px solid var(--ink); padding: 6px 10px 6px 0; }
  .answer td { border-bottom: 1px solid var(--grid); padding: 6px 10px 6px 0; }
  .answer code { background: var(--paper); padding: 1px 4px; }
  .working { color: var(--graphite); font-style: italic; }
  .error { border-top-color: var(--stop); }

  /* The trace strip: how this answer was produced. */
  .trace { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; padding-top: 10px; border-top: 1px dashed var(--rule); font-family: var(--narrow); font-size: 14px; }
  .chip { border: 1px solid var(--rule); padding: 1px 8px; color: var(--graphite); background: var(--paper); }
  .chip.route { color: var(--ink); border-color: var(--ink); }
  .chip.a2a { background: var(--highlight); border-color: #c9ab12; color: var(--ink); font-weight: 600; }
  .chip.blocked { color: var(--stop); border-color: var(--stop); }
  .chip.write { color: var(--ok); border-color: var(--ok); font-weight: 600; }
  .chip.cost { margin-left: auto; color: var(--ink); border-style: dashed; }

  .usage { background: var(--sheet); border: 1px solid var(--rule); padding: 16px 18px; margin-bottom: 24px; }
  .usage h2 { font-family: var(--narrow); font-size: 20px; margin: 0 0 8px; }
  .meter { height: 10px; background: var(--grid); margin: 6px 0 14px; }
  .meter span { display: block; height: 100%; background: var(--ink); }
  .usage table { border-collapse: collapse; width: 100%; font-size: 14px; }
  .usage th, .usage td { text-align: left; padding: 4px 8px 4px 0; border-bottom: 1px solid var(--grid); }

  .composer { position: fixed; left: 0; right: 0; bottom: 0; background: linear-gradient(transparent, var(--paper) 30%); padding: 28px 20px 18px; }
  .composer .row { max-width: 760px; margin: 0 auto; }
  textarea { resize: none; height: 52px; }
  [hidden] { display: none !important; }
  @media (max-width: 560px) { h1 { font-size: 24px; } .you { max-width: 100%; } .chip.cost { margin-left: 0; } }
  @media (prefers-reduced-motion: no-preference) { .answer { animation: in .18s ease-out; } @keyframes in { from { opacity: 0; transform: translateY(4px); } } }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>Office Manager</h1>
    <div class="tools">
      <button class="linkbtn" id="newchat" type="button">New conversation</button>
      <button class="linkbtn" id="usagebtn" type="button">This month's usage</button>
      <button class="linkbtn" id="forget" type="button" hidden>Forget key</button>
    </div>
  </header>
  <p class="lede">Ask about customers, invoices and estimates. Answers come from your QuickBooks books; estimates are drafted from your own past jobs and only saved when you approve them.</p>

  <section class="connect" id="connect" aria-labelledby="keylabel">
    <label id="keylabel" for="key">API key</label>
    <p>Paste the key you were given. It stays in this browser tab and is cleared when you close it.</p>
    <div class="row"><input id="key" type="password" autocomplete="off" placeholder="cok_..."><button class="primary" id="savekey" type="button">Connect</button></div>
  </section>

  <section class="usage" id="usage" hidden aria-live="polite"></section>

  <section class="examples" id="examples" aria-label="Example questions">
    <button type="button">Which customers owe me more than 60 days?</button>
    <button type="button">What was my revenue by service in Q3?</button>
    <button type="button">Draft an estimate for a bathroom remodel for Mark Johnson</button>
  </section>

  <main id="log" aria-live="polite"></main>
</div>

<div class="composer">
  <div class="row">
    <textarea id="msg" placeholder="Ask a question or describe a job to estimate" aria-label="Message"></textarea>
    <button class="primary" id="send" type="button">Send</button>
  </div>
</div>

<script nonce="${nonce}">
const renderMarkdown = ${renderMarkdown.toString()};
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
let key = sessionStorage.getItem('co_key') || '';
let conversationId = null;
let busy = false;

function showKeyState() {
  $('connect').hidden = Boolean(key);
  $('forget').hidden = !key;
}
showKeyState();

$('savekey').onclick = () => {
  const v = $('key').value.trim();
  if (!/^cok_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/.test(v)) { $('key').setCustomValidity('That does not look like a Contractor Ops key.'); $('key').reportValidity(); return; }
  key = v; sessionStorage.setItem('co_key', v); $('key').value = ''; showKeyState(); $('msg').focus();
};
$('key').oninput = () => $('key').setCustomValidity('');
$('forget').onclick = () => { sessionStorage.removeItem('co_key'); key = ''; showKeyState(); };
$('newchat').onclick = () => { conversationId = null; $('log').innerHTML = ''; $('examples').hidden = false; $('msg').focus(); };
for (const b of $('examples').querySelectorAll('button')) b.onclick = () => { $('msg').value = b.textContent; send(); };
$('send').onclick = send;
$('msg').onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } };

const modelName = (m) => (m || '').replace('claude-', '').replace(/-(\\d+)-(\\d+)$/, ' $1.$2').replace(/^./, (c) => c.toUpperCase());

function trace(body) {
  const chips = [];
  if (body.intent) chips.push('<span class="chip route">' + esc(body.intent.replace('_', ' ')) + ' on ' + esc(modelName(body.model)) + '</span>');
  for (const s of body.steps || []) {
    const [kind, ...rest] = s.split(':');
    const name = rest.join(':');
    if (kind === 'tool') chips.push('<span class="chip">' + esc(name.replace(' (error)', '')) + (name.includes('(error)') ? ', error' : '') + '</span>');
    if (kind === 'a2a') chips.push('<span class="chip a2a">Estimator agent via A2A</span>');
    if (kind === 'guard' && name.startsWith('write_guard')) chips.push('<span class="chip blocked">write blocked: needs your approval</span>');
  }
  if (body.wrote) chips.push('<span class="chip write">saved to QuickBooks</span>');
  chips.push('<span class="chip cost">$' + Number(body.cost_usd || 0).toFixed(4) + ' this answer</span>');
  return '<div class="trace" aria-label="How this answer was produced">' + chips.join('') + '</div>';
}

function add(html, cls) {
  const el = document.createElement('div');
  el.className = cls;
  el.innerHTML = html;
  $('log').appendChild(el);
  el.scrollIntoView({ block: 'end', behavior: 'smooth' });
  return el;
}

async function send() {
  const text = $('msg').value.trim();
  if (!text || busy) return;
  if (!key) { $('connect').hidden = false; $('key').focus(); return; }
  busy = true; $('send').disabled = true; $('examples').hidden = true; $('msg').value = '';
  add(esc(text), 'you');
  const pending = add('<p class="working">Working on it… <span>0</span>s</p>', 'answer');
  const t0 = Date.now();
  const tick = setInterval(() => { const s = pending.querySelector('.working span'); if (s) s.textContent = Math.round((Date.now() - t0) / 1000); }, 1000);
  try {
    const res = await fetch('chat', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key }, body: JSON.stringify({ message: text, conversation_id: conversationId }) });
    const body = await res.json().catch(() => ({}));
    if (res.status === 401) { pending.classList.add('error'); pending.innerHTML = '<p>That key was not accepted. Use "Forget key" and paste a valid one.</p>'; return; }
    if (res.status === 429) { pending.classList.add('error'); pending.innerHTML = '<p>Too many messages in a minute. Wait a moment, then send again.</p>'; return; }
    if (!res.ok && res.status !== 402) { pending.classList.add('error'); pending.innerHTML = '<p>The Office Manager returned an error (' + res.status + '). Send the message again.</p>'; return; }
    conversationId = body.conversation_id || conversationId;
    if (body.status !== 'completed') pending.classList.add('error');
    pending.innerHTML = renderMarkdown(body.reply || '') + trace(body);
  } catch {
    pending.classList.add('error');
    pending.innerHTML = '<p>Could not reach the Office Manager. Check your connection, then send again.</p>';
  } finally {
    clearInterval(tick); busy = false; $('send').disabled = false; $('msg').focus();
  }
}

$('usagebtn').onclick = async () => {
  const box = $('usage');
  if (!box.hidden) { box.hidden = true; return; }
  if (!key) { $('connect').hidden = false; return; }
  box.hidden = false; box.innerHTML = '<p class="working">Loading usage…</p>';
  try {
    const res = await fetch('usage', { headers: { authorization: 'Bearer ' + key } });
    if (!res.ok) throw new Error(String(res.status));
    const u = await res.json();
    const spent = Number(u.spend.spent_usd || 0), cap = Number(u.spend.cap_usd || 0);
    const runs = (u.agent_runs || []).reduce((s, r) => s + r.runs, 0);
    box.innerHTML = '<h2>Usage for ' + esc(u.month) + '</h2>'
      + '<p>$' + spent.toFixed(4) + ' of the $' + cap.toFixed(2) + ' monthly AI budget, across ' + runs + ' agent runs and ' + (u.quickbooks_api?.calls ?? 0) + ' QuickBooks API calls.</p>'
      + '<div class="meter" role="img" aria-label="' + Math.round((spent / (cap || 1)) * 100) + ' percent of budget used"><span></span></div>'
      + '<table><thead><tr><th>Model</th><th>Used for</th><th>Calls</th><th>Cost</th></tr></thead><tbody>'
      + (u.llm || []).map((r) => '<tr><td>' + esc(modelName(r.model)) + '</td><td>' + esc(r.purpose) + '</td><td>' + r.calls + '</td><td>$' + Number(r.cost_usd).toFixed(4) + '</td></tr>').join('')
      + '</tbody></table>';
    // Set via CSSOM: inline style attributes are blocked by the page's CSP.
    box.querySelector('.meter span').style.width = Math.min(100, (spent / (cap || 1)) * 100).toFixed(1) + '%';
  } catch {
    box.innerHTML = '<p>Usage could not be loaded. Check that your key is connected, then try again.</p>';
  }
};
</script>
</body>
</html>`;
}
