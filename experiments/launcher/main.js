const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { spawn } = require('child_process');
const AdmZip = require('adm-zip');

const MODPACK_URL = 'https://dl.dropboxusercontent.com/scl/fi/udp1fzetpfcr6xbnieumu/site-89_v1.8.2.zip?rlkey=8x6c8dalukydytdqgy95wlt6g&st=yza6gxaz';
const APP_PROTOCOL = 'site89';

const state = {
  status: 'Ready',
  progress: {
    phase: 'idle',
    percent: 0,
    detail: 'Idle'
  },
  isInstalling: false,
  mainWindow: null
};

let pendingProtocolAction = null;

function getInstallRoot() {
  return path.join(app.getPath('documents'), 'Site-89');
}

function getModpackDir() {
  return path.join(getInstallRoot(), 'modpack');
}

function getTempZipPath() {
  return path.join(app.getPath('temp'), 'site-89_modpack.zip');
}

function setStatus(message) {
  state.status = message;
  if (state.mainWindow && !state.mainWindow.isDestroyed()) {
    state.mainWindow.webContents.send('launcher:status', message);
  }
}

function setProgress(phase, percent, detail) {
  const normalizedPercent = Math.max(0, Math.min(100, Math.round(percent)));
  state.progress = {
    phase,
    percent: normalizedPercent,
    detail
  };

  if (state.mainWindow && !state.mainWindow.isDestroyed()) {
    state.mainWindow.webContents.send('launcher:progress', state.progress);
  }
}

function ensureDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function downloadFile(url, destination, onProgress, redirectsLeft = 6) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destination);

    const request = https.get(url, (response) => {
      const statusCode = response.statusCode || 0;

      if (statusCode >= 300 && statusCode < 400 && response.headers.location) {
        file.close();
        fs.rmSync(destination, { force: true });

        if (redirectsLeft <= 0) {
          reject(new Error('Too many redirects while downloading modpack.'));
          return;
        }

        const nextUrl = response.headers.location.startsWith('http')
          ? response.headers.location
          : new URL(response.headers.location, url).toString();

        resolve(downloadFile(nextUrl, destination, onProgress, redirectsLeft - 1));
        return;
      }

      if (statusCode < 200 || statusCode >= 300) {
        file.close();
        fs.rmSync(destination, { force: true });
        reject(new Error(`Download failed with HTTP ${statusCode}.`));
        return;
      }

      const totalBytes = Number.parseInt(response.headers['content-length'] || '0', 10);
      let downloadedBytes = 0;

      response.on('data', (chunk) => {
        downloadedBytes += chunk.length;
        if (typeof onProgress === 'function' && totalBytes > 0) {
          onProgress(downloadedBytes, totalBytes);
        }
      });

      response.pipe(file);

      file.on('finish', () => {
        file.close();
        resolve(destination);
      });
    });

    request.on('error', (error) => {
      file.close();
      fs.rmSync(destination, { force: true });
      reject(error);
    });

    file.on('error', (error) => {
      file.close();
      fs.rmSync(destination, { force: true });
      reject(error);
    });
  });
}

function clearDirectory(dirPath) {
  if (fs.existsSync(dirPath)) {
    fs.rmSync(dirPath, { recursive: true, force: true });
  }
  fs.mkdirSync(dirPath, { recursive: true });
}

function getDefaultStartScriptContent() {
  return [
    '@echo off',
    'setlocal',
    'title Site-89 Launch',
    '',
    'set "PACK_DIR=%~dp0"',
    'if "%PACK_DIR:~-1%"=="\\" set "PACK_DIR=%PACK_DIR:~0,-1%"',
    'set "MC_DIR=%APPDATA%\\.minecraft"',
    'set "FORGE_VERSION=1.12.2-forge-14.23.5.2859"',
    'set "FORGE_JSON=%MC_DIR%\\versions\\%FORGE_VERSION%\\%FORGE_VERSION%.json"',
    '',
    'where java >nul 2>&1',
    'if errorlevel 1 (',
    '  echo Java was not found. Install Java 8 or newer and try again.',
    '  pause',
    '  exit /b 1',
    ')',
    '',
    'if not exist "%FORGE_JSON%" (',
    '  echo Installing Forge profile for %FORGE_VERSION%...',
    '  java -jar "%PACK_DIR%\\bin\\modpack.jar" --installClient "%MC_DIR%"',
    '  if errorlevel 1 (',
    '    echo Forge install failed.',
    '    pause',
    '    exit /b 1',
    '  )',
    ')',
    '',
    'if exist "%PACK_DIR%\\mods" robocopy "%PACK_DIR%\\mods" "%MC_DIR%\\mods" /E >nul',
    'if exist "%PACK_DIR%\\config" robocopy "%PACK_DIR%\\config" "%MC_DIR%\\config" /E >nul',
    'if exist "%PACK_DIR%\\resourcepacks" robocopy "%PACK_DIR%\\resourcepacks" "%MC_DIR%\\resourcepacks" /E >nul',
    'if exist "%PACK_DIR%\\shaderpacks" robocopy "%PACK_DIR%\\shaderpacks" "%MC_DIR%\\shaderpacks" /E >nul',
    '',
    'set "MC_LAUNCHER=%ProgramFiles(x86)%\\Minecraft Launcher\\MinecraftLauncher.exe"',
    'if exist "%MC_LAUNCHER%" (',
    '  start "" "%MC_LAUNCHER%"',
    '  exit /b 0',
    ')',
    '',
    'set "MC_LAUNCHER=%ProgramFiles%\\Minecraft Launcher\\MinecraftLauncher.exe"',
    'if exist "%MC_LAUNCHER%" (',
    '  start "" "%MC_LAUNCHER%"',
    '  exit /b 0',
    ')',
    '',
    'start "" "minecraft://"',
    'exit /b 0',
    ''
  ].join('\r\n');
}

function ensureStartScript(modpackDir) {
  const startScriptPath = path.join(modpackDir, 'Start-Site89.bat');
  if (fs.existsSync(startScriptPath)) {
    return;
  }

  fs.writeFileSync(startScriptPath, getDefaultStartScriptContent(), 'utf8');
}

async function installOrUpdateModpack() {
  if (state.isInstalling) {
    return { ok: false, message: 'Install already in progress.' };
  }

  state.isInstalling = true;

  try {
    setStatus('Preparing directories...');
    setProgress('prepare', 2, 'Preparing directories');
    ensureDirectory(getInstallRoot());

    setStatus('Downloading modpack package...');
    setProgress('download', 5, 'Downloading modpack package');
    const zipPath = getTempZipPath();
    await downloadFile(MODPACK_URL, zipPath, (downloaded, total) => {
      const phasePercent = Math.round((downloaded / total) * 78);
      const overallPercent = 5 + phasePercent;
      setProgress('download', overallPercent, `Downloading ${Math.round((downloaded / total) * 100)}%`);
    });

    setProgress('download', 83, 'Download complete');

    setStatus('Extracting modpack files...');
    setProgress('extract', 85, 'Extracting modpack files');
    const modpackDir = getModpackDir();
    clearDirectory(modpackDir);
    const zip = new AdmZip(zipPath);
    const entries = zip.getEntries();
    if (entries.length === 0) {
      zip.extractAllTo(modpackDir, true);
      setProgress('extract', 98, 'Extracted files');
    } else {
      entries.forEach((entry, index) => {
        zip.extractEntryTo(entry, modpackDir, true, true);
        const step = Math.round(((index + 1) / entries.length) * 13);
        const overall = 85 + step;
        setProgress('extract', overall, `Extracting files ${index + 1}/${entries.length}`);
      });
    }

    fs.rmSync(zipPath, { force: true });
    ensureStartScript(modpackDir);

    const completed = `Install/update complete. Files are in ${modpackDir}`;
    setStatus(completed);
    setProgress('complete', 100, 'Install complete');
    return { ok: true, message: completed, modpackDir };
  } catch (error) {
    const message = `Install failed: ${error.message}`;
    setStatus(message);
    setProgress('error', 0, 'Install failed');
    return { ok: false, message };
  } finally {
    state.isInstalling = false;
  }
}

function resolvePlayTarget() {
  const modpackDir = getModpackDir();
  const preferredStartScript = path.join(modpackDir, 'Start-Site89.bat');

  if (fs.existsSync(preferredStartScript)) {
    return {
      command: 'cmd.exe',
      args: ['/c', preferredStartScript],
      cwd: modpackDir,
      description: 'Start-Site89.bat'
    };
  }

  return null;
}

async function play() {
  const target = resolvePlayTarget();

  if (!target) {
    const message = 'No launch target found. Install/update the modpack first so Start-Site89.bat exists.';
    setStatus(message);
    return { ok: false, message };
  }

  try {
    spawn(target.command, target.args, {
      cwd: target.cwd,
      detached: true,
      stdio: 'ignore'
    }).unref();

    const message = `Launching ${target.description}...`;
    setStatus(message);
    return { ok: true, message };
  } catch (error) {
    const message = `Launch failed: ${error.message}`;
    setStatus(message);
    return { ok: false, message };
  }
}

function createWindow() {
  state.mainWindow = new BrowserWindow({
    width: 980,
    height: 680,
    minWidth: 860,
    minHeight: 560,
    title: 'Site-89 Launcher',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  state.mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  state.mainWindow.on('closed', () => {
    state.mainWindow = null;
  });
}

function parseProtocolAction(raw) {
  if (!raw || !raw.startsWith(`${APP_PROTOCOL}://`)) {
    return null;
  }

  try {
    const url = new URL(raw);
    const action = (url.hostname || '').toLowerCase();
    if (action === 'install' || action === 'play') {
      return action;
    }
    return null;
  } catch {
    return null;
  }
}

async function handleProtocolAction(action) {
  if (action === 'install') {
    await installOrUpdateModpack();
    return;
  }

  if (action === 'play') {
    await play();
  }
}

function registerProtocol() {
  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(APP_PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
    return;
  }

  app.setAsDefaultProtocolClient(APP_PROTOCOL);
}

const singleLock = app.requestSingleInstanceLock();
if (!singleLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const protocolArg = argv.find((arg) => typeof arg === 'string' && arg.startsWith(`${APP_PROTOCOL}://`));
    const action = parseProtocolAction(protocolArg);

    if (state.mainWindow) {
      if (state.mainWindow.isMinimized()) {
        state.mainWindow.restore();
      }
      state.mainWindow.focus();
    }

    if (action) {
      handleProtocolAction(action);
    }
  });

  app.whenReady().then(async () => {
    registerProtocol();

    app.setLoginItemSettings({
      openAtLogin: true,
      path: process.execPath
    });

    createWindow();

    const startupProtocolArg = process.argv.find((arg) => typeof arg === 'string' && arg.startsWith(`${APP_PROTOCOL}://`));
    pendingProtocolAction = parseProtocolAction(startupProtocolArg);

    if (pendingProtocolAction) {
      await handleProtocolAction(pendingProtocolAction);
      pendingProtocolAction = null;
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });
}

ipcMain.handle('launcher:get-meta', async () => {
  return {
    modpackUrl: MODPACK_URL,
    installRoot: getInstallRoot(),
    status: state.status,
    progress: state.progress
  };
});

ipcMain.handle('launcher:install', async () => installOrUpdateModpack());
ipcMain.handle('launcher:play', async () => play());
ipcMain.handle('launcher:open-folder', async () => {
  await shell.openPath(getModpackDir());
  return { ok: true };
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});