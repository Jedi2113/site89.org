(function () {
  const installBtn = document.getElementById('installBtn');
  const playBtn = document.getElementById('playBtn');
  const openFolderBtn = document.getElementById('openFolderBtn');
  const statusEl = document.getElementById('status');
  const installRootEl = document.getElementById('installRoot');
  const modpackUrlEl = document.getElementById('modpackUrl');
  const progressPhaseEl = document.getElementById('progressPhase');
  const progressPercentEl = document.getElementById('progressPercent');
  const progressFillEl = document.getElementById('progressFill');
  const progressDetailEl = document.getElementById('progressDetail');
  const progressTrackEl = document.getElementById('progressTrack');

  function setStatus(message) {
    statusEl.textContent = message;
  }

  function setBusy(isBusy) {
    installBtn.disabled = isBusy;
    playBtn.disabled = isBusy;
  }

  function formatPhase(phase) {
    if (!phase) {
      return 'Idle';
    }

    switch (phase) {
      case 'prepare':
        return 'Preparing';
      case 'download':
        return 'Downloading';
      case 'extract':
        return 'Extracting';
      case 'complete':
        return 'Complete';
      case 'error':
        return 'Error';
      default:
        return 'Idle';
    }
  }

  function setProgress(progress) {
    const percent = Number.isFinite(progress?.percent) ? Math.max(0, Math.min(100, progress.percent)) : 0;
    const phase = formatPhase(progress?.phase);
    const detail = progress?.detail || 'Waiting for action...';

    progressPhaseEl.textContent = phase;
    progressPercentEl.textContent = `${percent}%`;
    progressFillEl.style.width = `${percent}%`;
    progressDetailEl.textContent = detail;
    progressTrackEl.setAttribute('aria-valuenow', String(percent));
  }

  async function bootstrap() {
    const meta = await window.site89Launcher.getMeta();
    installRootEl.textContent = meta.installRoot;
    modpackUrlEl.textContent = meta.modpackUrl;
    setStatus(meta.status || 'Ready');
    setProgress(meta.progress || { phase: 'idle', percent: 0, detail: 'Waiting for action...' });
  }

  installBtn.addEventListener('click', async () => {
    setBusy(true);
    setStatus('Starting install/update...');
    const result = await window.site89Launcher.install();
    setStatus(result.message);
    setBusy(false);
  });

  playBtn.addEventListener('click', async () => {
    setStatus('Launching...');
    const result = await window.site89Launcher.play();
    setStatus(result.message);
  });

  openFolderBtn.addEventListener('click', async () => {
    await window.site89Launcher.openFolder();
  });

  const unsubscribe = window.site89Launcher.onStatus((message) => {
    setStatus(message);
  });

  const unsubscribeProgress = window.site89Launcher.onProgress((payload) => {
    setProgress(payload);
  });

  window.addEventListener('beforeunload', () => {
    if (typeof unsubscribe === 'function') {
      unsubscribe();
    }

    if (typeof unsubscribeProgress === 'function') {
      unsubscribeProgress();
    }
  });

  bootstrap();
})();