/* dashboard.js — professional realtime dashboard
   Works with server that emits: 'telemetry:update' and responds to 'request:init'
*/

(function(){
  // -------------------------
  // Helpers & config
  // -------------------------
  const $ = (id) => document.getElementById(id);
  const socket = io(); // single socket instance

  // Default thresholds
  const DEFAULTS = {
    fuelWarn: 30,  // % -> yellow
    fuelCrit: 10,  // % -> red
    tempWarn: 70,  // C
    tempCrit: 90
  };     

  // restore settings from localStorage
  function loadSettings(){
    const s = JSON.parse(localStorage.getItem('diesel_settings') || '{}');
    return Object.assign({}, DEFAULTS, s);
  }
  function saveSettings(obj){
    localStorage.setItem('diesel_settings', JSON.stringify(obj));
  }
  let settings = loadSettings();

  // persist theme preference
  function applyThemeFromStorage(){
    const t = localStorage.getItem('theme');
    if(t === 'dark') document.documentElement.classList.add('dark');
    else document.documentElement.classList.remove('dark');
  }
  applyThemeFromStorage();

  // -------------------------
  // Charts
  // -------------------------
  function makeGradient(ctx, color){
    const g = ctx.createLinearGradient(0,0,0,200);
    g.addColorStop(0, color + '33');
    g.addColorStop(1, color + '00');
    return g;
  }

  function createChart(ctxEl, color, label){
    const ctx = ctxEl.getContext('2d');
    const gradient = makeGradient(ctx, color);
    return new Chart(ctx, {
      type: 'line',
      data: { labels: [], datasets: [{ label, data: [], borderColor: color, backgroundColor: gradient, fill: true, tension: 0.35, borderWidth: 2, pointRadius: 2 }]},
      options: {
        responsive: true,
        plugins: { legend: { display: false }, tooltip: { mode: 'index', intersect: false }},
        interaction: { mode: 'nearest', intersect: false },
        scales: { x: { display: false }, y: { beginAtZero: true } }
      }
    });
  }

  const fuelChart = createChart($('fuelChart'), '#059669', 'Fuel %');
  const fuelHistory = createChart($('fuelHistory'), '#16a34a', 'Fuel history');
  const tempChart = createChart($('tempChart'), '#f59e0b', 'Temp °C');
  const flowChart = createChart($('flowChart'), '#2563eb', 'Flow L/h');

  // keep a small in-memory history (for CSV/export)
  const HISTORY_MAX = 400;
  const history = []; // each = {deviceId, timestamp, fuel_level_pct, temperature_c, flow_lph, lat, lon, status}

  // device management
  const devices = {}; // deviceId -> last telemetry
  function selectDevice(deviceId){
    $('deviceSelect').value = deviceId || '';
    updateDeviceMeta(deviceId);
  }

  function addDeviceToSelect(deviceId){
    const sel = $('deviceSelect');
    if(!Array.from(sel.options).find(o => o.value === deviceId)){
      const opt = document.createElement('option'); opt.value = deviceId; opt.textContent = deviceId;
      sel.appendChild(opt);
    }
  }

  // -------------------------
  // UI updates & feed
  // -------------------------
  function toTime(ts){ return new Date(ts).toLocaleTimeString(); }

  function badgeFor(metric, value){
    if(metric === 'fuel'){
      if(value <= settings.fuelCrit) return { text: 'CRITICAL', cls: 'badge-crit' };
      if(value <= settings.fuelWarn) return { text: 'LOW', cls: 'badge-warn' };
      return { text: 'OK', cls: 'badge-ok' };
    }
    if(metric === 'temp'){
      if(value >= settings.tempCrit) return { text: 'CRITICAL', cls: 'badge-crit' };
      if(value >= settings.tempWarn) return { text: 'HIGH', cls: 'badge-warn' };
      return { text: 'OK', cls: 'badge-ok' };
    }
    if(metric === 'flow'){
      // flow thresholds are demo examples
      if(value <= 5) return { text: 'CRITICAL', cls: 'badge-crit' };
      if(value <= 15) return { text: 'LOW', cls: 'badge-warn' };
      return { text: 'OK', cls: 'badge-ok' };
    }
    return { text: '—', cls: 'badge-ok' };
  }

  function showAlertBanner(msg){
    const b = $('alertBanner');
    b.textContent = msg;
    b.classList.remove('hidden');
    setTimeout(()=> b.classList.add('hidden'), 12_000);
  }

  function appendFeedEntry(tel){
    const feed = $('liveFeed');
    const div = document.createElement('div');
    div.className = 'flex items-center justify-between gap-3 py-2 px-2';
    const ts = toTime(tel.timestamp);
    const fuelBadge = badgeFor('fuel', tel.fuel_level_pct);
    const tempBadge = badgeFor('temp', tel.temperature_c);
    const flowBadge = badgeFor('flow', tel.flow_lph);

    div.innerHTML = `
      <div class="flex-1">
        <div class="text-xs text-slate-400">${ts} — <span class="font-medium">${tel.deviceId}</span></div>
        <div class="text-sm mt-1 font-mono">
          Fuel: <span class="font-semibold">${tel.fuel_level_pct}%</span>
          <span class="${fuelBadge.cls} px-2 py-0.5 rounded ml-2 text-xs">${fuelBadge.text}</span>
          &nbsp; • Temp: <span class="font-semibold">${tel.temperature_c}°C</span>
          <span class="${tempBadge.cls} px-2 py-0.5 rounded ml-2 text-xs">${tempBadge.text}</span>
          &nbsp; • Flow: <span class="font-semibold">${tel.flow_lph} L/h</span>
          <span class="${flowBadge.cls} px-2 py-0.5 rounded ml-2 text-xs">${flowBadge.text}</span>
        </div>
      </div>
    `;
    // add top
    feed.prepend(div);
    // limit entries
    while(feed.children.length > 200) feed.removeChild(feed.lastChild);
  }

  function pushToHistory(tel){
    history.push(tel);
    if(history.length > HISTORY_MAX) history.shift();
    // populate recent list
    const r = $('recentList');
    const entry = document.createElement('div');
    entry.className = 'text-sm py-1';
    entry.innerHTML = `<div class="text-xs text-slate-400">${toTime(tel.timestamp)}</div>
      <div class="text-sm">${tel.deviceId} — Fuel ${tel.fuel_level_pct}%</div>`;
    r.prepend(entry);
    if(r.children.length > 120) r.removeChild(r.lastChild);
  }

  // -------------------------
  // CSV export
  // -------------------------
  function exportCsv(){
    if(history.length === 0){ alert('No history to export'); return; }
    const hdr = ['timestamp,deviceId,fuel_level_pct,temperature_c,flow_lph,lat,lon,status'];
    const rows = history.map(h => `${new Date(h.timestamp).toISOString()},${h.deviceId},${h.fuel_level_pct},${h.temperature_c},${h.flow_lph},${h.lat||''},${h.lon||''},${h.status||''}`);
    const csv = hdr.concat(rows).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `diesel-history-${Date.now()}.csv`; document.body.appendChild(a); a.click(); a.remove();
  }

  $('exportCsv').addEventListener('click', exportCsv);

  // -------------------------
  // Settings modal logic
  // -------------------------
  function openSettings(){
    $('fuelWarn').value = settings.fuelWarn;
    $('fuelCrit').value = settings.fuelCrit;
    $('tempWarn').value = settings.tempWarn;
    $('tempCrit').value = settings.tempCrit;
    $('settingsModal').classList.remove('hidden');
    $('settingsModal').style.display = 'flex';
  }
  function closeSettings(){
    $('settingsModal').classList.add('hidden');
    $('settingsModal').style.display = 'none';
  }
  $('openSettings').addEventListener('click', openSettings);
  $('settingsBtn').addEventListener('click', openSettings);
  $('closeSettings').addEventListener('click', closeSettings);

  $('saveSettings').addEventListener('click', () => {
    settings.fuelWarn = Number($('fuelWarn').value) || DEFAULTS.fuelWarn;
    settings.fuelCrit = Number($('fuelCrit').value) || DEFAULTS.fuelCrit;
    settings.tempWarn = Number($('tempWarn').value) || DEFAULTS.tempWarn;
    settings.tempCrit = Number($('tempCrit').value) || DEFAULTS.tempCrit;
    saveSettings(settings);
    closeSettings();
    showAlertBanner('Settings saved');
  });

  $('resetSettings').addEventListener('click', () => {
    settings = Object.assign({}, DEFAULTS);
    saveSettings(settings);
    closeSettings();
    showAlertBanner('Settings reset to defaults');
  });

  // -------------------------
  // Chat demo (client-only unless server handles 'chat')
  // -------------------------
  $('chatSend').addEventListener('click', () => {
    const msg = $('chatInput').value.trim();
    if(!msg) return;
    addChatMessage('You', msg);
    // emit to server if you add chat handling server-side
    try { socket.emit('chat', { text: msg, ts: Date.now() }); } catch(e){ /* no server handler OK */ }
    $('chatInput').value = '';
  });
  function addChatMessage(who, txt){
    const cb = $('chatBox');
    const el = document.createElement('div');
    el.className = 'mb-2';
    el.innerHTML = `<div class="text-xs text-slate-400">${who}</div><div class="bg-slate-100 dark:bg-slate-800 p-2 rounded text-sm">${txt}</div>`;
    cb.appendChild(el);
    cb.scrollTop = cb.scrollHeight;
  }

  // -------------------------
  // Socket: initialization & telemetry handler
  // -------------------------
  socket.on('connect', () => {
    console.log('connected to server', socket.id);
    socket.emit('request:init');
  });

  socket.on('init', payload => {
    // payload.devices & payload.history (if server sends history)
    console.log('Initial data', payload);
    if(payload.devices){
      for(const k in payload.devices){
        addDeviceToSelect(k);
        devices[k] = payload.devices[k];
      }
      // pick first device
      const devs = Object.keys(payload.devices);
      if(devs.length) selectDevice(devs[0]);
    }
    if(payload.history){
      // optional: load short history into chart
      for(const id in payload.history){
        const arr = payload.history[id].slice(-40);
        arr.forEach(p => {
          fuelHistory.data.labels.push(new Date(p.t).toLocaleTimeString());
          fuelHistory.data.datasets[0].data.push(p.fuel);
        });
      }
      fuelHistory.update();
    }
  });

  socket.on('telemetry:update', (t) => {
    // ensure proper shape
    const tel = {
      deviceId: t.deviceId || 'device-unknown',
      timestamp: t.timestamp || Date.now(),
      fuel_level_pct: Number(t.fuel_level_pct || t.fuel || 0),
      temperature_c: Number(t.temperature_c || t.temp || 0),
      flow_lph: Number(t.flow_lph || t.flow || 0),
      lat: t.lat, lon: t.lon, status: t.status
    };

    // store device
    devices[tel.deviceId] = tel;
    addDeviceToSelect(tel.deviceId);
    // default selected
    const selected = $('deviceSelect').value || tel.deviceId;
    if(!$('deviceSelect').value) selectDevice(tel.deviceId);

    // update charts and metrics only for selected device
    if(tel.deviceId === selected){
      // push charts
      const push = (chart, value) => {
        chart.data.labels.push(new Date(tel.timestamp).toLocaleTimeString());
        chart.data.datasets[0].data.push(value);
        if(chart.data.labels.length > 40){
          chart.data.labels.shift(); chart.data.datasets[0].data.shift();
        }
        chart.update();
      };
      push(fuelChart, tel.fuel_level_pct);
      push(tempChart, tel.temperature_c);
      push(flowChart, tel.flow_lph);

      // also fuel history mini chart
      push(fuelHistory, tel.fuel_level_pct);

      $('fuelValue').innerText = `${tel.fuel_level_pct}%`;
      $('tempValue').innerText = `${tel.temperature_c}°C`;
      $('flowValue').innerText = `${tel.flow_lph} L/h`;
      $('fuelDetails').innerText = `Last update: ${toTime(tel.timestamp)}`;
      $('fuelTime').innerText = toTime(tel.timestamp);

      // badge + alert
      const b = badgeFor('fuel', tel.fuel_level_pct);
      $('fuelBadge').textContent = b.text;
      $('fuelBadge').className = `px-3 py-1 rounded-full ${b.cls}`;

      if(b.text === 'CRITICAL'){
        // show top alert if critical
        showAlertBanner(`CRITICAL: ${tel.deviceId} fuel ${tel.fuel_level_pct}%`);
      }
    }

    // feed & history always show
    appendFeedEntry(tel);
    pushToHistory(tel);
  });

  // device select change
  $('deviceSelect').addEventListener('change', (e) => {
    updateDeviceMeta(e.target.value);
  });

  function updateDeviceMeta(deviceId){
    const d = devices[deviceId];
    if(!d){
      $('deviceMeta').innerText = 'No device selected';
      return;
    }
    $('deviceMeta').innerText = `Last: ${toTime(d.timestamp)} • ${d.lat || '-'}, ${d.lon || '-'}`;
  }

  // feed filter & clear
  $('clearFeed').addEventListener('click', () => { $('liveFeed').innerHTML = ''; });

  $('feedFilter').addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase();
    document.querySelectorAll('#liveFeed > div').forEach(el => {
      el.style.display = el.textContent.toLowerCase().includes(q) ? '' : 'none';
    });
  });

  // theme toggle with persistence
  $('themeToggle').addEventListener('click', () => {
    document.documentElement.classList.toggle('dark');
    localStorage.setItem('theme', document.documentElement.classList.contains('dark') ? 'dark' : 'light');
  });

  // settings open
  // populate settings fields on load
  window.addEventListener('load', () => {
    $('fuelWarn').value = settings.fuelWarn;
    $('fuelCrit').value = settings.fuelCrit;
    $('tempWarn').value = settings.tempWarn;
    $('tempCrit').value = settings.tempCrit;
  });

  // CSV export previously bound
  $('exportCsv').addEventListener('click', exportCsv);

  // close settings when clicking outside
  $('settingsModal').addEventListener('click', (ev) => {
    if(ev.target === $('settingsModal')) closeSettings();
  });

  // small helper functions used above
  function badgeFor(metric, value){
    if(metric === 'fuel'){
      if(value <= settings.fuelCrit) return { text: 'CRITICAL', cls: 'badge-crit' };
      if(value <= settings.fuelWarn) return { text: 'LOW', cls: 'badge-warn' };
      return { text: 'OK', cls: 'badge-ok' };
    }
    if(metric === 'temp'){
      if(value >= settings.tempCrit) return { text: 'CRITICAL', cls: 'badge-crit' };
      if(value >= settings.tempWarn) return { text: 'HIGH', cls: 'badge-warn' };
      return { text: 'OK', cls: 'badge-ok' };
    }
    if(metric === 'flow'){
      if(value <= 5) return { text: 'CRITICAL', cls: 'badge-crit' };
      if(value <= 15) return { text: 'LOW', cls: 'badge-warn' };
      return { text: 'OK', cls: 'badge-ok' };
    }
    return { text: '--', cls: 'badge-ok' };
  }

  // CSV function (redeclared here because it's used in closures)
  function exportCsv(){
    if(history.length === 0){ alert('No history to export'); return; }
    const hdr = ['timestamp,deviceId,fuel_level_pct,temperature_c,flow_lph,lat,lon,status'];
    const rows = history.map(h => `${new Date(h.timestamp).toISOString()},${h.deviceId},${h.fuel_level_pct},${h.temperature_c},${h.flow_lph},${h.lat||''},${h.lon||''},${h.status||''}`);
    const csv = hdr.concat(rows).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `diesel-history-${Date.now()}.csv`; document.body.appendChild(a); a.click(); a.remove();
  }

})();
