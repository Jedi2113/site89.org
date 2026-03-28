/**
 * Status Monitoring System
 * Pings various services and displays their status in real-time
 */

class StatusMonitor {
  constructor() {
    this.services = [
      {
        id: 'website',
        name: 'Site-89 Website',
        icon: 'fas fa-globe',
        endpoint: '/',
        lastResponseTime: null,
        isOnline: false,
        uptime: 100
      },
      {
        id: 'minecraft',
        name: 'Minecraft Server',
        icon: 'fas fa-cube',
        endpoint: 'https://api.mcsrvstat.us/2/play.site89.org',
        lastResponseTime: null,
        isOnline: false,
        uptime: 100,
        isExternal: true
      }
    ];

    this.lastUpdateTime = null;
    this.checkInterval = null;
    this.init();
  }

  async init() {
    this.renderServices();
    this.performHealthCheck();
    // Check every 30 seconds
    this.checkInterval = setInterval(() => this.performHealthCheck(), 30000);
  }

  renderServices() {
    const grid = document.getElementById('servicesGrid');
    grid.innerHTML = this.services.map(service => `
      <div class="service-card" id="service-${service.id}">
        <div class="service-header">
          <div class="service-icon checking" id="icon-${service.id}">
            <i class="${service.icon}"></i>
          </div>
          <div class="service-title">
            <h3>${service.name}</h3>
            <div class="service-status checking" id="status-${service.id}">Checking...</div>
          </div>
        </div>
        <div class="service-details">
          <div class="detail-item">
            <span class="detail-label">Response</span>
            <span class="detail-value" id="response-${service.id}">—</span>
          </div>
          <div class="detail-item">
            <span class="detail-label">Uptime</span>
            <span class="detail-value" id="uptime-${service.id}">—</span>
          </div>
          <div class="uptime-bar">
            <div class="uptime-fill" id="uptimebar-${service.id}" style="width: 100%;">
              <span id="uptimetext-${service.id}">100%</span>
            </div>
          </div>
        </div>
      </div>
    `).join('');
  }

  async performHealthCheck() {
    const startTime = Date.now();
    
    for (const service of this.services) {
      await this.checkService(service);
    }

    this.updateLastUpdate();
    this.updateAlert();
  }

  async checkService(service) {
    const startTime = Date.now();
    
    try {
      if (service.id === 'website') {
        // Check website with a simple fetch to root
        const response = await this.fetchWithTimeout(service.endpoint, 5000, { method: 'HEAD' });
        service.lastResponseTime = Date.now() - startTime;
        service.isOnline = response.ok;
      } else if (service.id === 'minecraft') {
        // Check Minecraft server via API
        const response = await this.fetchWithTimeout(service.endpoint, 5000, { method: 'GET' });
        const data = await response.json();
        service.lastResponseTime = Date.now() - startTime;
        service.isOnline = data.online === true;
      }
    } catch (error) {
      service.isOnline = false;
      service.lastResponseTime = null;
    }

    this.updateServiceUI(service);
  }

  fetchWithTimeout(url, timeout = 5000, options = {}) {
    return Promise.race([
      fetch(url, { cache: 'no-store', ...options }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Timeout')), timeout)
      )
    ]);
  }

  updateServiceUI(service) {
    const icon = document.getElementById(`icon-${service.id}`);
    const status = document.getElementById(`status-${service.id}`);
    const response = document.getElementById(`response-${service.id}`);
    const uptime = document.getElementById(`uptime-${service.id}`);
    const uptimebar = document.getElementById(`uptimebar-${service.id}`);
    const uptimetext = document.getElementById(`uptimetext-${service.id}`);

    // Update icon status
    icon.className = `service-icon ${service.isOnline ? 'online' : 'offline'}`;
    icon.innerHTML = `<i class="${service.icon}"></i>`;

    // Update status text
    status.className = `service-status ${service.isOnline ? 'online' : 'offline'}`;
    status.textContent = service.isOnline ? 'Online' : 'Offline';

    // Update response time
    if (service.lastResponseTime !== null) {
      response.textContent = `${service.lastResponseTime}ms`;
    } else {
      response.textContent = '—';
    }

    // Update uptime display
    uptime.textContent = `${service.uptime.toFixed(2)}%`;
    uptimebar.style.width = `${service.uptime}%`;
    uptimetext.textContent = `${service.uptime.toFixed(1)}%`;

    // Update color of uptime bar based on status
    if (service.uptime >= 99) {
      uptimebar.style.background = 'linear-gradient(90deg, var(--accent-mint), var(--accent-teal))';
    } else if (service.uptime >= 95) {
      uptimebar.style.background = 'linear-gradient(90deg, #FFC857, #FFB700)';
    } else {
      uptimebar.style.background = 'linear-gradient(90deg, var(--accent-red), #b00000)';
    }
  }

  updateAlert() {
    const degradedAlert = document.getElementById('degradedAlert');
    const offlineServices = this.services.filter(s => !s.isOnline);

    if (offlineServices.length > 0) {
      degradedAlert.classList.add('visible');
      const message = offlineServices.length === 1
        ? `${offlineServices[0].name} is currently offline.`
        : `${offlineServices.length} services are currently offline.`;
      document.getElementById('alertMessage').textContent = message;
    } else {
      degradedAlert.classList.remove('visible');
    }
  }

  updateLastUpdate() {
    const now = new Date();
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    
    document.getElementById('updateTime').textContent = `${hours}:${minutes}:${seconds}`;
  }

  destroy() {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
    }
  }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  new StatusMonitor();
});
