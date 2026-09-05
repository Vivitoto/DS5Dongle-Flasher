# DS5Dongle Flasher

Minimal Dockerized web app for browsing GitHub releases, preparing a flash package, and driving a browser-side Web Serial flow.

## Run

```bash
docker compose -f docker-compose.example.yml up --build
```

Open `http://localhost:3000` in a Chromium-based browser. Web Serial needs a secure context, and `localhost` is treated as secure.

If you want to expose it through a reverse proxy, keep the container on port 3000 and map any host port you like in compose, for example `8888:3000`.
For the published image, the example compose points to `vivitoto/ds5dongle-flasher:0.1.0`.

## What it does

- Fetches GitHub releases for a configurable repo
- Shows accordion release cards with version and publish date
- Lets you switch between `STD` and `HS` firmware variants
- Downloads the release zip asset, extracts it, and exposes the files through the app
- Connects to a device over Web Serial and streams logs
- Keeps the flash sequence stubbed, but wires progress and log updates end to end

## Environment

The app reads configuration from Docker/compose environment variables:

- `GITHUB_REPO` default: `sqlCRT/ds5dongle-bl618-opensource`
- You can also split it with `GITHUB_OWNER` + `GITHUB_REPO`
- `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` forwarded to GitHub requests when set
- `GITHUB_TOKEN` optional, useful for higher GitHub API limits; set it only if you want more reliable release fetching

## Local development

```bash
npm install
npm test
npm start
```

## Repo layout

- `server.js` Express backend
- `src/github.js` GitHub API, proxy, cache, and package prep logic
- `public/` frontend assets
- `test/release.test.js` release and manifest tests

