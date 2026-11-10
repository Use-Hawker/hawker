// HAWKER site: the nav, the footer and each page's live parts, all from the gateway's own API.
// One file for every page; <body data-page="..."> says which parts run.
(() => {
  // filled in at launch
  const CONFIG = { contract: '', github: '', x: '' };
  const EXPLORER = 'https://robinhoodchain.blockscout.com';
  const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
  const page = document.body.dataset.page || 'home';
  const $ = (id) => document.getElementById(id);
  const all = (sel) => [...document.querySelectorAll(sel)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '–');
  const money = (n) => (n >= 100 ? n.toFixed(0) : n >= 1 ? n.toFixed(2) : String(+Number(n).toFixed(4)));
  const ago = (t) => { const s = Math.max(0, (Date.now() - t) / 1000); return s < 60 ? `${Math.floor(s)}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : new Date(t).toISOString().slice(0, 10); };
  const api = async (path, body) => {
    try {
      const r = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    } catch { return { status: 0, body: {} }; }
  };
  const link = (href, text) => `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(text)}</a>`;

  // ---------- nav and footer ----------
  const LINKS = [['stalls', '/stalls/', 'Stalls'], ['agents', '/agents/', 'For agents'], ['sell', '/sell/', 'Sell'], ['ledger', '/ledger/', 'Ledger'], ['docs', '/docs/', 'Docs']];
  $('nav').innerHTML = `<a class="brand" href="/"><img src="/logo.svg" alt="">HAWKER</a>${LINKS.map(([k, href, t]) => `<a class="link${k === page ? ' on' : ''}" href="${href}">${t}</a>`).join('')}${CONFIG.github ? `<a class="link" href="${esc(CONFIG.github)}" target="_blank" rel="noopener">GitHub</a>` : ''}`;
  $('footer').innerHTML = `<div class="wrap">
    <div><div class="brand"><img src="/logo.svg" alt="">HAWKER</div><p>APIs sold by the call to AI agents. Paid in USDG on Robinhood Chain, straight to the seller.</p></div>
    <div><h5>Market</h5><a href="/stalls/">Stalls</a><a href="/ledger/">Ledger</a><a href="/sell/">Open a stall</a></div>
    <div><h5>Build</h5><a href="/agents/">Agent kit</a><a href="/docs/">Docs</a><a href="/docs/#api">API</a><a href="/docs/#till">The till</a></div>
    <div><h5>Elsewhere</h5>${CONFIG.x ? link(CONFIG.x, 'X') : ''}${CONFIG.github ? link(CONFIG.github, 'GitHub') : ''}${CONFIG.contract ? link(`https://ponsfamily.com/launchpad/${CONFIG.contract}`, '$HAWKER on Pons') : ''}<a href="/v1" target="_blank" rel="noopener">API status</a></div>
    <div class="base"><span>HAWKER · Robinhood Chain (4663)</span><span>Not affiliated with Robinhood or Paxos. USDG is issued by Paxos.</span></div></div>`;

  if (CONFIG.contract && $('ca')) {
    $('ca').classList.add('on');
    $('caText').textContent = CONFIG.contract;
    $('caPons').href = `https://ponsfamily.com/launchpad/${CONFIG.contract}`;
    $('caCopy').onclick = () => navigator.clipboard.writeText(CONFIG.contract).then(() => { $('caCopy').textContent = 'copied'; setTimeout(() => { $('caCopy').textContent = 'copy'; }, 1200); });
  }
  if (CONFIG.github) for (const el of all('.ghLink')) { el.href = CONFIG.github; el.hidden = false; }
  for (const el of all('.ghText')) el.textContent = CONFIG.github ? CONFIG.github.replace('https://', '') : 'the GitHub repo (public at launch)';

  // ---------- what the gateway says about itself ----------
  let info = {};
  async function loadInfo() {
    const r = await api('/v1');
    if (r.status !== 200) return;
    info = r.body;
    for (const el of all('.tillAddr')) el.innerHTML = info.till ? `<a class="mono" href="${EXPLORER}/address/${esc(info.till)}" target="_blank" rel="noopener">${esc(info.till)}</a>` : 'not deployed yet';
    for (const el of all('.tillText')) el.textContent = info.till || '0x… (the till, once deployed)';
    for (const el of all('.settlerAddr')) el.innerHTML = info.settler ? `<a class="mono" href="${EXPLORER}/address/${esc(info.settler)}" target="_blank" rel="noopener">${esc(info.settler)}</a>` : '–';
    for (const el of all('.feeText')) el.textContent = `${info.feeBps / 100}%`;
    for (const el of all('.minText')) el.textContent = info.minPriceUsd;
    for (const el of all('.originText')) el.textContent = location.origin;
    if ($('fPrice')) $('fPrice').min = info.minPriceUsd;
  }

  async function tally() {
    const s = await api('/v1/stats');
    if (s.status !== 200) return null;
    const set = (id, v) => { if ($(id)) $(id).textContent = v; };
    set('sStalls', s.body.houseStalls + s.body.sellerStalls);
    set('sCalls', s.body.paidCalls);
    set('sVolume', `$${money(s.body.volumeUsd)}`);
    set('sSellers', `$${money(s.body.paidToSellersUsd)}`);
    set('sBuyers', s.body.buyers);
    return s.body;
  }

  // ---------- stalls ----------
  let stalls = [];
  const tagHtml = (s, button = true) => `<div class="tagwrap"><span class="string"></span><div class="tag">
    <div class="price">$${esc(money(s.priceUsd))}<small>USDG / call</small></div>
    <h4>${esc(s.name)}</h4><div class="slug">/v1/call/${esc(s.slug)}</div>
    <p>${esc(s.summary)}</p>
    <div class="foot"><span class="badge ${s.house ? 'house' : 'seller'}">${s.house ? 'house' : `seller ${esc(short(s.seller))}`}</span>
    ${button ? `<a class="btn small ghost" href="/stalls/?try=${encodeURIComponent(s.slug)}#counter" data-pick="${esc(s.slug)}">${s.house ? 'Try free' : 'How to call'}</a>` : ''}</div></div></div>`;
  async function loadStalls() {
    const r = await api('/v1/stalls');
    if (r.status === 200) stalls = r.body.data;
    if ($('railEmpty')) $('railEmpty').hidden = r.status === 200;
    return r.status === 200;
  }

  // ---------- the counter ----------
  let tab = 'out', answer = 'Pick a stall and run it.';
  const picked = () => stalls.find((s) => s.slug === $('pick').value);
  const inputOf = () => Object.fromEntries(all('#fields input').filter((i) => i.value.trim()).map((i) => [i.dataset.name, i.value.trim()]));
  function drawFields() {
    const s = picked();
    if (!s) return;
    $('fields').innerHTML = (s.input || []).map((f) => `<label>${esc(f.name)}${f.required ? '' : ' (optional)'}</label><input data-name="${esc(f.name)}" value="${esc(f.example || '')}" placeholder="${esc(f.description || '')}" spellcheck="false">`).join('');
    $('pickHint').textContent = s.house ? 'Free here a few times a day. An agent pays the price on the tag.' : (s.docs || 'This seller left no notes on the input.');
    $('run').disabled = !s.house;
    $('run').textContent = s.house ? 'Run a free call' : 'Paid calls only';
    if (!s.house && tab === 'out') setTab('agent'); else drawPane();
  }
  function drawPane() {
    const s = picked(), input = JSON.stringify(s ? (s.house ? inputOf() : {}) : {});
    if (tab === 'out') $('pane').textContent = answer;
    else if (!s) $('pane').textContent = '';
    else if (tab === 'agent') $('pane').textContent = `# pays ${money(s.priceUsd)} USDG from the agent's wallet, prints the answer and the receipt\nhawker call ${s.slug} '${input}'\n\n# or, as an MCP tool\nhawker_call { "stall": "${s.slug}", "input": ${input} }`;
    else $('pane').textContent = `POST ${location.origin}/v1/call/${s.slug}\ncontent-type: application/json\n\n${input}\n\n→ 402 { "accepts": [{ "scheme": "hawker-till", "till": "${info.till || '0x…'}", "seller": "${s.seller || '0x…'}", "value": "${s.value}", "ref": "0x…" }] }\n\nSign USDG ReceiveWithAuthorization(from, to = till, value, validAfter = 0, validBefore, nonce = keccak256(abi.encode(seller, ref)))\nand send the same request again with\n\nx-payment: base64({ from, seller, value, validAfter, validBefore, ref, signature })\n\n→ 200 { "result": …, "receipt": { "tx": "0x…", "paidUsd": ${s.priceUsd} } }`;
  }
  function setTab(t) {
    tab = t;
    for (const b of all('.tabs button')) b.classList.toggle('on', b.dataset.tab === t);
    drawPane();
  }
  function counter() {
    $('pick').innerHTML = stalls.map((s) => `<option value="${esc(s.slug)}">${esc(s.name)} · $${esc(money(s.priceUsd))}</option>`).join('');
    const want = new URLSearchParams(location.search).get('try');
    if (want && stalls.some((s) => s.slug === want)) $('pick').value = want;
    drawFields();
    for (const b of all('.tabs button')) b.onclick = () => setTab(b.dataset.tab);
    $('pick').onchange = drawFields;
    $('fields').addEventListener('input', () => { if (tab !== 'out') drawPane(); });
    $('run').onclick = async () => {
      const s = picked();
      if (!s?.house) return;
      $('run').disabled = true;
      answer = 'Calling…';
      setTab('out');
      const r = await api(`/v1/demo/${s.slug}`, inputOf());
      answer = r.status === 200 ? JSON.stringify(r.body.result, null, 2) : r.status === 0 ? 'Could not reach the gateway.' : `${r.body.error?.code || r.status}: ${r.body.error?.message || 'the call failed'}`;
      $('run').disabled = false;
      drawPane();
    };
  }

  // ---------- the ledger ----------
  async function ledger(limit, compact) {
    const l = await api(`/v1/ledger?limit=${limit}`);
    if (l.status !== 200) return;
    $('rowsNone').hidden = l.body.data.length > 0;
    $('rows').innerHTML = l.body.data.map((r) => `<tr><td>${esc(ago(r.at))}</td><td>${esc(r.stall)}</td><td>$${esc(money(r.paidUsd))}</td>${compact ? '' : `<td>$${esc(money(r.paidUsd - r.feeUsd))}</td><td>$${esc(money(r.feeUsd))}</td>`}
      <td><a href="${EXPLORER}/address/${esc(r.seller)}" target="_blank" rel="noopener">${esc(short(r.seller))}</a>${r.house ? '<span class="own">house</span>' : ''}</td>
      <td><a href="${EXPLORER}/address/${esc(r.buyer)}" target="_blank" rel="noopener">${esc(short(r.buyer))}</a>${r.own ? '<span class="own">team</span>' : ''}</td>
      ${compact ? '' : `<td>${esc(r.ms)} ms</td>`}<td><a href="${esc(r.explorer)}" target="_blank" rel="noopener">${esc(short(r.tx))}</a></td></tr>`).join('');
  }

  // ---------- open a stall ----------
  function sellForm() {
    const stallMessage = ({ slug, url, priceUsd, payTo, open, at }) => `HAWKER stall\nslug: ${slug}\nurl: ${url}\nprice: ${priceUsd} USDG per call\npay to: ${payTo}\nopen: ${open ? 'yes' : 'no'}\nat: ${at}`;
    const utf8Hex = (s) => `0x${[...new TextEncoder().encode(s)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
    const say = (text, cls = '') => { $('sellMsg').className = `msg ${cls}`; $('sellMsg').textContent = text; };
    $('fName').addEventListener('input', () => { if (!$('fSlug').dataset.touched) $('fSlug').value = $('fName').value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32); });
    $('fSlug').addEventListener('input', () => { $('fSlug').dataset.touched = '1'; });
    $('sellForm').onsubmit = async (e) => {
      e.preventDefault();
      const wallet = window.ethereum;
      if (!wallet) return say('No wallet found. Open this page in a browser with MetaMask or Rabby, or use `hawker list` from the agent kit.', 'err');
      $('sellGo').disabled = true;
      document.querySelector('.secret')?.remove();
      try {
        const [payTo] = await wallet.request({ method: 'eth_requestAccounts' });
        const b = { slug: $('fSlug').value.trim(), url: $('fUrl').value.trim(), priceUsd: Number($('fPrice').value), payTo, open: !$('fClose').checked, at: Math.floor(Date.now() / 1000) };
        say('Sign the listing in your wallet…');
        const signature = await wallet.request({ method: 'personal_sign', params: [utf8Hex(stallMessage(b)), payTo] });
        const r = await api('/v1/stalls', { ...b, name: $('fName').value.trim(), summary: $('fSummary').value.trim(), docs: $('fDocs').value.trim(), rotate: $('fRotate').checked, signature });
        if (r.status === 0) return say('Could not reach the gateway.', 'err');
        if (r.status > 299) return say(`${r.body.error?.code || r.status}: ${r.body.error?.message || 'the listing was refused'}`, 'err');
        say(!b.open ? 'Closed. It is off the catalog.' : r.status === 201 ? `Open. Agents can call it at ${r.body.call}` : 'Updated.', 'ok');
        if (r.body.signingSecret) {
          const box = document.createElement('div');
          box.className = 'secret';
          box.textContent = `Signing secret (shown once, keep it): ${r.body.signingSecret}\n\nEach request carries X-Hawker-Timestamp and X-Hawker-Signature = "sha256=" + HMAC-SHA256(secret, timestamp + "." + raw body). The check is on this page, under "Check the signature".`;
          $('sellForm').append(box);
        }
      } catch (err) {
        say(err?.code === 4001 ? 'Cancelled in the wallet.' : `Error: ${err?.message || err}`, 'err');
      } finally { $('sellGo').disabled = false; }
    };
  }

  // ---------- code tabs (agents, sell, docs) ----------
  for (const group of all('[data-codetabs]')) {
    const buttons = [...group.querySelectorAll('.tabs button')], panes = [...group.querySelectorAll('pre[data-pane]')];
    const show = (k) => { buttons.forEach((b) => b.classList.toggle('on', b.dataset.k === k)); panes.forEach((p) => { p.hidden = p.dataset.pane !== k; }); };
    buttons.forEach((b) => { b.onclick = () => show(b.dataset.k); });
    show(buttons[0]?.dataset.k);
  }

  // ---------- run the page ----------
  (async () => {
    await loadInfo();
    if (page === 'home') {
      tally();
      if (await loadStalls()) $('rail').innerHTML = stalls.slice(0, 3).map((s) => tagHtml(s)).join('');
      ledger(5, true);
      setInterval(() => { tally(); ledger(5, true); }, 20000);
    }
    if (page === 'stalls') {
      if (await loadStalls()) {
        let filter = 'all';
        const draw = () => { $('rail').innerHTML = stalls.filter((s) => filter === 'all' || (filter === 'house') === s.house).map((s) => tagHtml(s)).join('') || '<div class="empty">No stalls here yet.</div>'; };
        for (const b of all('.filters button')) b.onclick = () => { filter = b.dataset.f; all('.filters button').forEach((x) => x.classList.toggle('on', x === b)); draw(); };
        draw();
        $('nHouse').textContent = stalls.filter((s) => s.house).length;
        $('nSeller').textContent = stalls.filter((s) => !s.house).length;
        $('rail').addEventListener('click', (e) => {
          const a = e.target.closest('[data-pick]');
          if (!a) return;
          e.preventDefault();
          $('pick').value = a.dataset.pick;
          drawFields();
          $('counter').scrollIntoView();
        });
        counter();
      }
    }
    if (page === 'ledger') {
      tally();
      ledger(100, false);
      setInterval(() => { tally(); ledger(100, false); }, 15000);
    }
    if (page === 'sell') sellForm();
  })();
  window.HAWKER_USDG = USDG;
})();
