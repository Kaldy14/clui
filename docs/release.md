# Release Checklist

This document covers production desktop releases from `.github/workflows/release.yml`. A release may be started by pushing a `v*.*.*` tag or with the **Release Desktop** workflow's manual dispatch.

## What the workflow does

- Runs lint, typecheck, and tests before building.
- Builds four targets in parallel:
  - macOS `arm64` DMG and ZIP
  - macOS `x64` DMG and ZIP
  - Linux `x64` AppImage
  - Windows `x64` NSIS installer
- Requires every macOS release build to be Developer ID signed and notarized. Missing or invalid Apple credentials fail the macOS job; the workflow never publishes unsigned macOS release artifacts.
- Optionally signs Windows artifacts with Azure Trusted Signing when the existing Azure secret set is complete. Missing Azure credentials still leave the Windows build unsigned.
- Publishes one GitHub Release with the desktop artifacts and updater metadata. The workflow does not publish a CLI package to npm.
- Marks versions with a suffix after `X.Y.Z` (for example `1.2.3-alpha.1`) as prereleases. Only plain `X.Y.Z` releases become the repository's latest release.
- Finalizes the release by updating the release package versions on `main` when needed.

## Desktop auto-update notes

- Runtime updater: `electron-updater` in `apps/desktop/src/main.ts`.
- Update UX:
  - Background checks run on startup delay and then on an interval.
  - Downloads and installs are not automatic.
  - The desktop UI shows an update button when an update is available; click once to download, then again to restart and install.
- Provider: GitHub Releases (`provider: github`) configured at build time.
- Repository slug source:
  - `CLUI_DESKTOP_UPDATE_REPOSITORY` (`owner/repo`), if set.
  - Otherwise `GITHUB_REPOSITORY` from GitHub Actions.
- Temporary private-repository auth workaround:
  - Set `CLUI_DESKTOP_UPDATE_GITHUB_TOKEN` or `GH_TOKEN` in the desktop app's runtime environment.
  - The app forwards it as an `Authorization: Bearer <token>` header for updater requests.
- Required updater assets include the installers, macOS ZIP files, `latest*.yml`, and `*.blockmap` files.
- `electron-updater` reads one `latest-mac.yml` for both Intel and Apple Silicon. The workflow merges the per-architecture manifests before publishing the release.

## 1) Configure required macOS credentials

All five of these GitHub Actions secrets are required for every release:

| Secret                         | Value                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------- |
| `MACOS_CERTIFICATE_P12_BASE64` | Base64-encoded `.p12` containing a Developer ID Application certificate and its private key |
| `MACOS_CERTIFICATE_PASSWORD`   | Password used when exporting the `.p12`                                                     |
| `APPLE_API_KEY_P8_BASE64`      | Base64-encoded App Store Connect Team API `.p8` key                                         |
| `APPLE_API_KEY_ID`             | App Store Connect API Key ID                                                                |
| `APPLE_API_ISSUER`             | App Store Connect API Issuer ID                                                             |

Add them at **GitHub repository > Settings > Secrets and variables > Actions > Repository secrets**. The workflow has no unsigned macOS release mode: an absent/empty secret fails credential preflight, and an invalid certificate, password, key, or Apple identifier fails signing or notarization before artifacts can be uploaded.

### Create and encode the certificate

1. Ensure the Apple Developer team can create Developer ID certificates.
2. Create a **Developer ID Application** certificate. Do not substitute a Mac App Distribution or installer certificate.
3. In Keychain Access, export the certificate together with its private key as a password-protected `.p12`.
4. On macOS, copy a single-line base64 value without writing a second unencrypted copy:

   ```bash
   base64 < DeveloperIDApplication.p12 | tr -d '\n' | pbcopy
   ```

5. Save the copied value as `MACOS_CERTIFICATE_P12_BASE64` and the export password as `MACOS_CERTIFICATE_PASSWORD`.

### Create and encode the notarization key

1. In **App Store Connect > Users and Access > Integrations**, create a **Team API key** with **App Manager** access. Do not use an individual API key.
2. Download the `.p8` when Apple offers it; it can be downloaded only once. Record its Key ID and the Team key's Issuer ID.
3. On macOS, copy its single-line base64 value:

   ```bash
   base64 < AuthKey_ABC123DEFG.p8 | tr -d '\n' | pbcopy
   ```

4. Save the copied value as `APPLE_API_KEY_P8_BASE64`, the Key ID as `APPLE_API_KEY_ID`, and the Issuer ID as `APPLE_API_ISSUER`.
5. Store the original `.p12` and `.p8` securely. Never commit either file or a decoded value.

## 2) Understand the fail-closed macOS path

For each macOS architecture, CI:

1. Validates that all five required secrets are non-empty and base64-decodes the `.p12` and `.p8` into runner-temporary files.
2. Creates a temporary keychain, imports the Developer ID Application certificate and private key, configures non-interactive `codesign` access, and derives the signing environment used by the build.
3. Runs electron-builder, whose `@electron/osx-sign` integration recursively signs the app, nested helpers/frameworks, and native executables with hardened runtime enabled.
4. Runs the repository's direct `xcrun notarytool` `afterSign` hook against the packaged app. The hook first verifies the signature with `codesign`, submits and polls the notarization request, fails on a rejected/invalid response, and staples the accepted ticket.
5. Produces both DMG and ZIP updater assets for that architecture.
6. Extracts the produced ZIP and verifies the packaged app with `codesign`, `stapler validate`, and Gatekeeper's `spctl`; it also verifies the bundled Claude Code proxy's signature and architecture and checks the DMG with `hdiutil verify`. Asset collection and upload run only after this post-build gate succeeds.

There is no ad-hoc signature and no catch-and-continue unsigned fallback. Because the release job depends on every matrix build, either macOS architecture failing prevents the GitHub Release from being published.

### Local builds

Local macOS builds remain unsigned by default. The artifact script disables signing discovery unless signed mode is explicitly requested, so a locally installed identity is not selected accidentally and there is no ad-hoc fallback.

A deliberate local signed build must pass `--signed` or set `CLUI_DESKTOP_SIGNED=true`, then provide the derived environment that CI normally prepares:

- `MACOS_SIGNING_IDENTITY` — the exact Developer ID Application identity name.
- `MACOS_SIGNING_KEYCHAIN` — the keychain containing that identity and private key.
- `APPLE_API_KEY_PATH` — a filesystem path to the decoded App Store Connect Team API `.p8`.
- `APPLE_API_KEY_ID` — the matching Team API Key ID.
- `APPLE_API_ISSUER` — the matching Team API Issuer ID.

Before starting the build, import the Developer ID identity and private key into that keychain and make it available to `codesign`. The local build script does not import a `.p12`. The five base64 GitHub secret names are CI inputs, not local build variables.

Use unsigned local builds only for development. They are not a supported way to dry-run or publish a macOS release.

## 3) Configure optional Windows signing

Windows Azure Trusted Signing remains optional and continues to use:

- `AZURE_TENANT_ID`
- `AZURE_CLIENT_ID`
- `AZURE_CLIENT_SECRET`
- `AZURE_TRUSTED_SIGNING_ENDPOINT`
- `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME`
- `AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME`
- `AZURE_TRUSTED_SIGNING_PUBLISHER_NAME`

Create the Azure Trusted Signing account/profile and an Entra service principal with the required permissions, then add the values under the same GitHub Actions secrets page. When the complete set is present the Windows artifact is signed; otherwise the existing optional unsigned Windows path is used.

## 4) Run a release

1. Ensure `main` is green and the five required Apple secrets are configured.
2. Create and push a tag:

   ```bash
   git tag v1.2.3
   git push origin v1.2.3
   ```

   Alternatively, go to **Actions > Release Desktop > Run workflow** and enter `1.2.3` or `v1.2.3`.

3. Confirm these stages complete:
   - Preflight quality gates
   - Both signed/notarized macOS matrix builds
   - Linux and Windows matrix builds
   - GitHub Release publication and macOS manifest merge
   - Version finalization, when a bump is needed
4. Confirm the GitHub Release contains two `.dmg` files, two `.zip` files, one `.AppImage`, one `.exe`, their applicable `*.blockmap` files, and `latest-mac.yml`, `latest-linux.yml`, and `latest.yml`.
5. Smoke-test downloaded artifacts on their target operating systems.

## 5) Verify downloaded macOS artifacts

Verify the files from the GitHub Release, not only CI's staging directory.

1. Mount each DMG, copy the packaged `.app` to a temporary directory, and run:

   ```bash
   APP="/path/to/Clui (Alpha).app"
   codesign --verify --deep --strict --verbose=2 "$APP"
   spctl --assess --type execute --verbose=4 "$APP"
   xcrun stapler validate "$APP"
   ```

2. Confirm `codesign` reports a valid sealed signature, `spctl` reports `accepted` with a notarized Developer ID origin, and `stapler` validates the ticket.
3. Launch both Apple Silicon and Intel builds on representative machines, then check that the updater discovers the expected architecture from the merged `latest-mac.yml`.

## 6) Troubleshooting

- **Required secret reported missing:** Check the five exact names above under the repository's Actions secrets. Empty values are treated as missing.
- **Certificate base64 or import failure:** Re-encode with `base64 < file | tr -d '\n'`; ensure the `.p12` includes the private key and `MACOS_CERTIFICATE_PASSWORD` is the export password.
- **No Developer ID identity found:** On a diagnostic Mac, run `security find-identity -v -p codesigning` and confirm the identity is **Developer ID Application** for the intended team. Do not weaken CI to ad-hoc signing.
- **Notarization authentication failure:** Confirm the key is an App Store Connect Team API key with App Manager access and that `APPLE_API_KEY_ID` and `APPLE_API_ISSUER` belong to that same key/team. Re-encode the original `.p8`; do not encode a filename or pasted escape sequences.
- **Notarization rejected:** Inspect the submission ID and `notarytool` log in the failed job, fix every reported unsigned or invalid nested executable, and rerun. Do not bypass the `afterSign` hook or verification.
- **Stapling or Gatekeeper verification failure:** Treat it as a failed release even if notarization was accepted. Check the CI log and downloaded app with the commands above.
- **Windows artifact is unsigned:** Check the complete Azure secret set. This remains optional and does not relax the macOS requirement.
- **Auto-update does not discover the release:** Confirm the release contains both architecture ZIPs, both DMGs, blockmaps, and the merged `latest-mac.yml` plus the Linux/Windows manifests.
