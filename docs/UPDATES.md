# Tiny desktop updates

Tiny 0.1.0 has no updater. Install the signed-updater version **0.2.0 once** using its installer. Later versions can be delivered through that installed app; 0.1.0 cannot gain this feature remotely.

The client checks once at startup, without a background polling loop. It can download an available update and then ask you to restart and install, so an active call is not ended without your choice. This updates the desktop client. The separately hosted Tiny server is updated by its host.

## Distribution

Application source and public release artifacts live in `Gulzey/Tinycom`. GitHub Releases contain only the reviewed installer, signature, and updater manifest; credentials, server databases, private environment files, and signing keys are never uploaded.

The installed updater reads:

`https://github.com/Gulzey/Tinycom/releases/latest/download/latest.json`

Each manifest points to its version's `Tiny-Setup.exe` and includes the generated signature content. Both URLs use HTTPS. The public updater needs no GitHub token.

## Release owner: keep the signing key private

The public updater key belongs in Tauri configuration. The matching **private** key stays outside tracked files, normally `.build/update-keys/tiny.key`, or is supplied using `TAURI_SIGNING_PRIVATE_KEY`. Keep a separate protected backup. Never commit, upload, put in a release ZIP, or send the private key to friends. If it is lost, existing installations cannot trust a newly generated replacement key. `.build/` and `*.key` are ignored, but always review staged files and release contents before publishing.

Create the key pair only once, using Tauri's signer if an existing key is not available:

```powershell
npx.cmd tauri signer generate -w .build/update-keys/tiny.key
```

Follow the password prompt. If the key is password protected, set `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` in the current build process. Do not put it into project source or a release file. Never regenerate a key merely to get a build working.

## Prepare the next release

1. Set the same new version in `package.json`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml`. Keep the existing updater public key.
2. Set `TAURI_SIGNING_PRIVATE_KEY` to the existing key's filename or content if it is not at the default location. The build wrapper reads the key only for the child build and never prints it. An unencrypted key needs no password variable.
3. Run the checks and prepare local artifacts:

```powershell
npm.cmd test
npm.cmd run format:check
npm.cmd run release
```

`release/` contains `Tiny-Setup.exe`, `Tiny-Setup.exe.sig`, `latest.json`, and the host ZIP. A missing signature stops packaging. `latest.json` embeds the signature file's content, rather than its filename. Signature verification happens in the native updater before installation. Update signing protects the update payload; it is separate from Windows Authenticode publisher signing, so an unknown-publisher warning can still appear.

4. Review those files and the host ZIP allowlist. Keep real `.env`/`tiny-server.env` files, database files, source, and private keys out of uploads. Upload only the reviewed artifacts to a versioned public GitHub release such as `v0.2.0`, after publication is approved. Keep the installer and manifest from the same build together.
5. Check that anonymous access to `latest.json` and its exact installer URL works, then test the update from an older updater-enabled installation. Preserve the old installer for recovery. A local signature rejection test does not prove the public release/install/restart path by itself.

See the [official Tauri updater documentation](https://v2.tauri.app/plugin/updater/) for signature configuration and static manifest requirements.

## GitHub Actions stable release

`.github/workflows/release-windows.yml` validates versions, runs unit and browser media tests, builds the NSIS installer, signs the updater artifact, and publishes only the installer, signature, and `latest.json` to the public `Gulzey/Tinycom` release for a `vX.Y.Z` tag. Configure these repository secrets first:

- `TAURI_SIGNING_PRIVATE_KEY`: the existing updater private key content.
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: its password, or an empty secret for the current unencrypted key.
  The workflow uses its short-lived GitHub token with `contents: write` for the tagged release. Do not place any long-lived token or secret in workflow YAML. Protect release tags and require review of the workflow run. GitHub Actions stores the signing key only in the job environment; the workflow uploads no source database, `.env`, or key file.

Before tagging, merge the reviewed development branch to `main`, set matching versions in all three version files, and test the locally signed installer. Then:

```powershell
git tag -s v0.2.0 -m "Tiny 0.2.0"
git push origin v0.2.0
```

After the workflow succeeds, anonymously open the manifest and installer URL, then test from an older updater-enabled installation. Tauri update signatures are mandatory but separate from Windows Authenticode; without an Authenticode certificate, Windows can still display an unknown-publisher warning.
