/* ARKB Arbitrage Dashboard — client logic */
const $ = (id) => document.getElementById(id);
const fmtN = (n, d = 2) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  return v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
};

let CFG = {
  etf: { creationUnitShares: 5000, btcPerShare: 0.000303, sharesOutstanding: 75000000 },
  costs: {
    creationRedemptionFeeUsd: 200,
    etfCommissionPerShare: 0.005,
    btcExecutionBps: 2,
    marketImpactBps: 1,
    btcSpotSpreadBps: 2,
  },
  signals: { minSpreadAfterCostsBps: 10, cooldownMs: 15000 },
  coinbase: { restUrl: 'https://api.exchange.coinbase.com/products/BTC-USD/ticker' },
  marketOverviewUrl: 'https://btctrader-api-68276-gqbkg8bucfbndjgn.z01.azurefd.net/api/market-overview',
};

const state = {
  startTime: Date.now(),
  btcPrice: 0,
  arkbMid: 0,
  arkbBid: 0,
  arkbAsk: 0,
  nav: 0,
  premBps: 0,
  signal: 'NEUTRAL',
  tradeCount: 0,
  winRate: 0,
  totalPnl: 0,
  trades: [],
  basisBps: 0,
  lastSignalAt: 0,
  lastSignal: 'NEUTRAL',
  btcPerShare: 0.000303,
  btcPerShareSource: 'config',
  mode: 'standalone',
  backendLive: false,
};

let liveArkb = null;
let standaloneTimer = null;

function totalCostBps(midPrice) {
  const c = CFG.costs;
  const cu = CFG.etf.creationUnitShares;
  const price = Number(midPrice);
  if (!(price > 0) || !(cu > 0)) return Infinity;
  const feeBps = (c.creationRedemptionFeeUsd / (cu * price)) * 10000;
  const commBps = (c.etfCommissionPerShare / price) * 10000;
  return feeBps + commBps + c.btcExecutionBps + (c.marketImpactBps * 2) + c.btcSpotSpreadBps;
}

function evaluate(arkbMid, btcPrice, btcPerShare) {
  const mid = Number(arkbMid);
  const btc = Number(btcPrice);
  const bps = Number(btcPerShare);
  if (!(mid > 0) || !(btc > 0) || !(bps > 0)) {
    return {
      ok: false, nav: 0, premBps: 0, costBps: Infinity, triggerBps: Infinity,
      signal: 'NEUTRAL', spreadCapturedBps: 0, pnlUsd: 0,
    };
  }
  const nav = btc * bps;
  const premBps = ((mid - nav) / nav) * 10000;
  const costBps = totalCostBps(mid);
  const triggerBps = costBps + (CFG.signals.minSpreadAfterCostsBps || 0);
  let signal = 'NEUTRAL';
  if (premBps > triggerBps) signal = 'CREATE';
  else if (premBps < -triggerBps) signal = 'REDEEM';
  const spreadCapturedBps = signal === 'NEUTRAL' ? 0 : Math.abs(premBps) - costBps;
  const pnlUsd = (spreadCapturedBps / 10000) * CFG.etf.creationUnitShares * mid;
  return { ok: true, nav, premBps, costBps, triggerBps, signal, spreadCapturedBps, pnlUsd };
}

async function loadConfig() {
  const urls = ['/api/config', 'config.json', './config.json'];
  for (const url of urls) {
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) continue;
      const json = await res.json();
      CFG = {
        ...CFG,
        ...json,
        etf: { ...CFG.etf, ...(json.etf || {}) },
        costs: { ...CFG.costs, ...(json.costs || {}) },
        signals: { ...CFG.signals, ...(json.signals || {}) },
        coinbase: { ...CFG.coinbase, ...(json.coinbase || {}) },
      };
      state.btcPerShare = Number(CFG.etf.btcPerShare) || state.btcPerShare;
      state.btcPerShareSource = 'config';
      return true;
    } catch {
      // try next source
    }
  }
  return false;
}

async function fetchBtcPrice() {
  const url = CFG.coinbase?.restUrl || 'https://api.exchange.coinbase.com/products/BTC-USD/ticker';
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`BTC fetch failed: ${res.status}`);
  const data = await res.json();
  const price = Number(data.price);
  if (!Number.isFinite(price) || price <= 0) throw new Error('Invalid BTC price payload');
  return price;
}

function nextStandaloneSnapshot(btcPrice) {
  const bps = state.btcPerShare;
  const nav = btcPrice * bps;
  let bid;
  let ask;
  let mid;

  if (liveArkb && (liveArkb.last != null || (liveArkb.bid != null && liveArkb.ask != null))) {
    bid = Number(liveArkb.bid);
    ask = Number(liveArkb.ask);
    mid = Number(liveArkb.last);
    if (!(mid > 0) && bid > 0 && ask > 0) mid = (bid + ask) / 2;
    if (!(bid > 0) && mid > 0) bid = mid * 0.99985;
    if (!(ask > 0) && mid > 0) ask = mid * 1.00015;
  } else {
    state.basisBps += (Math.random() - 0.5) * 1.4;
    state.basisBps *= 0.985;
    state.basisBps = Math.max(-60, Math.min(60, state.basisBps));
    mid = nav * (1 + state.basisBps / 10000);
    const halfSpread = mid * 0.00015;
    bid = mid - halfSpread;
    ask = mid + halfSpread;
  }

  const ev = evaluate(mid, btcPrice, bps);
  return {
    timestamp: new Date().toISOString(),
    btcPrice,
    arkbBid: bid,
    arkbAsk: ask,
    arkbMid: mid,
    nav: ev.nav,
    premBps: ev.premBps,
    trigger: ev.triggerBps,
    costBps: ev.costBps,
    signal: ev.signal,
    btcPerShare: bps,
    btcPerShareSource: state.btcPerShareSource,
  };
}

function registerTradeFromEval(snapshot, ev) {
  const now = Date.now();
  const cooldown = Number(CFG.signals.cooldownMs) || 15000;
  if (!ev || ev.signal === 'NEUTRAL') {
    state.lastSignal = 'NEUTRAL';
    return;
  }
  if (ev.signal === state.lastSignal && now - state.lastSignalAt < cooldown) return;
  if (!(ev.spreadCapturedBps > 0)) return;

  const trade = {
    timestamp: snapshot.timestamp,
    signal: ev.signal,
    spreadBps: ev.spreadCapturedBps,
    pnl: ev.pnlUsd,
  };
  state.trades.unshift(trade);
  state.trades = state.trades.slice(0, 25);
  state.tradeCount += 1;
  state.totalPnl += trade.pnl;
  const wins = state.trades.filter((t) => t.pnl > 0).length;
  state.winRate = state.trades.length > 0 ? (wins / state.trades.length) * 100 : 0;
  state.lastSignalAt = now;
  state.lastSignal = ev.signal;
  addTradeRow(trade);
}

function renderSnapshot(s) {
  const bps = Number(s.btcPerShare) || state.btcPerShare;
  const source = s.btcPerShareSource || state.btcPerShareSource;
  const ev = evaluate(s.arkbMid, s.btcPrice, bps);
  const trigger = Number.isFinite(s.trigger) ? s.trigger : ev.triggerBps;
  const cost = Number.isFinite(s.costBps) ? s.costBps : ev.costBps;

  $('arkb-mid').textContent = `$${fmtN(s.arkbMid, 4)}`;
  $('arkb-bid').textContent = `$${fmtN(s.arkbBid, 4)}`;
  $('arkb-ask').textContent = `$${fmtN(s.arkbAsk, 4)}`;
  $('btc-price').textContent = `$${fmtN(s.btcPrice, 2)}`;
  $('nav').textContent = `$${fmtN(ev.nav || s.nav, 4)}`;
  $('btc-per-share').textContent = Number(bps).toFixed(8);
  $('btc-per-share-source').textContent = source ? `(${source})` : '';

  const prem = Number.isFinite(s.premBps) ? s.premBps : ev.premBps;
  const sign = prem >= 0 ? '+' : '';
  const premEl = $('prem-bps');
  premEl.textContent = `${sign}${fmtN(prem, 1)} bps`;
  premEl.className = `big-number ${prem >= 0 ? 'prem-positive' : 'prem-negative'}`;
  $('trigger-label').textContent = Number.isFinite(trigger) ? `±${fmtN(trigger, 1)} bps` : '—';

  const signal = s.signal || ev.signal;
  const sigEl = $('signal');
  sigEl.className = `signal signal-${String(signal).toLowerCase()}`;
  if (signal === 'CREATE') sigEl.textContent = '🟢 CREATE SIGNAL';
  else if (signal === 'REDEEM') sigEl.textContent = '🔴 REDEEM SIGNAL';
  else sigEl.textContent = '⚪ NEUTRAL — Watching...';

  const spreadAfterCosts = Number.isFinite(prem) && Number.isFinite(cost) ? Math.abs(prem) - cost : NaN;
  $('signal-spread').textContent = `Spread after costs: ${fmtN(spreadAfterCosts, 1)} bps`;
  $('cost-total').textContent = `${fmtN(cost, 2)} bps`;

  const cu = CFG.etf.creationUnitShares;
  const cuBtc = cu * bps;
  const cuNotional = (Number(s.arkbMid) > 0 ? s.arkbMid : (ev.nav || 0)) * cu;
  $('cu-value').textContent = `$${fmtN(cuNotional, 2)}`;
  $('cu-detail').textContent = `${cu.toLocaleString()} shares  |  ${fmtN(cuBtc, 6)} BTC`;

  const totalPnl = state.backendLive && s.totalPnl != null ? s.totalPnl : state.totalPnl;
  const tradeCount = state.backendLive && s.tradeCount != null ? s.tradeCount : state.tradeCount;
  const winRate = state.backendLive && s.winRate != null ? s.winRate : state.winRate;
  const pnlEl = $('total-pnl');
  pnlEl.textContent = `$${fmtN(totalPnl, 2)}`;
  pnlEl.className = `big-number ${totalPnl >= 0 ? 'prem-positive' : 'prem-negative'}`;
  $('pnl-stats').textContent = `Trades: ${tradeCount}  |  Win: ${fmtN(winRate, 1)}%`;

  const elapsedMin = state.backendLive && s.elapsed != null
    ? s.elapsed
    : ((Date.now() - state.startTime) / 60000).toFixed(1);
  $('session-time').textContent = elapsedMin;

  const t = new Date(s.timestamp || Date.now());
  chart.data.datasets[0].data.push({ x: t, y: prem });
  if (chart.data.datasets[0].data.length > 600) chart.data.datasets[0].data.shift();
  if (Number.isFinite(trigger)) {
    const x0 = chart.data.datasets[0].data[0]?.x || t;
    chart.data.datasets[1].data = [{ x: x0, y: trigger }, { x: t, y: trigger }];
    chart.data.datasets[2].data = [{ x: x0, y: -trigger }, { x: t, y: -trigger }];
  }
  chart.update('none');

  $('clock').textContent = `Updated ${new Date().toLocaleTimeString()}`;
  $('session-elapsed').textContent = `Session: ${elapsedMin} min`;
}

function addTradeRow(t) {
  $('no-trades').style.display = 'none';
  const tbody = $('trades-body');
  const tr = document.createElement('tr');
  const cls = t.signal === 'CREATE' ? 'create' : 'redeem';
  const icon = t.signal === 'CREATE' ? '🟢' : '🔴';
  const time = String(t.timestamp).includes('T')
    ? t.timestamp.slice(11, 19)
    : new Date(t.timestamp).toLocaleTimeString();
  tr.innerHTML = `
    <td>${time}</td>
    <td class="${cls}">${icon} ${t.signal}</td>
    <td>${fmtN(t.spreadBps, 1)} bps</td>
    <td>$${fmtN(t.pnl, 2)}</td>
  `;
  tbody.insertBefore(tr, tbody.firstChild);
  while (tbody.children.length > 25) tbody.removeChild(tbody.lastChild);
}

function setCostModel() {
  $('cost-fee').textContent = `$${CFG.costs.creationRedemptionFeeUsd} flat`;
  $('cost-comm').textContent = `$${CFG.costs.etfCommissionPerShare}/share`;
  $('cost-btc').textContent = `${CFG.costs.btcExecutionBps} bps`;
  $('cost-impact').textContent = `${CFG.costs.marketImpactBps * 2} bps`;
  $('cost-spread').textContent = `${CFG.costs.btcSpotSpreadBps} bps`;
}

async function loadMarketOverview() {
  const url = CFG.marketOverviewUrl;
  if (!url) {
    $('market-overview').innerHTML = '<div style="color:var(--caption);text-align:center">No market overview URL configured</div>';
    return;
  }
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`Market overview fetch failed: ${res.status}`);
    const json = await res.json();
    const arkbEntries = Object.entries(json.market_data || {}).filter(([sym]) => sym.toUpperCase() === 'ARKB');
    if (arkbEntries.length > 0) liveArkb = arkbEntries[0][1];

    const rows = arkbEntries.length > 0
      ? arkbEntries.map(([sym, d]) => {
        const change = d.change_pct != null
          ? `<span style="color:${d.change_pct >= 0 ? '#4F9A6E' : '#B8555F'}">${d.change_pct > 0 ? '+' : ''}${d.change_pct}%</span>`
          : '—';
        return `<tr>
          <td><b>${sym}</b></td>
          <td>${d.last != null ? `$${Number(d.last).toLocaleString()}` : '—'}</td>
          <td>${d.bid != null ? `$${Number(d.bid).toLocaleString()}` : '—'}</td>
          <td>${d.ask != null ? `$${Number(d.ask).toLocaleString()}` : '—'}</td>
          <td>${d.spread_bps != null ? `${d.spread_bps} bps` : '—'}</td>
          <td>${change}</td>
        </tr>`;
      }).join('')
      : '<tr><td colspan="6" style="color:var(--caption);text-align:center">No ARKB data</td></tr>';

    $('market-overview').innerHTML = `
      <table>
        <thead><tr><th>Symbol</th><th>Last</th><th>Bid</th><th>Ask</th><th>Spread</th><th>Change</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <small style="display:block;margin-top:8px;color:var(--caption)">Updated: ${json.timestamp || new Date().toISOString()}</small>
    `;
  } catch {
    $('market-overview').innerHTML = '<div style="color:#B8555F;text-align:center">Failed to load market overview</div>';
  }
}

const ctx = $('premChart').getContext('2d');
const chart = new Chart(ctx, {
  type: 'line',
  data: {
    datasets: [
      {
        label: 'Premium/Discount (bps)',
        data: [],
        borderColor: '#6F86FF',
        backgroundColor: '#7059FB18',
        borderWidth: 1.5,
        pointRadius: 0,
        tension: 0.3,
        fill: true,
      },
      {
        label: '+trigger',
        data: [],
        borderColor: '#BFA05488',
        borderWidth: 1,
        borderDash: [4, 4],
        pointRadius: 0,
        fill: false,
      },
      {
        label: '-trigger',
        data: [],
        borderColor: '#BFA05488',
        borderWidth: 1,
        borderDash: [4, 4],
        pointRadius: 0,
        fill: false,
      },
    ],
  },
  options: {
    responsive: true,
    animation: false,
    interaction: { mode: 'index', intersect: false },
    scales: {
      x: { type: 'time', display: false },
      y: {
        grid: { color: '#7DA5FF20' },
        ticks: { color: '#7F94BA', callback: (v) => `${v.toFixed(1)} bps` },
      },
    },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: 'rgba(17,29,59,0.92)',
        titleColor: '#B8C8E6',
        bodyColor: '#9AB0D4',
        borderColor: '#7DA5FF55',
        borderWidth: 1,
      },
    },
  },
});

function setModeBadge(text, cls) {
  $('mode-badge').textContent = text;
  $('mode-badge').className = `mode ${cls}`;
}

async function standaloneTick() {
  try {
    const btc = await fetchBtcPrice();
    const snapshot = nextStandaloneSnapshot(btc);
    state.btcPrice = snapshot.btcPrice;
    state.arkbMid = snapshot.arkbMid;
    state.arkbBid = snapshot.arkbBid;
    state.arkbAsk = snapshot.arkbAsk;
    state.nav = snapshot.nav;
    state.premBps = snapshot.premBps;
    state.signal = snapshot.signal;

    const ev = evaluate(snapshot.arkbMid, snapshot.btcPrice, state.btcPerShare);
    registerTradeFromEval(snapshot, ev);
    renderSnapshot(snapshot);

    setModeBadge(liveArkb ? 'LIVE' : 'LIVE+SIM ARKB', 'mode-live');
    $('conn-status').className = 'connected';
    $('conn-text').textContent = liveArkb ? 'Live (BTC + ARKB)' : 'Live BTC / sim ARKB';
  } catch {
    setModeBadge('DATA ERROR', 'mode-dry');
    $('conn-status').className = '';
    $('conn-text').textContent = 'Data Error';
  }
}

function applyBackendSnapshot(s) {
  state.backendLive = true;
  if (s.btcPerShare) {
    state.btcPerShare = s.btcPerShare;
    state.btcPerShareSource = s.btcPerShareSource || state.btcPerShareSource;
  }
  if (typeof s.totalPnl === 'number') state.totalPnl = s.totalPnl;
  if (typeof s.tradeCount === 'number') state.tradeCount = s.tradeCount;
  if (typeof s.winRate === 'number') state.winRate = s.winRate;
  renderSnapshot(s);
  setModeBadge(s.dryRun ? 'BACKEND DRY-RUN' : 'BACKEND LIVE', s.dryRun ? 'mode-dry' : 'mode-backend');
  $('conn-status').className = 'connected';
  $('conn-text').textContent = s.dryRun ? 'Socket connected (dry-run)' : 'Socket connected';
}

function startBackendMode() {
  if (typeof io !== 'function') return false;
  const socket = io({ transports: ['websocket', 'polling'], reconnection: true });
  let connected = false;

  socket.on('connect', () => {
    connected = true;
    state.mode = 'backend';
    if (standaloneTimer) {
      clearInterval(standaloneTimer);
      standaloneTimer = null;
    }
    $('conn-status').className = 'connected';
    $('conn-text').textContent = 'Socket connected';
  });

  socket.on('snapshot', (s) => applyBackendSnapshot(s));
  socket.on('trade', (t) => addTradeRow(t));
  socket.on('trades', (trades) => {
    if (!Array.isArray(trades)) return;
    const tbody = $('trades-body');
    tbody.innerHTML = '';
    if (trades.length === 0) {
      $('no-trades').style.display = 'block';
      return;
    }
    $('no-trades').style.display = 'none';
    trades.slice().reverse().forEach(addTradeRow);
  });
  socket.on('disconnect', () => {
    $('conn-status').className = '';
    $('conn-text').textContent = 'Disconnected — falling back';
    if (!standaloneTimer) {
      standaloneTimer = setInterval(standaloneTick, 5000);
      standaloneTick();
    }
  });

  setTimeout(() => {
    if (!connected && !standaloneTimer) {
      standaloneTimer = setInterval(standaloneTick, 5000);
      standaloneTick();
    }
  }, 1200);

  return true;
}

async function boot() {
  await loadConfig();
  setCostModel();
  startBackendMode();
  loadMarketOverview();
  setInterval(loadMarketOverview, 5000);

  $('refresh-btn').addEventListener('click', () => {
    if (state.mode === 'backend' && state.backendLive) {
      fetch('/api/state').then((r) => r.json()).then(applyBackendSnapshot).catch(() => standaloneTick());
    } else {
      standaloneTick();
    }
    loadMarketOverview();
  });
}

boot();
