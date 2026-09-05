# DS5Dongle Flasher

Monorepo for the DS5Dongle flasher project.

This repo contains two clients for the same flashing flow:

- `.` — Docker/web client for NAS or server deployment
- `desktop/` — Windows desktop client packaged with Electron

## Web / Docker client

See `README.md` and `docker-compose.example.yml`.

## Desktop client

See `desktop/README.md`.

Desktop release tags use the `desktop-v*.*.*` namespace so they do not trigger the Docker image workflow.

## Common backend logic

Release fetching, package prep, and file routing are shared through the same GitHub helper logic, with the client shell changing between web and desktop.
