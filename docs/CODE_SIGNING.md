# Code signing

Blockwright's Windows installer is signed through **SignPath Foundation**,
which signs open-source projects for free. Until the project is accepted and
set up, releases are published **unsigned** (Windows then says the publisher
is unknown).

## Code signing policy

Also shown on the website: https://arilegrand.com/blockwright/

Free code signing provided by [SignPath.io](https://signpath.io), certificate
by [SignPath Foundation](https://signpath.org).

| Role | Members |
|---|---|
| Committers and reviewers | [AriLeGrand](https://github.com/AriLeGrand) |
| Approvers | [AriLeGrand](https://github.com/AriLeGrand) |

- Every change from someone else (pull request) is reviewed by a committer
  before it is merged.
- Every release is built from the tagged source code by GitHub Actions on
  GitHub-hosted runners ([`.github/workflows/release.yml`](../.github/workflows/release.yml))
  and signed only after an approver approves it in SignPath.
- Only Blockwright's own installer is signed. Libraries it is built from keep
  their own signatures, or none.

**Privacy:** this program will not transfer any information to other
networked systems unless specifically requested by the user or the person
installing or operating it. It reads Minecraft's textures from the user's own
computer and only opens web pages when the user clicks a link.

The installer includes an uninstaller (Windows Settings → Apps → Blockwright).

## Setting it up (owner, once)

1. **Publish a first release.** SignPath Foundation only accepts projects that
   are already released. Merge to `main`, then push a tag that matches the
   version in `app/src-tauri/tauri.conf.json`:

   ```powershell
   git tag v0.1.0
   git push origin v0.1.0
   ```

   The Release workflow builds the installer and publishes it, unsigned.
2. **Apply** to SignPath Foundation for an open-source subscription (form on
   [signpath.org](https://signpath.org)), with the repository link. Turn on
   two-factor authentication on GitHub and SignPath: it is required.
3. **In SignPath**, once accepted:
   - add the predefined trusted build system **GitHub.com** to the
     organization and link it to the project, and install the SignPath GitHub
     App on the repository;
   - create the project (for example `blockwright`) and a signing policy
     (`release-signing`) with manual approval;
   - set the project's **artifact configuration**. The workflow uploads the
     installer inside a ZIP, so the root is a `zip-file`:

     ```xml
     <?xml version="1.0" encoding="utf-8"?>
     <artifact-configuration xmlns="http://signpath.io/artifact-configuration/v1">
       <zip-file>
         <pe-file path="Blockwright_*_x64-setup.exe" product-name="Blockwright">
           <authenticode-sign />
         </pe-file>
       </zip-file>
     </artifact-configuration>
     ```

     SignPath Foundation also asks for the product version to be restricted;
     the installer's version is the one in `tauri.conf.json`. Follow the
     "file metadata restrictions" section of the SignPath documentation.
   - create an API token for a user with *submitter* rights.
4. **In GitHub** (repository Settings → Secrets and variables → Actions):
   - secret `SIGNPATH_API_TOKEN`: the API token;
   - variables `SIGNPATH_ORGANIZATION_ID`, `SIGNPATH_PROJECT_SLUG`
     (`blockwright`) and `SIGNPATH_SIGNING_POLICY_SLUG` (`release-signing`).

From then on, every pushed version tag is built, waits up to an hour for an
approver to approve the signing request in SignPath, and is published signed.

## Releasing a new version

1. Raise the version in `app/src-tauri/tauri.conf.json`, `app/package.json`
   and `app/Cargo.toml`, and merge to `main`.
2. Push the tag `v<version>`.
3. Approve the signing request in SignPath (you get an email).

## What is not signed

SignPath signs the installer. The app program it installs is not signed
separately: Windows only checks the publisher of downloaded files, so the
installer's signature is what removes the warning.
