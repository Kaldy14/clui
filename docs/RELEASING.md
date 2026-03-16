# Releasing Clui

## Overview

Releases are built and published via the **Release Desktop** GitHub Actions workflow (`.github/workflows/release.yml`). The workflow builds signed desktop artifacts for macOS (arm64 + x64), Linux (x64), and Windows (x64), publishes the CLI to npm, creates a GitHub Release with all assets, and bumps version strings on `main`.

## Prerequisites

### GitHub Secrets (CI)

| Secret | Purpose |
|--------|---------|
| `CSC_LINK` | Base64-encoded macOS signing certificate (.p12) |
| `CSC_KEY_PASSWORD` | Password for the .p12 certificate |
| `APPLE_API_KEY` | Apple notarization API key (.p8 contents) |
| `APPLE_API_KEY_ID` | Apple API key ID |
| `APPLE_API_ISSUER` | Apple API issuer UUID |
| `AZURE_TENANT_ID` | Azure AD tenant for Windows signing |
| `AZURE_CLIENT_ID` | Azure AD app client ID |
| `AZURE_CLIENT_SECRET` | Azure AD app client secret |
| `AZURE_TRUSTED_SIGNING_ENDPOINT` | Azure Trusted Signing endpoint URL |
| `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME` | Azure signing account name |
| `AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME` | Azure cert profile name |
| `AZURE_TRUSTED_SIGNING_PUBLISHER_NAME` | Azure publisher name |

Signing is optional per-platform — if secrets are missing, the build proceeds unsigned (auto-update won't work on macOS without signing).

### Environment Variables (build script)

| Variable | Purpose |
|----------|---------|
| `GITHUB_REPOSITORY` | `owner/repo` — used to generate `app-update.yml` for electron-updater. Automatically set in CI. |
| `CLUI_DESKTOP_UPDATE_REPOSITORY` | Override for `GITHUB_REPOSITORY` if the update feed comes from a different repo. |

## Release Steps

### 1. Ensure `main` is ready

All changes for the release should be merged to `main`. CI should be green.

### 2. Bump version (if not already at target)

The current version is in `apps/desktop/package.json`. The finalize step auto-bumps after release, but if you need to set a specific version before tagging:

```bash
node scripts/update-release-package-versions.ts 1.2.3
bunx oxfmt apps/server/package.json apps/desktop/package.json apps/web/package.json packages/contracts/package.json
bun install --lockfile-only --ignore-scripts
```

This updates version in: `apps/server/package.json`, `apps/desktop/package.json`, `apps/web/package.json`, `packages/contracts/package.json`.

### 3. Create and push the tag

```bash
git tag v1.2.3
git push origin v1.2.3
```

This triggers the release workflow automatically.

### 4. Alternatively: manual dispatch

Go to **Actions > Release Desktop > Run workflow** and enter the version (e.g. `1.2.3` or `v1.2.3`).

### 5. Monitor the workflow

The workflow runs these jobs in order:

1. **Preflight** — validates version, runs lint/typecheck/test
2. **Build** (matrix: 4 targets) — builds desktop artifacts with signing when secrets are available
3. **Publish CLI** — publishes `@clui/server` to npm
4. **Release** — merges macOS updater manifests (arm64 + x64), creates GitHub Release with all assets
5. **Finalize** — bumps version strings in package.json files and commits to `main`

### 6. Verify the release

After the workflow completes:

- Check the [GitHub Releases page](https://github.com/Kaldy14/clui/releases) for the new release
- Verify assets are attached: `.dmg` (2x), `.zip` (2x), `.AppImage`, `.exe`, `.blockmap` files, and `latest-mac.yml`, `latest-linux.yml`, `latest.yml`
- Existing users with auto-update enabled will see an update notification in the sidebar

## How Auto-Update Works

1. electron-builder generates `app-update.yml` at build time (baked into the app's `resources/` directory) with `provider: github` and the repo coordinates
2. At startup (after a short delay) and periodically, the app checks the GitHub Release for `latest-mac.yml` / `latest-linux.yml` / `latest.yml`
3. If a newer version is found, the sidebar shows an update banner
4. The user clicks **Download** to fetch the update, then **Restart & Install** to apply it
5. No GitHub token is needed at runtime for public repos — the updater reads the public Releases API

## Build Artifacts

The build script (`scripts/build-desktop-artifact.ts`) stages a flat directory with the bundled server + desktop code, generates a `package.json` with inline electron-builder config, and runs `bunx electron-builder`. Key details:

- macOS: produces `.dmg` + `.zip` (zip is required for auto-update)
- Linux: produces `.AppImage`
- Windows: produces `.exe` (NSIS installer)
- Artifacts land in `release/` directory
- `latest*.yml` manifests are generated alongside artifacts
- macOS arm64 and x64 manifests are merged into a single `latest-mac.yml` in the release job

## Prerelease

Tags with a prerelease suffix (e.g. `v1.2.3-beta.1`) are automatically marked as prerelease on GitHub and will not be served to users on the stable update channel (`channel = "latest"`).

## Troubleshooting

- **"macOS signing disabled"** — missing one or more Apple signing secrets. Auto-update will not work for macOS users on unsigned builds.
- **Build fails on `bun install`** — ensure `bun.lock` is committed and up to date.
- **Finalize fails to push** — branch protection on `main` may block the bot push. Ensure `github-actions[bot]` has push permissions.
- **Auto-update not working** — verify the GitHub Release has `latest-mac.yml` (or `latest-linux.yml` / `latest.yml`). The app reads these to discover updates.
