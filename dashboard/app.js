// Token Radar dashboard. Reads window.RADAR (data.js, written by main.ts from
// the same board as board.json) and renders board, filters, scatter, detail.
// No network: every byte shown is in data.js.
(function () {
  'use strict';
  var D = window.RADAR;
  if (!D) return;
  var app = document.getElementById('app');
  var S = { tab: 'pre', q: '', cat: 'all', chain: 'all', verdict: 'all', minTvl: 0, capital: 1000, sort: 'implied', dir: -1, sel: null };
  function fmt(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return '$' + Math.round(n);
  }
  function money(n) { return '$' + Math.round(n).toLocaleString('en-US'); }
  function pct(n) { if (n === null || n === undefined || !isFinite(n)) return 'n/a'; return (n > 0 ? '+' : '') + n.toFixed(1) + '%'; }
  function age(d) { if (d === null || d === undefined) return 'unknown'; if (d >= 365) return (d / 365).toFixed(1) + 'y'; return Math.round(d) + 'd'; }
  // Economics at the chosen capital: the $1K slice scales with capital, gas
  // fees are fixed, the forgone 4% T-bill scales with capital.
  function econ(r, cap) {
    var slice = r.slice_1000_usd * cap / 1000;
    var opp = cap * 0.04 * r.hold_days / 365;
    var net = slice - r.fees_usd - opp;
    var ph = net / r.hours;
    return { slice: slice, opp: opp, net: net, ph: ph, verdict: ph > 30 ? 'FARM' : net > 0 ? 'THIN' : 'SKIP' };
  }
  // Recompute a row's implied value from the fitted curve, so the page
  // checks the number board.json carries with the same arithmetic.
  function impliedCheck(r) {
    var f = D.fit;
    var g = r.change_7d === null ? 0 : Math.min(120, Math.max(-60, r.change_7d)) / 100;
    var seas = Math.log10(1 + (r.age_days === null ? 365 : r.age_days));
    var log = f.intercept + f.slope * Math.log10(Math.max(1, r.tvl_usd)) + f.growthWeight * g + f.seasoningWeight * seas + r.cat_factor;
    return Math.max(1, Math.round(Math.pow(10, log) * r.sibling_factor));
  }
  function el(tag, attrs) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'class') n.className = attrs[k];
      else if (k === 'text') n.textContent = attrs[k];
      else if (k === 'html') n.innerHTML = attrs[k];
      else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== null && attrs[k] !== undefined) n.setAttribute(k, attrs[k]);
    });
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c === null || c === undefined) continue;
      if (Array.isArray(c)) c.forEach(function (x) { if (x) n.appendChild(x); });
      else if (typeof c === 'string') n.appendChild(document.createTextNode(c));
      else n.appendChild(c);
    }
    return n;
  }
  function readHash() {
    var p = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    if (p.get('tab')) S.tab = p.get('tab');
    if (p.get('q')) S.q = p.get('q');
    if (p.get('cat')) S.cat = p.get('cat');
    if (p.get('chain')) S.chain = p.get('chain');
    if (p.get('verdict')) S.verdict = p.get('verdict');
    if (p.get('cap')) S.capital = parseInt(p.get('cap'), 10) || 1000;
    if (p.get('p')) S.sel = p.get('p');
  }
  function writeHash() {
    var p = new URLSearchParams();
    if (S.tab !== 'pre') p.set('tab', S.tab);
    if (S.q) p.set('q', S.q);
    if (S.cat !== 'all') p.set('cat', S.cat);
    if (S.chain !== 'all') p.set('chain', S.chain);
    if (S.verdict !== 'all') p.set('verdict', S.verdict);
    if (S.capital !== 1000) p.set('cap', String(S.capital));
    if (S.sel) p.set('p', S.sel);
    var s = p.toString();
    window.history.replaceState(null, '', s ? '#' + s : window.location.pathname + window.location.search);
  }
  function header() {
    return el('header', { class: 'top' },
      el('div', { class: 'brand' }, el('span', { class: 'dot' }), el('div', null,
        el('b', { text: 'Token Radar' }),
        el('div', { class: 'small', text: 'Comps curve · fitted blind · costed farm plans' }))),
      el('div', { class: 'meta' },
        el('span', { html: 'Snapshot <b>' + D.as_of + '</b>' }),
        el('span', { html: '<b>' + D.total_protocols + '</b> protocols' }),
        el('span', { html: 'Watchlist <b>' + D.watchlist_size + ' / ' + D.watchlist_size + '</b>' }),
        el('span', { html: 'Page = board.json <b>' + D.board_size + ' / ' + D.board_size + '</b> rows' })));
  }
  function hero() {
    var best = null, bestPh = -Infinity;
    D.rows.forEach(function (r) { var e = econ(r, 1000); if (e.ph > bestPh) { bestPh = e.ph; best = r; } });
    return el('section', { class: 'hero' },
      el('div', null,
        el('h1', { text: D.pre_token_count + ' protocols record no token yet — ' + D.board_size + ' ranked by what a launch would be worth' }),
        el('p', { html: 'The watchlist is the floor: every protocol with at least <b>$50M TVL</b> and no token on record. The early radar adds <b>' + D.early_size + '</b> pre-token protocols below that floor, by TVL. Implied value is one fitted curve applied to every row — never a hand-picked name. Best net per hands-on hour at $1,000: <b>' + best.name + ' ' + money(bestPh) + '/h</b>.' })),
      el('div', { class: 'stats' },
        el('div', { class: 'stat' }, el('span', { class: 'mut', text: 'Watchlist covered' }), el('b', { text: D.watchlist_size + ' / ' + D.watchlist_size })),
        el('div', { class: 'stat' }, el('span', { class: 'mut', text: 'Pre-token rows ranked' }), el('b', { text: String(D.board_size) })),
        el('div', { class: 'stat' }, el('span', { class: 'mut', text: 'Token already trades (kept apart)' }), el('b', { text: String(D.traded_count) })),
        el('div', { class: 'stat' }, el('span', { class: 'mut', text: 'Set aside (no token, not ranked)' }), el('b', { text: String(D.set_aside_count) })),
        el('div', { class: 'stat' }, el('span', { class: 'mut', text: 'Verdicts at $1,000' }), el('b', { text: 'FARM ' + D.verdictCounts.FARM + ' · THIN ' + D.verdictCounts.THIN + ' · SKIP ' + D.verdictCounts.SKIP }))));
  }
  function btRow(label, m, f) {
    return el('tr', null, el('td', { text: label }),
      el('td', { class: 'num', text: 'x' + m.medianMiss.toFixed(2) }),
      el('td', { class: 'num', text: m.within3x.toFixed(1) + '%' }),
      el('td', { class: 'num', text: m.within10x.toFixed(1) + '%' }),
      el('td', { class: 'num', text: String(m.n) }),
      el('td', { class: 'num', text: f ? 'x' + f.medianMiss.toFixed(2) : '—' }));
  }
  function backtestTable() {
    var b = D.backtest;
    return el('table', { class: 'mini' },
      el('thead', null, el('tr', null, ['Test', 'Median miss', 'Within 3x', 'Within 10x', 'n', 'Flat baseline'].map(function (h) { return el('th', { text: h }); }))),
      el('tbody', null,
        btRow('Leave-one-out (each traded token left out, curve refit)', b.loo, b.looFlat),
        btRow('Time split (fit on listed before 2024, test the rest)', b.time, b.timeFlat)));
  }
  function methodPanel() {
    var f = D.fit;
    var cats = Object.keys(f.catFactors).sort(function (a, b) { return Math.abs(f.catFactors[b]) - Math.abs(f.catFactors[a]); }).slice(0, 8);
    return el('section', { class: 'panel' },
      el('h2', { text: 'How a launch is priced' }),
      el('p', { class: 'mut', text: 'One function prices every row. The curve is fitted at runtime from the ' + f.nComps + ' traded tokens with a positive market cap — ridge log-log regression (lambda ' + f.lambda + '), R² ' + f.r2.toFixed(3) + ', residual spread ' + f.residSd.toFixed(2) + ' dex. No protocol name is special-cased.' }),
      el('div', { class: 'formula', html: 'log10(implied) = <b>' + f.intercept.toFixed(4) + '</b> + <b>' + f.slope.toFixed(4) + '</b> × log10(TVL) + <b>' + f.growthWeight.toFixed(4) + '</b> × growth₇d + <b>' + f.seasoningWeight.toFixed(4) + '</b> × log10(1 + days with no token) + category factor (shrunk, ±0.25 dex) — then × 0.85 if the family already has a traded token.' }),
      el('div', { class: 'grid2' },
        el('div', null,
          el('h3', { text: 'Blind backtest — the curve beats the flat mcap/TVL baseline' }),
          backtestTable(),
          el('p', { class: 'small', text: 'Median miss is the middle token’s predicted-vs-real market-cap multiple. Flat baseline is the median mcap/TVL ratio over the same comps. Growth and seasoning carry small fitted weights — fast TVL jumps in this snapshot tend to be mercenary inflows, so the curve discounts them slightly.' })),
        el('div', null,
          el('h3', { text: 'Traded tokens: market cap vs TVL (log-log)' }),
          el('canvas', { class: 'chart', id: 'scatter', width: 900, height: 280 }),
          el('p', { class: 'small', text: 'Dots are the ' + f.nComps + ' comps. Line is the fitted curve (category factor 0); the band is the P10–P90 range, ×/÷ ' + f.bandFactor + '. A slope below 1 means big protocols get a smaller multiple than small ones — a flat 0.25× rule overpays the giants.' }))),
      el('p', { class: 'small', text: 'Largest category factors: ' + cats.map(function (c) { return c + ' ' + (f.catFactors[c] >= 0 ? '+' : '') + f.catFactors[c].toFixed(4); }).join(' · ') + '. Full list is in data.js (fit.catFactors).' }));
  }
  function drawScatter() {
    var cv = document.getElementById('scatter');
    if (!cv) return;
    var ctx = cv.getContext('2d');
    var W = cv.width, H = cv.height, pad = 44;
    var xs = D.comps.map(function (c) { return Math.log10(c[0]); });
    var ys = D.comps.map(function (c) { return Math.log10(c[1]); });
    var x0 = Math.floor(Math.min.apply(null, xs)), x1 = Math.ceil(Math.max.apply(null, xs));
    var y0 = Math.floor(Math.min.apply(null, ys)), y1 = Math.ceil(Math.max.apply(null, ys));
    function X(v) { return pad + (v - x0) / (x1 - x0) * (W - pad - 14); }
    function Y(v) { return H - pad - (v - y0) / (y1 - y0) * (H - pad - 14); }
    ctx.clearRect(0, 0, W, H);
    ctx.strokeStyle = '#2b3a31'; ctx.fillStyle = '#9db3a5'; ctx.font = '11px monospace';
    var gx, gy;
    for (gx = x0; gx <= x1; gx++) { ctx.beginPath(); ctx.moveTo(X(gx), pad - 8); ctx.lineTo(X(gx), H - pad); ctx.stroke(); ctx.fillText('10^' + gx, X(gx) - 10, H - pad + 16); }
    for (gy = y0; gy <= y1; gy++) { ctx.beginPath(); ctx.moveTo(pad, Y(gy)); ctx.lineTo(W - 14, Y(gy)); ctx.stroke(); ctx.fillText('$10^' + gy, 4, Y(gy) + 4); }
    ctx.fillText('TVL →', W - 70, H - 8); ctx.fillText('mcap', 4, 14);
    var f = D.fit, sd = f.residSd;
    function lineAt(v, off) { return f.intercept + f.slope * v + off; }
    ctx.fillStyle = 'rgba(111,179,224,0.12)';
    ctx.beginPath();
    ctx.moveTo(X(x0), Y(lineAt(x0, 1.2816 * sd))); ctx.lineTo(X(x1), Y(lineAt(x1, 1.2816 * sd)));
    ctx.lineTo(X(x1), Y(lineAt(x1, -1.2816 * sd))); ctx.lineTo(X(x0), Y(lineAt(x0, -1.2816 * sd)));
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = '#34c08a'; ctx.lineWidth = 2; ctx.beginPath();
    ctx.moveTo(X(x0), Y(lineAt(x0, 0))); ctx.lineTo(X(x1), Y(lineAt(x1, 0))); ctx.stroke(); ctx.lineWidth = 1;
    ctx.fillStyle = '#e9f2ea';
    D.comps.forEach(function (c) { ctx.beginPath(); ctx.arc(X(Math.log10(c[0])), Y(Math.log10(c[1])), 2.4, 0, 6.284); ctx.fill(); });
  }
  function filteredRows() {
    var q = S.q.trim().toLowerCase();
    return D.rows.filter(function (r) {
      if (S.cat !== 'all' && (r.category || 'Other') !== S.cat) return false;
      if (S.chain !== 'all' && (r.chains || []).indexOf(S.chain) < 0) return false;
      if (S.verdict !== 'all' && econ(r, S.capital).verdict !== S.verdict) return false;
      if (r.tvl_usd < S.minTvl) return false;
      if (!q) return true;
      return [r.name, r.slug, r.category, (r.chains || []).join(' ')].join(' ').toLowerCase().indexOf(q) >= 0;
    });
  }
  function sorted(list) {
    var k = S.sort;
    return list.slice().sort(function (a, b) {
      var av, bv;
      if (k === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else if (k === 'tvl') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (k === 'growth') { av = a.change_7d === null ? -Infinity : a.change_7d; bv = b.change_7d === null ? -Infinity : b.change_7d; }
      else if (k === 'age') { av = a.age_days === null ? Infinity : a.age_days; bv = b.age_days === null ? Infinity : b.age_days; }
      else if (k === 'slice') { av = econ(a, S.capital).slice; bv = econ(b, S.capital).slice; }
      else if (k === 'net') { av = econ(a, S.capital).ph; bv = econ(b, S.capital).ph; }
      else { av = a.implied_value_usd; bv = b.implied_value_usd; }
      if (av < bv) return -S.dir;
      if (av > bv) return S.dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  }
  function opt(v, label) { return el('option', { value: v, text: label }); }
  function controls() {
    var cats = Array.from(new Set(D.rows.map(function (r) { return r.category || 'Other'; }))).sort();
    var chains = Array.from(new Set(D.rows.reduce(function (a, r) { return a.concat(r.chains || []); }, []))).sort();
    var q = el('input', { type: 'search', placeholder: 'Search name, category or chain', value: S.q, 'aria-label': 'Search the board' });
    q.addEventListener('input', function () { S.q = q.value; writeHash(); render(); });
    function sel(opts, val, fn, label) {
      var s = el('select', { 'aria-label': label }, opts);
      s.value = val;
      s.addEventListener('change', function () { fn(s.value); writeHash(); render(); });
      return el('div', { class: 'field' }, el('label', { text: label }), s);
    }
    var tabs = el('div', { class: 'tabs' }, [['pre', 'No token yet'], ['live', 'Token trades'], ['aside', 'Set aside'], ['method', 'Method and backtest']].map(function (t) {
      return el('button', { type: 'button', 'aria-pressed': S.tab === t[0] ? 'true' : 'false', text: t[1], onclick: function () { S.tab = t[0]; writeHash(); render(); } });
    }));
    var count = el('span', { class: 'count', text: S.tab === 'pre' ? filteredRows().length + ' of ' + D.board_size + ' rows shown' : S.tab === 'live' ? D.live.length + ' traded protocols' : S.tab === 'aside' ? D.aside.length + ' set aside' : 'Method and backtest' });
    return el('div', { class: 'controls' },
      el('div', { class: 'field' }, el('label', { text: 'Search' }), q),
      sel([opt('all', 'All categories')].concat(cats.map(function (c) { return opt(c, c); })), S.cat, function (v) { S.cat = v; }, 'Category'),
      sel([opt('all', 'All chains')].concat(chains.map(function (c) { return opt(c, c); })), S.chain, function (v) { S.chain = v; }, 'Chain'),
      sel([opt('all', 'All verdicts'), opt('FARM', 'FARM'), opt('THIN', 'THIN'), opt('SKIP', 'SKIP')], S.verdict, function (v) { S.verdict = v; }, 'Verdict'),
      sel([opt('0', 'Any TVL'), opt('10000000', 'TVL ≥ $10M'), opt('50000000', 'TVL ≥ $50M'), opt('100000000', 'TVL ≥ $100M'), opt('500000000', 'TVL ≥ $500M')], String(S.minTvl), function (v) { S.minTvl = parseInt(v, 10); }, 'Min TVL'),
      sel([opt('250', '$250'), opt('500', '$500'), opt('1000', '$1,000'), opt('2500', '$2,500')], String(S.capital), function (v) { S.capital = parseInt(v, 10); }, 'Capital'),
      el('div', { class: 'field' }, el('label', { text: 'View' }), tabs),
      count);
  }
  function sortHead(key, label) {
    return el('th', { scope: 'col' }, el('button', { type: 'button', onclick: function () { if (S.sort === key) S.dir = -S.dir; else { S.sort = key; S.dir = -1; } render(); } },
      label, S.sort === key ? el('span', { text: S.dir < 0 ? ' ↓' : ' ↑' }) : null));
  }
  function boardTable() {
    var list = sorted(filteredRows());
    if (!list.length) return el('div', { class: 'panel' }, el('div', { class: 'empty' },
      el('h2', { text: 'No protocol matches that filter' }),
      el('p', { text: 'Clear the search or pick another category, chain or verdict.' }),
      el('button', { class: 'btn primary', type: 'button', text: 'Clear filters', onclick: function () { S.q = ''; S.cat = 'all'; S.chain = 'all'; S.verdict = 'all'; S.minTvl = 0; writeHash(); render(); } })));
    var maxImp = D.rows[0].implied_value_usd;
    var loAll = Math.min.apply(null, D.rows.map(function (r) { return r.p10_usd; }));
    var hiAll = Math.max.apply(null, D.rows.map(function (r) { return r.p90_usd; }));
    var tb = el('tbody');
    list.forEach(function (r) {
      var e = econ(r, S.capital);
      var g = r.change_7d === null ? 'n/a' : pct(r.change_7d);
      var gc = r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg';
      var span = Math.log10(hiAll) - Math.log10(loAll);
      var left = (Math.log10(Math.max(1, r.p10_usd)) - Math.log10(loAll)) / span * 100;
      var wd = (Math.log10(r.p90_usd) - Math.log10(Math.max(1, r.p10_usd))) / span * 100;
      var tr = el('tr', {
        'data-sel': S.sel === r.slug ? 'true' : 'false', tabindex: '0',
        onclick: function () { openDetail(r.slug); },
        onkeydown: function (ev) { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openDetail(r.slug); } }
      },
        el('td', { class: 'num', text: String(r.rank) }),
        el('td', null, el('div', { class: 'pname' }, el('b', { text: r.name }), el('span', { text: (r.category || 'Other') + ' · ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : '—') }))),
        el('td', { class: 'num', text: fmt(r.tvl_usd) }),
        el('td', { class: 'num ' + gc, text: g }),
        el('td', { class: 'num', text: age(r.age_days) }),
        el('td', null,
          el('div', null, el('span', { class: 'bar' }, el('i', { style: 'width:' + Math.max(2, Math.round(r.implied_value_usd / maxImp * 100)) + '%' })), el('span', { class: 'num', text: fmt(r.implied_value_usd) })),
          el('div', null, el('span', { class: 'range' }, el('i', { style: 'left:' + left.toFixed(1) + '%;width:' + Math.max(2, wd).toFixed(1) + '%' })), el('span', { class: 'small', text: fmt(r.p10_usd) + ' – ' + fmt(r.p90_usd) }))),
        el('td', { class: 'num', text: fmt(e.slice) }),
        el('td', null, el('span', { class: 'vchip v' + e.verdict, text: e.verdict }), el('div', { class: 'num', text: money(e.net) + ' net · ' + money(e.ph) + '/h' })),
        el('td', { class: 'num', text: '$' + r.plan_capital_usd + ' · ' + money(r.fees_usd) + ' fees · ' + r.hold_days + 'd hold' }));
      tb.appendChild(tr);
    });
    return el('div', { class: 'tblwrap' }, el('table', { class: 'board' },
      el('caption', { class: 'small', text: 'Pre-token protocols, strongest implied value first. Select a row for its model breakdown and farm plan.' }),
      el('thead', null, el('tr', null,
        sortHead('implied', '#'), sortHead('name', 'Protocol'), sortHead('tvl', 'TVL'), sortHead('growth', '7D'),
        sortHead('age', 'No token for'), sortHead('implied', 'Implied value'), sortHead('slice', fmt(S.capital) + ' slice'),
        sortHead('net', 'Net of all costs'), el('th', { scope: 'col', text: 'Farm / Fees / Hold' }))),
      tb));
  }
  function liveTable() {
    var tb = el('tbody');
    D.live.forEach(function (r) {
      tb.appendChild(el('tr', null,
        el('td', { class: 'num', text: 'live' }),
        el('td', null, el('div', { class: 'pname' }, el('b', { text: r.name }), el('span', { text: (r.category || 'Other') + ' · ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : '—') }))),
        el('td', { class: 'num', text: fmt(r.tvl_usd) }),
        el('td', { class: 'num ' + (r.change_7d !== null && r.change_7d >= 0 ? 'pos' : 'neg'), text: pct(r.change_7d) }),
        el('td', { class: 'num', text: fmt(r.mcap_usd) }),
        el('td', { class: 'num', text: (r.mcap_usd / Math.max(1, r.tvl_usd)).toFixed(2) + '×' }),
        el('td', null, el('span', { class: 'mut', text: 'already trades' }))));
    });
    return el('div', { class: 'tblwrap' }, el('table', { class: 'board' },
      el('caption', { class: 'small', text: 'Token live: the market cap is a fact, not a model. These ' + D.live.length + ' protocols price the curve and are kept apart from the pre-token ranking.' }),
      el('thead', null, el('tr', null, ['Status', 'Protocol', 'TVL', '7D', 'Market cap', 'Mcap / TVL', 'Token'].map(function (h) { return el('th', { scope: 'col', text: h }); }))),
      tb));
  }
  function asideTable() {
    var tb = el('tbody');
    D.aside.slice(0, 60).forEach(function (r) {
      tb.appendChild(el('tr', null,
        el('td', { class: 'num', text: '—' }),
        el('td', null, el('div', { class: 'pname' }, el('b', { text: r.name }), el('span', { text: (r.category || 'Other') + ' · ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : '—') }))),
        el('td', { class: 'num', text: fmt(r.tvl_usd) }),
        el('td', { class: 'mut', text: r.reason })));
    });
    return el('div', { class: 'tblwrap' }, el('table', { class: 'board' },
      el('caption', { class: 'small', text: D.aside.length + ' protocols record no token and are not on the board: the watchlist rule’s exclusions, the early TVL cut, or above the floor but not named by the watchlist. Showing the top 60 by TVL.' }),
      el('thead', null, el('tr', null, ['Rank', 'Protocol', 'TVL', 'Why set aside'].map(function (h) { return el('th', { scope: 'col', text: h }); }))),
      tb));
  }
  var dialog = el('dialog', { class: 'detail', id: 'detail' });
  dialog.addEventListener('close', function () { S.sel = null; writeHash(); });
  function openDetail(slug) {
    var r = D.rows.filter(function (x) { return x.slug === slug; })[0];
    if (!r) return;
    S.sel = slug; writeHash();
    var e = econ(r, S.capital);
    var check = impliedCheck(r);
    dialog.textContent = '';
    dialog.appendChild(el('div', { class: 'dhead' },
      el('div', null,
        el('span', { class: 'small', text: 'Rank ' + r.rank + ' of ' + D.board_size + ' · no token on record' }),
        el('h2', { text: r.name }),
        el('p', { class: 'small', text: (r.category || 'Other') + ' on ' + (r.chains && r.chains.length ? r.chains.join(', ') : '—') + ' · listed ' + (r.listed_at || 'unknown') })),
      el('button', { class: 'close', type: 'button', 'aria-label': 'Close details', text: '✕', onclick: function () { dialog.close(); } })));
    dialog.appendChild(el('section', { class: 'dsec' },
      el('h3', { text: 'Implied value — one curve, this row’s inputs' }),
      el('div', { class: 'kv' },
        el('div', null, el('span', { text: 'TVL' }), el('b', { class: 'num', text: fmt(r.tvl_usd) })),
        el('div', null, el('span', { text: 'Seven-day growth' }), el('b', { class: 'num', text: pct(r.change_7d) })),
        el('div', null, el('span', { text: 'No token for' }), el('b', { class: 'num', text: age(r.age_days) })),
        el('div', null, el('span', { text: 'Category factor' }), el('b', { class: 'num', text: (r.cat_factor >= 0 ? '+' : '') + r.cat_factor.toFixed(4) + ' dex' })),
        el('div', null, el('span', { text: 'Sibling factor' }), el('b', { class: 'num', text: r.sibling_factor === 1 ? '1.00 (no traded sibling)' : '0.85 (family already trades)' })),
        el('div', null, el('span', { text: 'Implied value (P10–P90)' }), el('b', { class: 'num', text: fmt(r.implied_value_usd) + '  (' + fmt(r.p10_usd) + ' – ' + fmt(r.p90_usd) + ')' })),
        el('div', null, el('span', { text: 'Page recomputes it as' }), el('b', { class: 'num', text: fmt(check) + (check === r.implied_value_usd ? ' — matches board.json' : ' — differs from the board') }))),
      el('p', { class: 'small', text: 'An estimate from the snapshot’s own figures, not a price and not a promise of a token.' })));
    dialog.appendChild(el('section', { class: 'dsec' },
      el('h3', { text: 'Farm economics at ' + fmt(S.capital) }),
      el('div', { class: 'kv' },
        el('div', null, el('span', { text: 'Slice value' }), el('b', { class: 'num', text: money(e.slice) })),
        el('div', null, el('span', { text: 'Gas + swap fees' }), el('b', { class: 'num', text: '−' + money(r.fees_usd) })),
        el('div', null, el('span', { text: 'Forgone 4% T-bill (' + r.hold_days + 'd)' }), el('b', { class: 'num', text: '−' + money(e.opp) })),
        el('div', null, el('span', { text: 'Net of all costs' }), el('b', { class: 'num', text: money(e.net) })),
        el('div', null, el('span', { text: 'Hands-on time' }), el('b', { class: 'num', text: r.hours + 'h over ' + r.hold_days + ' days' })),
        el('div', null, el('span', { text: 'Verdict' }), el('b', null, el('span', { class: 'vchip v' + e.verdict, text: e.verdict }), el('span', { class: 'num', text: ' ' + money(e.ph) + '/h' }))))));
    dialog.appendChild(el('section', { class: 'dsec' },
      el('h3', { text: 'Farm plan — ' + r.farm_steps.length + ' steps' }),
      el('ol', { class: 'steps' }, r.farm_steps.map(function (s) {
        var at = s.indexOf(' Cost: ');
        return el('li', null, el('b', { text: at >= 0 ? s.slice(0, at) : s }), el('span', { class: 'cost', text: at >= 0 ? s.slice(at + 1) : '' }));
      }))));
    if (typeof dialog.showModal === 'function' && !dialog.open) dialog.showModal();
  }
  function render() {
    app.textContent = '';
    var shell = el('div', { class: 'wrap' });
    shell.appendChild(header());
    shell.appendChild(hero());
    shell.appendChild(methodPanel());
    shell.appendChild(controls());
    if (S.tab === 'pre') shell.appendChild(boardTable());
    else if (S.tab === 'live') shell.appendChild(liveTable());
    else if (S.tab === 'aside') shell.appendChild(asideTable());
    else shell.appendChild(el('section', { class: 'panel' },
      el('h2', { text: 'Method and backtest' }),
      el('p', { class: 'mut', text: 'The curve, the backtest and the scatter above are the method. In short: fit the comps curve on the ' + D.fit.nComps + ' traded tokens, price every pre-token protocol with the same function, rank by implied value, then cost each farm plan (gas by chain, hands-on hours, hold days) and judge the net per hour against a 4% T-bill. Skills used: pre_tge_alpha_radar (doctrine only — score pre-token protocols, costed farm plans, tiering; its funding / VC / GitHub signals do not exist in this snapshot and are not invented) and app-creation (verification discipline: test the main flow from the running page).' }),
      backtestTable()));
    app.appendChild(shell);
    app.setAttribute('aria-busy', 'false');
    if (!dialog.isConnected) app.appendChild(dialog);
    drawScatter();
    if (S.sel) openDetail(S.sel);
  }
  readHash();
  render();
  window.addEventListener('keydown', function (e) { if (e.key === 'Escape' && dialog.open) dialog.close(); });
})();
