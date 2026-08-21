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
  results: 100
};

const FIELD_COLORS = ['#79e7c0', '#f2a65a', '#7aa7f2', '#e36464', '#c99bf0', '#f2e07a', '#6fd1e0', '#e08fc0'];

const STORAGE_KEY = 'thesisTalkbackConfig';

let CFG = loadConfig();
let channelMeta = null;
let feeds = [];
let activeFields = new Set();
let chartType = 'line';
let chartInstance = null;
let refreshTimer = null;
let tbLog = [];

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
  document.getElementById('footChannelId').textContent = CFG.channelId;
}

/* ---------------- Stats helpers ---------------- */

function mean(arr){ return arr.reduce((a,b)=>a+b,0) / arr.length; }

function median(arr){
  const s = [...arr].sort((a,b)=>a-b);
  const mid = Math.floor(s.length/2);
  return s.length % 2 ? s[mid] : (s[mid-1]+s[mid])/2;
}

function stddev(arr, avg){
  const m = avg ?? mean(arr);
  const variance = arr.reduce((a,b)=>a + Math.pow(b-m,2), 0) / (arr.length - 1 || 1);
  return Math.sqrt(variance);
}

function computeFieldStats(values){
  const nums = values.filter(v => typeof v === 'number' && !Number.isNaN(v));
  if (!nums.length) return null;
  const m = mean(nums);
  return {
    n: nums.length,
    current: nums[nums.length - 1],
    mean: m,
    median: median(nums),
    std: stddev(nums, m),
    min: Math.min(...nums),
    max: Math.max(...nums)
  };
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

    renderAll();
    setScopeStatus(`live · ${feeds.length} points · channel ${CFG.channelId}`, true);
    document.getElementById('lastUpdated').textContent = `Updated ${new Date().toLocaleTimeString()}`;
  }catch(err){
    console.error(err);
    setScopeStatus(`connection error — check settings (${err.message})`, false);
  }
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
          <div>n <b>${stats.n}</b></div>
          <div>min <b>${fmt(stats.min)}</b></div>
          <div>max <b>${fmt(stats.max)}</b></div>
        </div>`;
    }
    grid.appendChild(card);
  });
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

function renderChart(){
  const ctx = document.getElementById('mainChart').getContext('2d');
  const keys = getFieldKeys().filter(k => activeFields.has(k));
  if (chartInstance) chartInstance.destroy();

  const gridColor = '#262c30';
  const textColor = '#8a959b';
  Chart.defaults.font.family = "'IBM Plex Mono', monospace";
  Chart.defaults.color = textColor;

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
          borderWidth: 1
        }))
      },
      options: baseChartOptions('Value bucket', 'Frequency')
    });
    return;
  }

  if (chartType === 'scatter'){
    const datasets = keys.map(key => {
      const idx = getFieldKeys().indexOf(key);
      return {
        label: fieldLabel(key),
        data: feeds.map((f, i) => ({ x: i, y: f[key] })).filter(p => p.y !== null),
        backgroundColor: fieldColor(idx),
        pointRadius: 3
      };
    });
    chartInstance = new Chart(ctx, {
      type: 'scatter',
      data: { datasets },
      options: baseChartOptions('Sample index', 'Value')
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
      borderWidth: 2,
      pointRadius: chartType === 'bar' ? 0 : 2,
      tension: 0.25,
      fill: chartType === 'line'
    };
  });
  chartInstance = new Chart(ctx, {
    type: chartType === 'bar' ? 'bar' : 'line',
    data: { labels, datasets },
    options: baseChartOptions('Time', 'Value')
  });
}

function baseChartOptions(xLabel, yLabel){
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    scales: {
      x: { title: { display: true, text: xLabel, color: '#8a959b' }, grid: { color: '#262c30' }, ticks: { maxTicksLimit: 10 } },
      y: { title: { display: true, text: yLabel, color: '#8a959b' }, grid: { color: '#262c30' } }
    },
    plugins: {
      legend: { labels: { boxWidth: 10, boxHeight: 10 } }
    }
  };
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
  renderStats();
  renderFieldToggle();
  renderChart();
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
      results: parseInt(document.getElementById('cfgResults').value, 10)
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

document.addEventListener('DOMContentLoaded', init);
