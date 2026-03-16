(function () {
  const MODPACK_URL = 'https://dl.dropboxusercontent.com/scl/fi/udp1fzetpfcr6xbnieumu/site-89_v1.8.2.zip?rlkey=8x6c8dalukydytdqgy95wlt6g&st=yza6gxaz';
  const PROTOCOL_INSTALL_URL = 'site89://install?pack=main';
  const PROTOCOL_PLAY_URL = 'site89://play?pack=main';

  function getElement(id) {
    return document.getElementById(id);
  }

  function setStatus(message) {
    const status = getElement('launcherStatus');
    if (status) {
      status.textContent = message;
    }
  }

  function triggerDownload(url) {
    const link = document.createElement('a');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  function attemptProtocolLaunch(protocolUrl, fallbackMessage) {
    const startedAt = Date.now();
    const fallbackTimeoutMs = 1800;

    const iframe = document.createElement('iframe');
    iframe.style.display = 'none';
    iframe.src = protocolUrl;
    document.body.appendChild(iframe);

    setTimeout(() => {
      const elapsed = Date.now() - startedAt;
      if (elapsed >= fallbackTimeoutMs - 100) {
        setStatus(fallbackMessage);
      }

      if (document.body.contains(iframe)) {
        document.body.removeChild(iframe);
      }
    }, fallbackTimeoutMs);
  }

  function handleInstall() {
    setStatus('Opening installer flow: attempting launcher protocol, then downloading ZIP fallback.');

    attemptProtocolLaunch(
      PROTOCOL_INSTALL_URL,
      'Launcher protocol not detected. Downloading modpack ZIP instead.'
    );

    setTimeout(() => {
      triggerDownload(MODPACK_URL);
    }, 500);
  }

  function handlePlay() {
    setStatus('Attempting to launch Site-89 via local launcher protocol...');

    attemptProtocolLaunch(
      PROTOCOL_PLAY_URL,
      'Could not contact local launcher. Install/update first or install the future desktop launcher.'
    );
  }

  document.addEventListener('DOMContentLoaded', () => {
    const installButton = getElement('installModpackBtn');
    const playButton = getElement('playNowBtn');
    const urlLabel = getElement('modpackUrl');

    if (urlLabel) {
      urlLabel.textContent = MODPACK_URL;
    }

    if (installButton) {
      installButton.addEventListener('click', handleInstall);
    }

    if (playButton) {
      playButton.addEventListener('click', handlePlay);
    }
  });
})();