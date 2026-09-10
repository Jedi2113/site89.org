# Site-89 Website

Official web platform for the Site-89 SCP roleplay community.

## Overview

This repository contains a Firebase-hosted static site with client-side modules and Firebase Cloud Functions for platform services.

Core areas include:
- Personnel and character management
- Archive systems (anomalies, research logs, incident reports)
- Community features (forum, events, articles, gallery, newsletter)
- Internal tooling (analytics, moderation, role and bank management)
- In-character mailbox and notifications

## Stack

- Frontend: HTML, CSS, vanilla JavaScript modules
- Backend services: Firebase Auth, Firestore, Cloud Functions, Firebase Hosting
- Function runtime: Node.js 20 (`/functions`)

## Repository Layout

- `/assets/` - shared JS, CSS, images, and UI utilities
- `/components/` - reusable page components (navbar, footer, etc.)
- `/functions/` - Firebase Cloud Functions (HTTP endpoints, schedulers, triggers)
- Feature directories (examples): `/accounts/`, `/anomalies/`, `/forum/`, `/events/`, `/admin/`
- Security and platform config: `firestore.rules`, `storage.rules`, `firebase.json`

## Cloud Functions

The functions project includes:
- Scheduled jobs (payroll and event reminder automation)
- Firestore triggers (email and banking workflows)
- HTTP endpoints used by Hosting rewrites, including:
  - `/upload` and `/image/**` → `imageApi`
  - `/api/trigger-event-notifications` → `triggerEventNotifications`
  - `/api/merch-products` → `getMerchProducts`

## Local Development

### 1) Serve the website

Use any static file server from the repo root.

Example:
```bash
python3 -m http.server 8080
```

### 2) Install Cloud Functions dependencies

```bash
cd functions
npm install
```

### 3) Firebase setup

This repo is configured for Firebase Hosting + Functions (`firebase.json`, `.firebaserc`).

Common commands:
```bash
firebase emulators:start
firebase deploy --only hosting,functions,firestore:rules,storage:rules
```

## Notes

- Client Firebase config values in frontend code are public by design; data protection is enforced by Firebase Auth and security rules.
- Update `firestore.rules` and `storage.rules` alongside any permission model changes.

## License

© 2024-2026 Site-89 Project. All rights reserved.