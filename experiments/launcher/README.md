# Site-89 Launcher (Prototype)

This is a Windows desktop launcher prototype built with Electron.

## Features

- Install/update modpack zip from the current Site-89 URL
- Extract modpack into `Documents\\Site-89\\modpack`
- Auto-creates `Start-Site89.bat` if missing (non-Technic flow)
- Play button launches `Start-Site89.bat`
- Registers `site89://` protocol links
- Sets app to launch at Windows login

## Run locally

1. Open terminal in this folder:

   ```bash
   cd experiments/launcher
   ```

2. Install dependencies:

   ```bash
   npm install
   ```

3. Start launcher:

   ```bash
   npm start
   ```

## Build installer

```bash
npm run build
```

This creates a Windows NSIS installer in `dist/`.

## Website integration

From your website, buttons can call:

- `site89://install?pack=main`
- `site89://play?pack=main`

If the launcher is installed, those links open this app and run the action.