# EMU-webapp-server (VISP)

WebSocket + file server behind the Artic (EMU-webApp) frontend. In the VISP deployment there
is **no dedicated `emu-webapp.*` subdomain**: Apache serves the EMU frontend on
`artic.<BASE_DOMAIN>` and proxies to this server — `ProxyPass /file` plus WebSocket upgrades
to `emu-webapp-server:17890`. The browser therefore talks to `wss://artic.<BASE_DOMAIN>/`.

## Run

- Image: `node:24.15.0-bookworm-slim`, default `CMD npm run dev` (nodemon with `--exitcrash`);
  the prod quadlet overrides the command to `npm start`.
- Build/run through the deployment repo: `./visp.py build emu-webapp-server`.

## Required environment

The server **exits** (non-zero) if any of these is unset; systemd (`Restart=always`)
retries, so a wrong config shows up as a restart loop in the journal, not a silent failure:

| Variable | Meaning |
|:---|:---|
| `MONGO_URI` | MongoDB connection string |
| `MONGO_DB_NAME` | Application database |
| `REPOSITORIES_PATH` | Container path of the project repositories (`/repositories` in the deployment, bind-mounted from the host's `mounts/repositories`) |
| `MEDIA_FILE_BASE_URL` | Public base URL; also seeds the WebSocket origin allowlist |

Optional: `WS_SERVER_PORT` (default `17890`), `ALLOWED_ORIGINS` (comma-separated origins;
foreign origins are rejected with 403 at upgrade), `LOG_LEVEL`. Note that `.env-example`
also lists `MONGO_ROOT_PASSWORD`, which this server never reads — the credential is in
`MONGO_URI`.

Mongo must provide three collections: `projects` (project metadata), `users` (with a
`phpSessionId` field), and `bundlelists`.

## Storage layout

EMU-DB files live in the project repositories on disk, addressed by **project id** (URL
encoded), not username:

```
<REPOSITORIES_PATH>/<projectId>/Data/VISP_emuDB/<session>_ses/<bundle>_bndl/
```

All path construction goes through `src/pathSecurity.js` (traversal-safe); only `.wav`
files are served.

## Endpoints

- `WS /` — the EMU-webApp protocol (`GETPROTOCOL`, `GETBUNDLE`, `SAVEBUNDLE`, …;
  auth-gated, origin-checked, re-authorized per message). Bundle media URLs are returned
  as `mediaFile` entries with `GETURL`-style encoding built from `MEDIA_FILE_BASE_URL`.
- `GET /file/project/:projectId/session/:sessionName/file/:fileName` — audio file download,
  same auth + `.wav`-only rule; this is the route Apache proxies.
- `SAVEBUNDLE` updates **existing** bundles only, and only declared SSFF extensions.

## Authentication

The auth module is **hard-coded to `VispAuth`** (`src/authModules/visp.module.js`); there is
no pluggable-module selection. `VispAuth` validates the `PHPSESSID` against the MongoDB
`users.phpSessionId` field and checks project membership — it does not call the PHP backend.

Re-authentication happens **per WebSocket message and per `/file` request**, on purpose:
logging out or losing project membership takes effect immediately. There is no auth cache.
(`getUser` and the old `authCache` machinery are dead legacy code kept for reference.)
