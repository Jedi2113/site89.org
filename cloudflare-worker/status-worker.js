// Cloudflare Worker for Site-89 service status
// Deploy with: wrangler publish status-worker.js --name status

const SERVICES = [
  { id: 'mc', name: 'Minecraft Server', type: 'minecraft', target: 'play.site89.org' },
  { id: 'site', name: 'Site-89 Website', type: 'http', target: 'https://site89.org' },
  { id: 'msa', name: 'Microsoft Auth', type: 'http', target: 'https://login.microsoftonline.com' }
];

const TIMEOUT_MS = 2500;

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== '/status') {
      return new Response('Not found', { status: 404 });
    }

    const checks = await Promise.all(SERVICES.map(async svc => {
      try {
        if (svc.type === 'minecraft') {
          const start = Date.now();
          const r = await withTimeout(fetch(`https://api.mcsrvstat.us/2/${svc.target}`), TIMEOUT_MS);
          const ms = Date.now() - start;
          
          // Try parsing JSON, but handle cases where API returns plain text
          let data;
          try {
            data = await r.json();
          } catch {
            // Not JSON - API might be rate limiting or returning error page
            return { id: svc.id, name: svc.name, state: 'offline', ms: null, error: 'Invalid API response' };
          }
          
          // Consider online if the API returns data with online=true or has IP
          const ok = data && (data.online === true || data.ip);
          return { id: svc.id, name: svc.name, state: ok ? 'online' : 'offline', ms, players: data?.players?.online, version: data?.version };
        }
        const start = Date.now();
        // For HTTP services, just check if we get ANY response (even redirects)
        // Many sites block Worker requests, so we're lenient
        const res = await withTimeout(fetch(svc.target, { 
          method: 'GET',
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
          redirect: 'follow'
        }), TIMEOUT_MS);
        const ms = Date.now() - start;
        // Consider it online if we got a response (even 4xx/5xx means the server is up)
        // Only mark offline on network failures
        const ok = res.status > 0; // Any status code means server responded
        return { id: svc.id, name: svc.name, state: ok ? 'online' : 'offline', ms, status: res.status };
      } catch (err) {
        // Only network errors reach here (timeout, DNS failure, etc)
        return { id: svc.id, name: svc.name, state: 'offline', ms: null, error: err.message };
      }
    }));

    const body = JSON.stringify({ services: checks, checkedAt: Date.now() });
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'access-control-allow-origin': '*'
      }
    });
  }
};

async function withTimeout(promise, ms) {
  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms));
  return Promise.race([promise, timeout]);
}
