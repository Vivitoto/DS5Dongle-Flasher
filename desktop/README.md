# DS5Dongle Flasher Desktop

Independent Electron desktop scaffold for the DS5Dongle flasher flow.

## What this project is

- Electron `BrowserWindow` shell
- Local Express helper server started from Electron
- Release fetch and package-prep logic reused from the web app
- Local app data storage under the user profile
- Desktop-first UI for release selection and package prep
- Windows portable EXE packaging target for one-file distribution
- GitHub Release asset publishing for the portable EXE

## Layout

- `electron/main.js` Electron bootstrap
- `server.js` Express API and static asset server
- `src/github.js` GitHub release, cache, and package logic
- `public/index.html` desktop UI
- `test/github.test.js` Node test coverage for release and manifest helpers

## Run

```bash
npm install
npm test
npm run desktop
```

## Build a Windows EXE

```bash
npm run dist:win
```

Output lands in `dist-electron/` as a portable EXE named like `DS5Dongle-Flasher-v0.1.0-portable.exe`.

## Publish to GitHub Release

- Tag a release as `desktop-v0.1.2`
- Build on Windows CI
- Upload the portable EXE to the GitHub Release assets
- Keep the asset name as `DS5Dongle-Flasher-v0.1.2-portable.exe`
- Keep the SHA256 alongside it as `SHA256SUMS.txt`

## Release checklist

- Bump only the desktop app version in this repo
- Do **not** touch Docker image versions or Docker release flow
- Run `npm test`
- Build the portable EXE on Windows
- Verify the release asset name and checksum
- Publish the GitHub Release

## Notes

- The scaffold is runnable on the current platform as a source project.
- Windows EXE packaging is configured as a portable target so users can grab one EXE.
- Data is stored in the app userData directory, not under the Docker project.
- This desktop repo is versioned independently from the Docker project.
