/* ============================================================
   Thesis TalkBack Console
   Reads Fields from a ThingSpeak channel, computes live stats,
   renders line/scatter/bar/histogram charts, and provides a
   TalkBack queue + raw data export — all client-side.
   ============================================================ */

const DEFAULTS = {
  channelId: '3465093',
  readKey: '8LU7OMUK7B6VFWJG',
  writeKey: '0KGGB9EFXMAAKKQX',
  talkbackId: '57615',
  talkbackKey: 'V8GH0JVA5AF06PR6',
  interval: 10000,
  results: 100,
  staleMinutes: 10
};

const FIELD_COLORS = ['#79e7c0', '#f2a65a', '#7aa7f2', '#e36464', '#c99bf0', '#f2e07a', '#6fd1e0', '#e08fc0'];

const STORAGE_KEY = 'thesisTalkbackConfig';
const THEME_KEY = 'thesisTalkbackTheme';
const SESSION_KEY = 'thesisTalkbackAuthUser';

/* Client-side access gate — a basic deterrent for a static research dashboard,
   not a real security boundary. Anyone who views the page source can read these
   credentials, so this is not a substitute for server-side authentication. */
const CREDENTIALS = {
  'm.rahman':  { password: 'Supervisor',    label: 'Md. Mahmudur Rahman (Supervisor)' },
  'abs':       { password: 'ugr_thesis_abs', label: 'Md Asif Bin Sayed (Thesis Student)' },
  'p.debnath': { password: 'ugr_thesis_prc', label: 'Pingki Rani (Thesis Student)' }
};

let CFG = loadConfig();
let channelMeta = null;
let feeds = [];
let activeFields = new Set();
let chartType = 'line';
let chartInstance = null;
let refreshTimer = null;
let tbLog = [];
let stationOffline = false;

/* ---------------- Config handling ---------------- */

function loadConfig(){
  try{
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (saved) return { ...DEFAULTS, ...saved };
  }catch(e){ /* ignore */ }
  return { ...DEFAULTS };
}

function saveConfig(cfg){
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
}

function populateConfigForm(){
  document.getElementById('cfgChannelId').value = CFG.channelId;
  document.getElementById('cfgReadKey').value = CFG.readKey;
  document.getElementById('cfgWriteKey').value = CFG.writeKey;
  document.getElementById('cfgTalkbackId').value = CFG.talkbackId;
  document.getElementById('cfgTalkbackKey').value = CFG.talkbackKey;
  document.getElementById('cfgInterval').value = String(CFG.interval);
  document.getElementById('cfgResults').value = String(CFG.results);
  document.getElementById('cfgStaleMinutes').value = String(CFG.staleMinutes);
  document.getElementById('footChannelId').textContent = CFG.channelId;
}

/* ---------------- Theme handling ---------------- */

function loadTheme(){
  try{ return localStorage.getItem(THEME_KEY) || 'dark'; }catch(e){ return 'dark'; }
}

function applyTheme(theme){
  document.body.dataset.theme = theme;
  document.getElementById('themeIcon').textContent = theme === 'light' ? '☀️' : '🌙';
  try{ localStorage.setItem(THEME_KEY, theme); }catch(e){ /* ignore */ }
}

function toggleTheme(){
  const next = document.body.dataset.theme === 'light' ? 'dark' : 'light';
  applyTheme(next);
}

/* ---------------- Auth gate ----------------
   Session persists only for this browser tab (sessionStorage): a refresh keeps
   the session, but closing the tab (or the browser) clears it and login is
   required again on the next visit. */

function currentAuthUser(){
  try{ return sessionStorage.getItem(SESSION_KEY); }catch(e){ return null; }
}

function attemptLogin(username, password){
  const user = CREDENTIALS[username];
  if (!user || user.password !== password) return false;
  try{ sessionStorage.setItem(SESSION_KEY, username); }catch(e){ /* ignore */ }
  return true;
}

function logout(){
  try{ sessionStorage.removeItem(SESSION_KEY); }catch(e){ /* ignore */ }
  window.location.reload();
}

function unlockConsole(username){
  document.getElementById('loginOverlay').remove();
  document.body.classList.remove('auth-locked');
  const tag = document.getElementById('sessionTag');
  const label = (CREDENTIALS[username] && CREDENTIALS[username].label) || username;
  document.getElementById('sessionUser').textContent = label;
  tag.hidden = false;
  document.getElementById('logoutBtn').hidden = false;
  init();
}

function setupLoginGate(){
  const existing = currentAuthUser();
  if (existing && CREDENTIALS[existing]){
    unlockConsole(existing);
    return;
  }
  document.body.classList.add('auth-locked');
  const form = document.getElementById('loginForm');
  const errorEl = document.getElementById('loginError');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const username = document.getElementById('loginUser').value.trim();
    const password = document.getElementById('loginPass').value;
    if (attemptLogin(username, password)){
      unlockConsole(username);
    } else {
      errorEl.textContent = 'Incorrect username or password.';
      document.getElementById('loginPass').value = '';
    }
  });
}

/* ---------------- Stats helpers ---------------- */

function mean(arr){ return arr.reduce((a,b)=>a+b,0) / arr.length; }

function median(arr){
  const s = [...arr].sort((a,b)=>a-b);
  const mid = Math.floor(s.length/2);
  return s.length % 2 ? s[mid] : (s[mid-1]+s[mid])/2;
}

function variance(arr, avg){
  const m = avg ?? mean(arr);
  return arr.reduce((a,b)=>a + Math.pow(b-m,2), 0) / (arr.length - 1 || 1);
}

function stddev(arr, avg){
  return Math.sqrt(variance(arr, avg));
}

function quantile(sorted, q){
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  return sorted[base + 1] !== undefined ? sorted[base] + rest * (sorted[base + 1] - sorted[base]) : sorted[base];
}

function skewness(arr, avg, sd){
  const n = arr.length;
  if (n < 3 || sd === 0) return 0;
  const m3 = arr.reduce((a,b)=>a + Math.pow(b-avg,3), 0) / n;
  return m3 / Math.pow(sd, 3);
}

function kurtosisExcess(arr, avg, sd){
  const n = arr.length;
  if (n < 4 || sd === 0) return 0;
  const m4 = arr.reduce((a,b)=>a + Math.pow(b-avg,4), 0) / n;
  return (m4 / Math.pow(sd, 4)) - 3;
}

/* Research-grade descriptive stats for a single field: central tendency,
   dispersion, distribution shape, and inferential estimates (SE / 95% CI). */
function computeFieldStats(values){
  const nums = values.filter(v => typeof v === 'number' && !Number.isNaN(v));
  if (!nums.length) return null;
  const sorted = [...nums].sort((a,b)=>a-b);
  const m = mean(nums);
  const sd = stddev(nums, m);
  const q1 = quantile(sorted, 0.25);
  const q3 = quantile(sorted, 0.75);
  const se = sd / Math.sqrt(nums.length);
  return {
    n: nums.length,
    current: nums[nums.length - 1],
    mean: m,
    median: median(nums),
    std: sd,
    variance: variance(nums, m),
    min: sorted[0],
    max: sorted[sorted.length - 1],
    range: sorted[sorted.length - 1] - sorted[0],
    q1, q3,
    iqr: q3 - q1,
    cv: m !== 0 ? (sd / Math.abs(m)) * 100 : 0,
    skewness: skewness(nums, m, sd),
    kurtosis: kurtosisExcess(nums, m, sd),
    se,
    ci95Low: m - 1.96 * se,
    ci95High: m + 1.96 * se
  };
}

function pearsonCorrelation(a, b){
  const pairs = [];
  for (let i = 0; i < a.length && i < b.length; i++){
    if (typeof a[i] === 'number' && typeof b[i] === 'number' && !Number.isNaN(a[i]) && !Number.isNaN(b[i])){
      pairs.push([a[i], b[i]]);
    }
  }
  if (pairs.length < 2) return null;
  const xs = pairs.map(p => p[0]), ys = pairs.map(p => p[1]);
  const mx = mean(xs), my = mean(ys);
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < pairs.length; i++){
    const dx = xs[i] - mx, dy = ys[i] - my;
    num += dx * dy; dx2 += dx * dx; dy2 += dy * dy;
  }
  const denom = Math.sqrt(dx2 * dy2);
  return denom === 0 ? null : num / denom;
}

function fmt(n){
  if (n === undefined || n === null || Number.isNaN(n)) return '—';
  return Math.abs(n) >= 1000 ? n.toFixed(1) : (Number.isInteger(n) ? n.toString() : n.toFixed(3));
}

/* ---------------- Field discovery ---------------- */

function getFieldKeys(){
  if (!channelMeta) return [];
  return Object.keys(channelMeta)
    .filter(k => /^field\d$/.test(k) && channelMeta[k])
    .sort((a,b)=> parseInt(a.replace('field','')) - parseInt(b.replace('field','')));
}

function fieldLabel(key){
  return channelMeta && channelMeta[key] ? channelMeta[key] : key;
}

function fieldColor(index){
  return FIELD_COLORS[index % FIELD_COLORS.length];
}

/* ---------------- Fetching ---------------- */

async function fetchFeeds(){
  setScopeStatus('fetching…', false);
  const resultsParam = CFG.results;
  const url = `https://api.thingspeak.com/channels/${encodeURIComponent(CFG.channelId)}/feeds.json?api_key=${encodeURIComponent(CFG.readKey)}&results=${resultsParam}`;
  try{
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data || !data.channel) throw new Error('Unexpected response shape');
    channelMeta = data.channel;
    feeds = (data.feeds || []).map(f => {
      const parsed = { entry_id: f.entry_id, created_at: f.created_at };
      getFieldKeys().forEach(k => { parsed[k] = f[k] !== null && f[k] !== undefined && f[k] !== '' ? parseFloat(f[k]) : null; });
      return parsed;
    });

    if (activeFields.size === 0){
      getFieldKeys().slice(0, 4).forEach(k => activeFields.add(k));
    }

    stationOffline = checkStationOffline();
    renderAll();

    if (stationOffline){
      setScopeStatus(`no data from Sending Station — troubleshoot ESP32`, false);
    } else {
      setScopeStatus(`live · ${feeds.length} points · channel ${CFG.channelId}`, true);
    }
    document.getElementById('lastUpdated').textContent = `Updated ${new Date().toLocaleTimeString()}`;
  }catch(err){
    console.error(err);
    stationOffline = true;
    renderNoDataBanners();
    setScopeStatus(`connection error — check settings (${err.message})`, false);
  }
}

/* A "no data" condition covers both an empty feed and a feed whose newest
   entry is older than the configured staleness window — i.e. the ESP32 has
   gone quiet even though ThingSpeak itself is reachable. */
function checkStationOffline(){
  if (!feeds.length) return true;
  const last = feeds[feeds.length - 1];
  const lastTime = new Date(last.created_at).getTime();
  if (Number.isNaN(lastTime)) return false;
  const staleMs = (CFG.staleMinutes || 10) * 60 * 1000;
  return (Date.now() - lastTime) > staleMs;
}

function renderNoDataBanners(){
  const slots = ['chartNoData', 'statsNoData', 'tableNoData'];
  const tpl = document.getElementById('noDataBannerTemplate');
  slots.forEach(id => {
    const slot = document.getElementById(id);
    if (!slot) return;
    slot.innerHTML = '';
    if (stationOffline) slot.appendChild(tpl.content.cloneNode(true));
  });
}

function setScopeStatus(text, live){
  document.getElementById('scopeStatus').textContent = text;
  document.getElementById('liveDot').classList.toggle('live', !!live);
}

/* ---------------- Rendering: stats ---------------- */

function renderStats(){
  const grid = document.getElementById('statsGrid');
  const keys = getFieldKeys();
  if (!keys.length || !feeds.length){
    grid.innerHTML = '<p class="empty-state">No numeric fields found yet — check your channel ID and read key.</p>';
    return;
  }
  grid.innerHTML = '';
  keys.forEach((key, i) => {
    const values = feeds.map(f => f[key]);
    const stats = computeFieldStats(values);
    const card = document.createElement('div');
    card.className = 'stat-card';
    card.style.setProperty('--fld-color', fieldColor(i));
    card.style.borderLeftColor = fieldColor(i);
    if (!stats){
      card.innerHTML = `<h3>${fieldLabel(key)}<span class="field-tag">${key}</span></h3><p class="empty-state">No data</p>`;
    } else {
      card.innerHTML = `
        <h3>${fieldLabel(key)}<span class="field-tag">${key}</span></h3>
        <span class="current-val">${fmt(stats.current)}</span>
        <div class="mini-stats">
          <div>mean <b>${fmt(stats.mean)}</b></div>
          <div>median <b>${fmt(stats.median)}</b></div>
          <div>std dev <b>${fmt(stats.std)}</b></div>
          <div>variance <b>${fmt(stats.variance)}</b></div>
          <div>n <b>${stats.n}</b></div>
          <div>CV <b>${fmt(stats.cv)}%</b></div>
          <div>min <b>${fmt(stats.min)}</b></div>
          <div>max <b>${fmt(stats.max)}</b></div>
          <div>range <b>${fmt(stats.range)}</b></div>
          <div>IQR (Q1–Q3) <b>${fmt(stats.q1)}–${fmt(stats.q3)}</b></div>
          <div>skewness <b>${fmt(stats.skewness)}</b></div>
          <div>excess kurtosis <b>${fmt(stats.kurtosis)}</b></div>
          <div>std error <b>${fmt(stats.se)}</b></div>
          <div>95% CI <b>${fmt(stats.ci95Low)} – ${fmt(stats.ci95High)}</b></div>
        </div>`;
    }
    grid.appendChild(card);
  });
  renderCorrelationTable(keys);
}

/* ---------------- Rendering: correlation matrix ---------------- */

function renderCorrelationTable(keys){
  const block = document.getElementById('corrBlock');
  const table = document.getElementById('corrTable');
  if (keys.length < 2 || !feeds.length){
    block.hidden = true;
    return;
  }
  block.hidden = false;
  const series = keys.map(k => feeds.map(f => f[k]));
  let html = '<thead><tr><th></th>' + keys.map(k => `<th>${fieldLabel(k)}</th>`).join('') + '</tr></thead><tbody>';
  keys.forEach((rowKey, i) => {
    html += `<tr><th>${fieldLabel(rowKey)}</th>`;
    keys.forEach((colKey, j) => {
      const r = i === j ? 1 : pearsonCorrelation(series[i], series[j]);
      html += `<td class="heatmap-cell${i === j ? ' self' : ''}" style="background:${corrColor(r)}">${r === null ? '—' : r.toFixed(2)}</td>`;
    });
    html += '</tr>';
  });
  html += '</tbody>';
  table.innerHTML = html;
}

/* Diverging red↔teal scale: -1 strongly negative, 0 neutral, +1 strongly positive. */
function corrColor(r){
  if (r === null || Number.isNaN(r)) return 'var(--panel-alt)';
  const t = (r + 1) / 2;
  const neg = [227, 100, 100], pos = [121, 231, 192];
  const mix = neg.map((c, i) => Math.round(c + (pos[i] - c) * t));
  return `rgb(${mix[0]},${mix[1]},${mix[2]})`;
}

/* ---------------- Rendering: field toggle chips ---------------- */

function renderFieldToggle(){
  const wrap = document.getElementById('fieldToggle');
  const keys = getFieldKeys();
  wrap.innerHTML = '';
  keys.forEach((key, i) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'field-chip' + (activeFields.has(key) ? ' active' : '');
    chip.style.setProperty('--fld-color', fieldColor(i));
    chip.innerHTML = `<span class="swatch"></span>${fieldLabel(key)}`;
    chip.addEventListener('click', () => {
      if (activeFields.has(key)) activeFields.delete(key); else activeFields.add(key);
      renderFieldToggle();
      renderChart();
    });
    wrap.appendChild(chip);
  });
}

/* ---------------- Rendering: chart ---------------- */

function buildHistogramBins(values, binCount = 12){
  const nums = values.filter(v => typeof v === 'number' && !Number.isNaN(v));
  if (!nums.length) return { labels: [], counts: [] };
  const min = Math.min(...nums), max = Math.max(...nums);
  const width = (max - min) / binCount || 1;
  const counts = new Array(binCount).fill(0);
  nums.forEach(v => {
    let idx = Math.floor((v - min) / width);
    if (idx >= binCount) idx = binCount - 1;
    if (idx < 0) idx = 0;
    counts[idx]++;
  });
  const labels = counts.map((_, i) => (min + i * width).toFixed(1));
  return { labels, counts };
}

function themeColors(){
  const cs = getComputedStyle(document.body);
  return {
    grid: cs.getPropertyValue('--grid-line').trim() || '#262c30',
    text: cs.getPropertyValue('--muted').trim() || '#8a959b',
    panel: cs.getPropertyValue('--panel-alt').trim() || '#20262a'
  };
}

/* Draws a dashed mean line and a translucent ±1σ band behind a dataset —
   the "statistical overlay" toggle. Registered per-chart via the plugins array. */
function statOverlayPlugin(fieldStatsByIndex){
  return {
    id: 'statOverlay',
    beforeDatasetsDraw(chart){
      if (!document.getElementById('statOverlayToggle').checked) return;
      const { ctx, chartArea, scales } = chart;
      if (!chartArea) return;
      chart.data.datasets.forEach((ds, i) => {
        const stats = fieldStatsByIndex[i];
        if (!stats) return;
        const y = scales.y;
        const meanY = y.getPixelForValue(stats.mean);
        const hiY = y.getPixelForValue(stats.mean + stats.std);
        const loY = y.getPixelForValue(stats.mean - stats.std);
        ctx.save();
        ctx.fillStyle = ds.borderColor + '1a';
        ctx.fillRect(chartArea.left, Math.min(hiY, loY), chartArea.right - chartArea.left, Math.abs(loY - hiY));
        ctx.strokeStyle = ds.borderColor;
        ctx.setLineDash([6, 4]);
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(chartArea.left, meanY);
        ctx.lineTo(chartArea.right, meanY);
        ctx.stroke();
        ctx.restore();
      });
    }
  };
}

function renderChart(){
  const canvas = document.getElementById('mainChart');
  const heatmapWrap = document.getElementById('heatmapWrap');
  const keys = getFieldKeys().filter(k => activeFields.has(k));
  if (chartInstance){ chartInstance.destroy(); chartInstance = null; }

  const isHeatmap = chartType === 'heatmap';
  canvas.style.display = isHeatmap ? 'none' : 'block';
  heatmapWrap.hidden = !isHeatmap;

  if (isHeatmap){
    renderCorrelationHeatmap(heatmapWrap, keys);
    return;
  }

  const ctx = canvas.getContext('2d');
  const theme = themeColors();
  Chart.defaults.font.family = "'IBM Plex Mono', monospace";
  Chart.defaults.color = theme.text;

  if (chartType === 'boxplot'){
    renderBoxPlot(ctx, canvas, keys, theme);
    return;
  }

  if (chartType === 'histogram'){
    const datasets = keys.map((key, i) => {
      const idx = getFieldKeys().indexOf(key);
      const { labels, counts } = buildHistogramBins(feeds.map(f => f[key]));
      return { key, labels, counts, color: fieldColor(idx) };
    });
    const labels = datasets[0] ? datasets[0].labels : [];
    chartInstance = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: datasets.map(d => ({
          label: fieldLabel(d.key),
          data: d.counts,
          backgroundColor: d.color + 'b3',
          borderColor: d.color,
          borderWidth: 1,
          borderRadius: 3
        }))
      },
      options: baseChartOptions('Value bucket', 'Frequency', theme)
    });
    return;
  }

  const fieldStatsByIndex = keys.map(key => computeFieldStats(feeds.map(f => f[key])));

  if (chartType === 'scatter'){
    const datasets = keys.map(key => {
      const idx = getFieldKeys().indexOf(key);
      return {
        label: fieldLabel(key),
        data: feeds.map((f, i) => ({ x: i, y: f[key] })).filter(p => p.y !== null),
        backgroundColor: fieldColor(idx),
        borderColor: fieldColor(idx),
        pointRadius: 3.5,
        pointHoverRadius: 5
      };
    });
    chartInstance = new Chart(ctx, {
      type: 'scatter',
      data: { datasets },
      options: baseChartOptions('Sample index', 'Value', theme),
      plugins: [statOverlayPlugin(fieldStatsByIndex)]
    });
    return;
  }

  const labels = feeds.map(f => new Date(f.created_at).toLocaleTimeString());
  const datasets = keys.map(key => {
    const idx = getFieldKeys().indexOf(key);
    const color = fieldColor(idx);
    return {
      label: fieldLabel(key),
      data: feeds.map(f => f[key]),
      borderColor: color,
      backgroundColor: chartType === 'bar' ? color + 'b3' : color + '22',
      borderWidth: 2.4,
      pointRadius: chartType === 'bar' ? 0 : 1.5,
      pointHoverRadius: 5,
      tension: chartType === 'bar' ? 0 : 0.3,
      fill: chartType === 'line',
      borderRadius: chartType === 'bar' ? 3 : 0
    };
  });
  chartInstance = new Chart(ctx, {
    type: chartType === 'bar' ? 'bar' : 'line',
    data: { labels, datasets },
    options: baseChartOptions('Time', 'Value', theme),
    plugins: [statOverlayPlugin(fieldStatsByIndex)]
  });
}

function baseChartOptions(xLabel, yLabel, theme){
  const t = theme || themeColors();
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    animation: { duration: 280 },
    layout: { padding: { top: 6, right: 10 } },
    scales: {
      x: {
        title: { display: true, text: xLabel, color: t.text, font: { size: 12, weight: 600 } },
        grid: { color: t.grid },
        ticks: { maxTicksLimit: 10, color: t.text }
      },
      y: {
        title: { display: true, text: yLabel, color: t.text, font: { size: 12, weight: 600 } },
        grid: { color: t.grid },
        ticks: { color: t.text, callback: (v) => fmt(v) }
      }
    },
    plugins: {
      legend: { labels: { boxWidth: 10, boxHeight: 10, color: t.text, usePointStyle: true } },
      tooltip: {
        backgroundColor: t.panel,
        titleColor: t.text,
        bodyColor: t.text,
        borderColor: t.grid,
        borderWidth: 1,
        padding: 10,
        callbacks: { label: (item) => `${item.dataset.label}: ${fmt(item.parsed.y)}` }
      }
    }
  };
}

/* ---------------- Rendering: box plot (hand-drawn — no Chart.js plugin needed) ---------------- */

function renderBoxPlot(ctx, canvas, keys, theme){
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.parentElement.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  canvas.style.width = rect.width + 'px';
  canvas.style.height = rect.height + 'px';
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, rect.width, rect.height);

  const padL = 56, padR = 20, padT = 20, padB = 34;
  const plotW = rect.width - padL - padR;
  const plotH = rect.height - padT - padB;

  const boxStats = keys.map((key, i) => {
    const idx = getFieldKeys().indexOf(key);
    const stats = computeFieldStats(feeds.map(f => f[key]));
    return { key, stats, color: fieldColor(idx) };
  }).filter(b => b.stats);

  if (!boxStats.length){
    ctx.fillStyle = theme.text;
    ctx.font = '13px Inter, sans-serif';
    ctx.fillText('No numeric data to plot yet.', padL, padT + 20);
    return;
  }

  const globalMin = Math.min(...boxStats.map(b => b.stats.min));
  const globalMax = Math.max(...boxStats.map(b => b.stats.max));
  const range = (globalMax - globalMin) || 1;
  const yFor = (v) => padT + plotH - ((v - globalMin) / range) * plotH;

  // gridlines + axis labels
  ctx.strokeStyle = theme.grid;
  ctx.fillStyle = theme.text;
  ctx.font = '11px "IBM Plex Mono", monospace';
  ctx.lineWidth = 1;
  const ticks = 5;
  for (let t = 0; t <= ticks; t++){
    const v = globalMin + (range * t / ticks);
    const y = yFor(v);
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(rect.width - padR, y); ctx.stroke();
    ctx.fillText(fmt(v), 6, y + 4);
  }

  const slotW = plotW / boxStats.length;
  boxStats.forEach((b, i) => {
    const cx = padL + slotW * (i + 0.5);
    const boxW = Math.min(64, slotW * 0.5);
    const { min, max, q1, q3, median: med } = b.stats;

    ctx.strokeStyle = b.color;
    ctx.lineWidth = 1.6;
    // whiskers
    ctx.beginPath();
    ctx.moveTo(cx, yFor(min)); ctx.lineTo(cx, yFor(q1));
    ctx.moveTo(cx, yFor(q3)); ctx.lineTo(cx, yFor(max));
    ctx.moveTo(cx - boxW / 4, yFor(min)); ctx.lineTo(cx + boxW / 4, yFor(min));
    ctx.moveTo(cx - boxW / 4, yFor(max)); ctx.lineTo(cx + boxW / 4, yFor(max));
    ctx.stroke();

    // box (Q1–Q3)
    ctx.fillStyle = b.color + '33';
    ctx.fillRect(cx - boxW / 2, yFor(q3), boxW, yFor(q1) - yFor(q3));
    ctx.strokeRect(cx - boxW / 2, yFor(q3), boxW, yFor(q1) - yFor(q3));

    // median line
    ctx.beginPath();
    ctx.moveTo(cx - boxW / 2, yFor(med)); ctx.lineTo(cx + boxW / 2, yFor(med));
    ctx.lineWidth = 2.4;
    ctx.stroke();

    // label
    ctx.fillStyle = theme.text;
    ctx.font = '11px "IBM Plex Mono", monospace';
    ctx.textAlign = 'center';
    ctx.fillText(fieldLabel(b.key), cx, rect.height - 12);
    ctx.textAlign = 'left';
  });
}

/* ---------------- Rendering: correlation heatmap (HTML table overlay) ---------------- */

function renderCorrelationHeatmap(wrap, keys){
  if (keys.length < 2 || !feeds.length){
    wrap.innerHTML = '<p class="empty-state">Select at least two fields to compare correlations.</p>';
    return;
  }
  const series = keys.map(k => feeds.map(f => f[k]));
  let html = '<div><table class="heatmap-grid"><thead><tr><th></th>' +
    keys.map(k => `<th>${fieldLabel(k)}</th>`).join('') + '</tr></thead><tbody>';
  keys.forEach((rowKey, i) => {
    html += `<tr><th>${fieldLabel(rowKey)}</th>`;
    keys.forEach((colKey, j) => {
      const r = i === j ? 1 : pearsonCorrelation(series[i], series[j]);
      html += `<td class="heatmap-cell${i === j ? ' self' : ''}" style="background:${corrColor(r)}">${r === null ? '—' : r.toFixed(2)}</td>`;
    });
    html += '</tr>';
  });
  html += '</tbody></table>' +
    '<div class="heatmap-legend"><span>-1</span><span class="heatmap-legend-swatch" style="background:linear-gradient(90deg, rgb(227,100,100), rgb(121,231,192))"></span><span>+1 (Pearson r)</span></div>' +
    '</div>';
  wrap.innerHTML = html;
}

/* ---------------- Rendering: table ---------------- */

function renderTable(){
  const keys = getFieldKeys();
  const head = document.getElementById('tableHead');
  const body = document.getElementById('tableBody');
  head.innerHTML = `<th>Entry</th><th>Timestamp</th>` + keys.map(k => `<th>${fieldLabel(k)}</th>`).join('');

  if (!feeds.length){
    body.innerHTML = '<tr><td class="empty-state">No data yet.</td></tr>';
    return;
  }
  const rows = [...feeds].reverse().slice(0, 200);
  body.innerHTML = rows.map(f => `
    <tr>
      <td>${f.entry_id ?? ''}</td>
      <td>${new Date(f.created_at).toLocaleString()}</td>
      ${keys.map(k => `<td>${f[k] ?? ''}</td>`).join('')}
    </tr>`).join('');
}

/* ---------------- Oscilloscope ticker ---------------- */

let scopeBuffer = [];
function pushScopePoint(){
  const keys = getFieldKeys().filter(k => activeFields.has(k));
  const key = keys[0];
  if (!key || !feeds.length) return;
  const last = feeds[feeds.length - 1][key];
  if (typeof last === 'number' && !Number.isNaN(last)) scopeBuffer.push(last);
  if (scopeBuffer.length > 120) scopeBuffer.shift();
}

function drawScope(){
  const canvas = document.getElementById('scopeCanvas');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.parentElement.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, rect.width, rect.height);

  if (scopeBuffer.length < 2){ requestAnimationFrame(drawScope); return; }

  const min = Math.min(...scopeBuffer);
  const max = Math.max(...scopeBuffer);
  const range = (max - min) || 1;
  const step = rect.width / (scopeBuffer.length - 1);

  ctx.beginPath();
  scopeBuffer.forEach((v, i) => {
    const x = i * step;
    const y = rect.height - 8 - ((v - min) / range) * (rect.height - 16);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.strokeStyle = '#79e7c0';
  ctx.lineWidth = 1.6;
  ctx.shadowColor = '#79e7c0';
  ctx.shadowBlur = 6;
  ctx.stroke();

  requestAnimationFrame(drawScope);
}

/* ---------------- TalkBack ---------------- */

async function tbQueueCommand(cmd){
  if (!cmd) return;
  const feedback = document.getElementById('tbFeedback');
  feedback.textContent = 'Sending…';
  try{
    const url = `https://api.thingspeak.com/talkbacks/${encodeURIComponent(CFG.talkbackId)}/commands.json`;
    const body = new URLSearchParams({ api_key: CFG.talkbackKey, command_string: cmd });
    const res = await fetch(url, { method: 'POST', body });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    feedback.textContent = `Queued "${cmd}" (position ${data.position ?? '?'})`;
    tbLog.unshift({ time: new Date().toLocaleTimeString(), text: `queued: ${cmd}` });
    renderTbLog();
    tbCheckStatus();
  }catch(err){
    feedback.textContent = `Failed to queue command: ${err.message}`;
  }
}

async function tbCheckStatus(){
  try{
    const execUrl = `https://api.thingspeak.com/talkbacks/${encodeURIComponent(CFG.talkbackId)}/commands/execute.json?api_key=${encodeURIComponent(CFG.talkbackKey)}`;
    const listUrl = `https://api.thingspeak.com/talkbacks/${encodeURIComponent(CFG.talkbackId)}/commands.json?api_key=${encodeURIComponent(CFG.talkbackKey)}`;
    const [execRes, listRes] = await Promise.all([fetch(execUrl), fetch(listUrl)]);
    const execData = await execRes.json().catch(() => null);
    const listData = await listRes.json().catch(() => []);
    document.getElementById('tbLastExecuted').textContent = execData && execData.command_string ? execData.command_string : '—';
    document.getElementById('tbQueueLength').textContent = Array.isArray(listData) ? listData.length : '0';
  }catch(err){
    console.error('TalkBack status check failed', err);
  }
}

function renderTbLog(){
  const list = document.getElementById('tbLogList');
  if (!tbLog.length){ list.innerHTML = '<li class="empty-state">No commands sent yet.</li>'; return; }
  list.innerHTML = tbLog.slice(0, 20).map(l => `<li><span>${l.time}</span><span>${l.text}</span></li>`).join('');
}

/* ---------------- Export ---------------- */

function downloadCsv(){
  const keys = getFieldKeys();
  const header = ['entry_id', 'created_at', ...keys.map(fieldLabel)].join(',');
  const rows = feeds.map(f => [f.entry_id, f.created_at, ...keys.map(k => f[k] ?? '')].join(','));
  triggerDownload([header, ...rows].join('\n'), 'text/csv', `thesis_talkback_channel_${CFG.channelId}.csv`);
}

function downloadJson(){
  triggerDownload(JSON.stringify({ channel: channelMeta, feeds }, null, 2), 'application/json', `thesis_talkback_channel_${CFG.channelId}.json`);
}

function triggerDownload(content, mime, filename){
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

/* ---------------- Refresh cycle ---------------- */

function scheduleRefresh(){
  if (refreshTimer) clearInterval(refreshTimer);
  if (CFG.interval > 0){
    refreshTimer = setInterval(fetchFeeds, CFG.interval);
  }
}

function renderAll(){
  renderNoDataBanners();
  renderChart();
  renderStats();
  renderFieldToggle();
  renderTable();
  pushScopePoint();
}

/* ---------------- Wiring ---------------- */

function init(){
  populateConfigForm();

  document.getElementById('configToggle').addEventListener('click', () => {
    const panel = document.getElementById('configPanel');
    panel.hidden = !panel.hidden;
  });

  document.getElementById('saveConfig').addEventListener('click', () => {
    CFG = {
      channelId: document.getElementById('cfgChannelId').value.trim() || DEFAULTS.channelId,
      readKey: document.getElementById('cfgReadKey').value.trim() || DEFAULTS.readKey,
      writeKey: document.getElementById('cfgWriteKey').value.trim() || DEFAULTS.writeKey,
      talkbackId: document.getElementById('cfgTalkbackId').value.trim() || DEFAULTS.talkbackId,
      talkbackKey: document.getElementById('cfgTalkbackKey').value.trim() || DEFAULTS.talkbackKey,
      interval: parseInt(document.getElementById('cfgInterval').value, 10),
      results: parseInt(document.getElementById('cfgResults').value, 10),
      staleMinutes: parseInt(document.getElementById('cfgStaleMinutes').value, 10)
    };
    saveConfig(CFG);
    document.getElementById('footChannelId').textContent = CFG.channelId;
    activeFields = new Set();
    fetchFeeds();
    tbCheckStatus();
    scheduleRefresh();
    document.getElementById('configPanel').hidden = true;
  });

  document.getElementById('refreshNow').addEventListener('click', fetchFeeds);

  document.getElementById('chartTypeSeg').addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-btn');
    if (!btn) return;
    document.querySelectorAll('.seg-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    chartType = btn.dataset.type;
    renderChart();
  });

  document.getElementById('statOverlayToggle').addEventListener('change', renderChart);

  document.getElementById('logoutBtn').addEventListener('click', logout);

  document.getElementById('tbSend').addEventListener('click', () => {
    const input = document.getElementById('tbCommand');
    const cmd = input.value.trim();
    if (cmd) tbQueueCommand(cmd);
    input.value = '';
  });
  document.getElementById('tbCommand').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('tbSend').click();
  });
  document.getElementById('tbRefresh').addEventListener('click', tbCheckStatus);

  document.getElementById('downloadCsv').addEventListener('click', downloadCsv);
  document.getElementById('downloadJson').addEventListener('click', downloadJson);

  requestAnimationFrame(drawScope);

  fetchFeeds();
  tbCheckStatus();
  scheduleRefresh();
}

function bootstrap(){
  applyTheme(loadTheme());
  document.getElementById('themeToggle').addEventListener('click', () => {
    toggleTheme();
    if (chartInstance || chartType === 'boxplot' || chartType === 'heatmap') renderChart();
  });
  setupLoginGate(); // calls init() itself once a valid session exists
}

document.addEventListener('DOMContentLoaded', bootstrap);
