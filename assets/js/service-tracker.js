/* Service Tracker: checks core services and updates UI */

const services = [
  {
    id: 'mc',
    name: 'Minecraft Server',
    description: 'play.site89.org',
    icon: 'fa-solid fa-cube',
    type: 'minecraft',
    target: 'play.site89.org'
  },
  {
    id: 'site',
    name: 'Site-89 Website',
    description: 'site89.org',
    icon: 'fa-solid fa-globe',
    type: 'http',
    target: 'https://site89.org'
  },
  {
    id: 'msa',
    name: 'Microsoft Auth',
    description: 'login.microsoftonline.com',
    icon: 'fa-solid fa-shield-halved',
    type: 'http',
    target: 'https://login.microsoftonline.com'
  }
];

// Optional Cloudflare Worker endpoint for faster, server-side checks
const WORKER_ENDPOINT = 'https://status.jedi21132.workers.dev/status'; // replace with your deployed worker URL

const gridEl = document.getElementById('services-grid');
const alertEl = document.getElementById('major-alert');
const alertText = document.getElementById('alert-text');
const lastCheckedEl = document.getElementById('last-checked');

function renderCards(){
  gridEl.innerHTML = services.map(s => `
    <div class="service-card" id="card-${s.id}">
      <div class="service-header">
        <div class="service-icon checking" id="icon-${s.id}"><i class="${s.icon}"></i></div>
        <div class="service-title">
          <h3>${s.name}</h3>
          <span>${s.description}</span>
        </div>
      </div>
      <div class="status-chip checking" id="chip-${s.id}">Checking</div>
      <div class="detail-row">
        <span>Status</span>
        <span class="latency" id="state-${s.id}">—</span>
      </div>
      <div class="detail-row">
        <span>Latency</span>
        <span class="latency" id="latency-${s.id}">—</span>
      </div>
    </div>
  `).join('');
}

function setState(id, state, latencyText){
  const icon = document.getElementById(`icon-${id}`);
  const chip = document.getElementById(`chip-${id}`);
  const stateEl = document.getElementById(`state-${id}`);
  const latEl = document.getElementById(`latency-${id}`);

  const classes = ['online','offline','degraded','checking'];
  classes.forEach(cls => {
    icon.classList.remove(cls);
    chip.classList.remove(cls);
  });
  icon.classList.add(state);
  chip.classList.add(state);

  chip.textContent = stateLabel(state);
  stateEl.textContent = stateLabel(state);
  latEl.textContent = latencyText || '—';
}

function stateLabel(state){
  if(state === 'online') return 'Online';
  if(state === 'degraded') return 'Degraded';
  if(state === 'offline') return 'Offline';
  return 'Checking';
}

async function checkHttp(target){
  const start = performance.now();
  const proxy = 'https://api.allorigins.win/raw?url=' + encodeURIComponent(target);
  const res = await fetch(proxy, { method: 'GET', cache: 'no-store' });
  const ms = Math.round(performance.now() - start);
  return { ok: res.ok, ms };
}

async function checkMinecraft(host){
  const start = performance.now();
  const url = `https://api.mcsrvstat.us/2/${host}`;
  const res = await fetch(url, { cache: 'no-store' });
  const data = await res.json();
  const ms = Math.round(performance.now() - start);
  const ok = !!data && data.online === true;
  return { ok, ms, players: data?.players?.online, version: data?.version };
}

async function runChecks(){
  renderCards();
  const downList = [];

  // Prefer worker endpoint if configured
  if (WORKER_ENDPOINT && WORKER_ENDPOINT.startsWith('http')) {
    try {
      const res = await fetch(WORKER_ENDPOINT, { cache: 'no-store' });
      if (!res.ok) throw new Error('Worker error');
      const json = await res.json();
      const results = json.services || [];

      // Use worker results for everything except Minecraft
      results.forEach(r => {
        if (r.id === 'mc') return;
        const latencyText = r.ms != null ? `${r.ms} ms` : '—';
        setState(r.id, r.state || 'offline', latencyText);
        if (r.state !== 'online') downList.push(r.name || r.id);
      });

      // Always check Minecraft directly via mcsrvstat.us for speed/reliability
      await checkMinecraftDirect(downList);
    } catch (err) {
      // Fallback to client-side checks if worker fails
      await clientChecks(downList);
    }
  } else {
    await clientChecks(downList);
  }

  if(downList.length > 0){
    alertEl.classList.add('visible');
    alertText.textContent = downList.join(', ') + ' unreachable.';
  } else {
    alertEl.classList.remove('visible');
    alertText.textContent = '';
  }

  const now = new Date();
  if(lastCheckedEl) lastCheckedEl.textContent = `Last checked: ${now.toLocaleTimeString()}`;
}

async function clientChecks(downList){
  await Promise.all(services.map(async svc => {
    setState(svc.id, 'checking', '—');
    try {
      if(svc.type === 'minecraft'){
        const r = await checkMinecraft(svc.target);
        if(r.ok){
          setState(svc.id, 'online', `${r.ms} ms${r.players !== undefined ? ` • ${r.players} players` : ''}`);
        } else {
          setState(svc.id, 'offline', 'No response');
          downList.push(svc.name);
        }
      } else {
        const r = await checkHttp(svc.target);
        if(r.ok){
          setState(svc.id, 'online', `${r.ms} ms`);
        } else {
          setState(svc.id, 'offline', 'No response');
          downList.push(svc.name);
        }
      }
    } catch (err){
      setState(svc.id, 'offline', 'Error');
      downList.push(svc.name);
    }
  }));
}

async function checkMinecraftDirect(downList) {
  const mcService = services.find(s => s.id === 'mc');
  if (!mcService) return;

  setState(mcService.id, 'checking', '—');
  try {
    const r = await checkMinecraft(mcService.target);
    if (r.ok) {
      setState(mcService.id, 'online', `${r.ms} ms${r.players !== undefined ? ` • ${r.players} players` : ''}`);
    } else {
      setState(mcService.id, 'offline', 'No response');
      downList.push(mcService.name);
    }
  } catch (err) {
    setState(mcService.id, 'offline', 'Error');
    downList.push(mcService.name);
  }
}

function init(){
  renderCards();
  runChecks();
  setInterval(runChecks, 60000);
}

document.addEventListener('DOMContentLoaded', init);
