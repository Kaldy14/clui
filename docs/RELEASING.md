# Releasing Clui

## Overview

The **Release Desktop** GitHub Actions workflow (`.github/workflows/release.yml`) builds and publishes Clui's macOS arm64, Linux x64, and Windows x64 desktop artifacts from a `v*.*.*` tag or manual dispatch. It uses standard GitHub-hosted runners, creates one GitHub Release with updater assets, and finalizes release package versions on `main` when needed. It does not publish a CLI package to npm.

macOS release signing is fail-closed: the arm64 build must be Developer ID signed, notarized, stapled, and verified before upload. All five Apple credentials below are mandatory. Windows Azure Trusted Signing remains optional.

## Prerequisites

### Required macOS GitHub Actions secrets

Add these at **GitHub repository > Settings > Secrets and variables > Actions > Repository secrets**:

| Secret                         | Purpose                                                                                   |
| ------------------------------ | ----------------------------------------------------------------------------------------- |
| `MACOS_CERTIFICATE_P12_BASE64` | Base64-encoded `.p12` containing the Developer ID Application certificate and private key |
| `MACOS_CERTIFICATE_PASSWORD`   | Password used to export the `.p12`                                                        |
| `APPLE_API_KEY_P8_BASE64`      | Base64-encoded App Store Connect Team API `.p8` key                                       |
| `APPLE_API_KEY_ID`             | App Store Connect Team API Key ID                                                         |
| `APPLE_API_ISSUER`             | App Store Connect Team API Issuer ID                                                      |

Every value must be non-empty. Missing values fail credential preflight; invalid values fail certificate import, signing, notarization, stapling, or verification. The workflow never publishes an unsigned macOS release artifact.

Create the credentials as follows:

1. In the Apple Developer portal, create a **Developer ID Application** certificate for the intended team.
2. Export that certificate and its private key from Keychain Access as a password-protected `.p12`.
3. In **App Store Connect > Users and Access > Integrations**, create a **Team API key** with **App Manager** access. Download the `.p8` when offered and record its Key ID and Issuer ID. Do not use an individual API key.
4. On macOS, copy single-line base64 values with commands that do not leave an additional plaintext output file:

   ```bash
   base64 < DeveloperIDApplication.p12 | tr -d '\n' | pbcopy
   base64 < AuthKey_ABC123DEFG.p8 | tr -d '\n' | pbcopy
   ```

5. Paste those values into `MACOS_CERTIFICATE_P12_BASE64` and `APPLE_API_KEY_P8_BASE64`; store the password and identifiers in their matching secrets. Keep the original files in secure storage and never commit them.

The App Store Connect `.p8` is normally downloadable only once. If it is lost, revoke it, create a replacement Team key, and update all three API-key secrets together.

### Optional Windows GitHub Actions secrets

| Secret                                           | Purpose                            |
| ------------------------------------------------ | ---------------------------------- |
| `AZURE_TENANT_ID`                                | Entra tenant for Windows signing   |
| `AZURE_CLIENT_ID`                                | Entra application client ID        |
| `AZURE_CLIENT_SECRET`                            | Entra application client secret    |
| `AZURE_TRUSTED_SIGNING_ENDPOINT`                 | Azure Trusted Signing endpoint URL |
| `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME`             | Azure signing account name         |
| `AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME` | Azure certificate profile name     |
| `AZURE_TRUSTED_SIGNING_PUBLISHER_NAME`           | Azure publisher name               |

When this complete set is available, the workflow enables Azure Trusted Signing. If it is incomplete, the Windows build continues unsigned. This optional behavior does not apply to macOS.

### Build environment variables

| Variable                         | Purpose                                                                                   |
| -------------------------------- | ----------------------------------------------------------------------------------------- |
| `GITHUB_REPOSITORY`              | `owner/repo` used to generate the electron-updater configuration; set automatically in CI |
| `CLUI_DESKTOP_UPDATE_REPOSITORY` | Optional `owner/repo` override for a different update feed                                |

Local macOS builds are unsigned by default. The artifact builder disables signing discovery unless signed mode is explicitly selected, even if a signing identity happens to be installed. There is no ad-hoc signing fallback.

For a deliberate local signed build, pass `--signed` or set `CLUI_DESKTOP_SIGNED=true` and configure:

| Variable                 | Purpose                                                         |
| ------------------------ | --------------------------------------------------------------- |
| `MACOS_SIGNING_IDENTITY` | Exact Developer ID Application identity name                    |
| `MACOS_SIGNING_KEYCHAIN` | Keychain containing that identity and private key               |
| `APPLE_API_KEY_PATH`     | Filesystem path to the decoded App Store Connect Team API `.p8` |
| `APPLE_API_KEY_ID`       | Matching Team API Key ID                                        |
| `APPLE_API_ISSUER`       | Matching Team API Issuer ID                                     |

Import the Developer ID identity and private key into the selected keychain before starting the build and make it available to `codesign`. The local build script does not import a `.p12`; the five base64 secrets above are CI workflow inputs, not local signing variables.

## macOS signing and notarization pipeline

The macOS arm64 build runs on the standard GitHub-hosted `macos-14` M1 runner. Linux x64 builds natively on `ubuntu-24.04`; Windows x64 uses the same Ubuntu runner with Wine for NSIS packaging.

1. The workflow requires all five Apple secrets, decodes the `.p12` and `.p8` into temporary files, and creates a temporary keychain.
2. It imports the Developer ID Application certificate/private key, unlocks the keychain for non-interactive signing, and derives the explicit signing environment.
3. electron-builder uses `@electron/osx-sign` to recursively sign the app and its nested helpers, frameworks, native executables, and other signable content with hardened runtime enabled.
4. The repository's `afterSign` hook verifies the signed app with `codesign`, invokes `xcrun notarytool` directly, submits and polls to a terminal status, fails rejected or invalid submissions, and staples the accepted ticket.
5. electron-builder creates the arm64 DMG and ZIP around the signed, notarized, stapled app.
6. Before collecting or uploading assets, the workflow extracts the ZIP and runs `codesign`, `stapler validate`, and Gatekeeper's `spctl` against the packaged app. It separately checks the bundled Claude Code proxy's signing identity and architecture, then validates the DMG with `hdiutil verify`.

There is no catch-and-continue unsigned path for macOS. A missing/invalid credential or any signing, notarization, stapling, or verification error fails that matrix job. The GitHub Release job depends on the entire build matrix, so an unsigned macOS release is not published.

## Release steps

### 1. Ensure `main` is ready

All release changes should be merged to `main`, required checks should be green, and all five Apple secrets should be configured before triggering the workflow. An unsigned macOS release is not a supported dry run; exercise development builds locally and quality gates in normal CI instead.

### 2. Bump version if needed

The current release package versions are in the desktop, server, web, and contracts package manifests. The finalize job updates them after a release, but a specific version can be set before tagging:

```bash
bun scripts/update-release-package-versions.ts 1.2.3
bunx oxfmt apps/server/package.json apps/desktop/package.json apps/web/package.json packages/contracts/package.json
bun install --lockfile-only --ignore-scripts
```

### 3. Trigger the workflow

Push a tag:

```bash
git tag v1.2.3
git push origin v1.2.3
```

Or go to **Actions > Release Desktop > Run workflow** and enter `1.2.3` or `v1.2.3`.

### 4. Monitor jobs

The workflow runs:

1. **Preflight** — validates the version and runs lint, typecheck, and tests.
2. **Build** — builds macOS arm64, Linux x64, and Windows x64. macOS signing/notarization is mandatory; Windows signing is optional. Linux and Windows both use `ubuntu-24.04`, with Wine installed for Windows NSIS packaging.
3. **Release** — creates the GitHub Release with all three platforms' desktop assets.
4. **Finalize** — updates release package versions and pushes the change to `main` when required.

### 5. Verify release assets

The release must retain each platform's updater payloads:

- One macOS arm64 `.dmg` and one macOS arm64 `.zip`
- One Linux x64 `.AppImage`
- One Windows x64 `.exe`
- Applicable `*.blockmap` files
- `latest-mac.yml`, `latest-linux.yml`, and `latest.yml`

`electron-updater` consumes the platform-specific update manifest. The ZIP is the required macOS updater payload; do not remove it after publishing.

Verify the downloaded GitHub Release artifacts rather than relying only on CI logs. Mount each DMG, copy the packaged `.app` to a temporary location, and run:

```bash
APP="/path/to/Clui (Alpha).app"
codesign --verify --deep --strict --verbose=2 "$APP"
spctl --assess --type execute --verbose=4 "$APP"
xcrun stapler validate "$APP"
```

Expect a valid sealed signature, an `accepted` Gatekeeper result with a notarized Developer ID origin, and a valid staple. Launch and smoke-test the arm64 build on a representative Apple Silicon Mac, and smoke-test the Linux and Windows installers.

## Auto-update behavior

1. electron-builder generates `app-update.yml` at build time with the GitHub provider and repository coordinates.
2. The app checks the corresponding `latest-mac.yml`, `latest-linux.yml`, or `latest.yml` on startup delay and periodically afterward.
3. When a newer version is available, the UI exposes a download action and then a restart/install action.
4. Public repositories need no runtime GitHub token. Private repositories currently require `CLUI_DESKTOP_UPDATE_GITHUB_TOKEN` or `GH_TOKEN` in the desktop runtime environment.

Tags such as `v1.2.3-beta.1` are GitHub prereleases and are not served to the stable `latest` update channel.

## Troubleshooting

- **A required macOS secret is missing:** Check all five exact names under the repository's Actions secrets. Empty strings fail closed.
- **Base64 decode or certificate import fails:** Re-encode with `base64 < file | tr -d '\n'`, verify the `.p12` includes its private key, and confirm `MACOS_CERTIFICATE_PASSWORD` matches the export password.
- **No valid signing identity is found:** Confirm the certificate type is **Developer ID Application**, not Mac App Distribution or Developer ID Installer. On a diagnostic Mac, use `security find-identity -v -p codesigning`; do not replace the identity with an ad-hoc signature.
- **`notarytool` authentication fails:** Confirm the `.p8` is a Team API key with App Manager access and that `APPLE_API_KEY_ID` and `APPLE_API_ISSUER` are from the same team/key. Re-encode the original key file.
- **Notarization is rejected:** Use the submission ID from the job to inspect the `notarytool` log. Fix every reported nested binary/signature problem rather than bypassing the `afterSign` hook.
- **Stapling, `codesign`, or Gatekeeper verification fails:** Treat the build as failed even if Apple accepted the submission. Compare the failed CI verification with the downloaded-app commands above.
- **Windows packaging cannot find Wine:** Check the Windows matrix job's Wine installation step. NSIS cross-packaging on Ubuntu requires Wine.
- **Windows output is unsigned:** Check the complete Azure secret set. Windows signing remains optional.
- **Finalize cannot push:** Repository branch protection may block `github-actions[bot]`; grant the workflow the intended permission without weakening release checks.
- **Auto-update cannot find the release:** Verify the macOS DMG/ZIP, Linux AppImage, Windows EXE, blockmaps, and current platform manifests are attached.
