# Publishing agentNote to the Obsidian Community Marketplace

> 中文主文档：[官方社区市场上架流程](官方社区市场上架流程.md)

This guide defines the repeatable release path for publishing and maintaining agentNote in the Obsidian Community Plugins directory.

## Responsibilities

| Area | Maintainer | Account owner |
| --- | --- | --- |
| Code, tests, build output, release materials | Prepare and verify | Confirm scope |
| GitHub commits and releases | Prepare commands and assets | Complete login or grant access |
| Obsidian Community submission | Check fields and review feedback | Connect accounts, accept policies, submit |

## 1. Define the Release

Before publishing, decide the release version and the exact feature scope. Keep the following values aligned:

- `manifest.json` version
- `package.json` version
- GitHub Release tag
- Release title

Use a strict semantic version such as `0.3.2`. Do not reuse a previously published tag.

## 2. Check Repository Requirements

Confirm that the public repository contains:

- `LICENSE` with the chosen open-source license.
- `README.md` with installation, usage, privacy, and limitation information.
- `manifest.json` with a valid plugin ID, version, compatible `minAppVersion`, and concise description.
- `styles.css` when the plugin has custom styles.
- No private vault data, local sessions, credentials, or personal paths.

agentNote runs on desktop and uses local files plus a local HTTP service, so `isDesktopOnly` must remain consistent with that behavior.

Official references:

- [Plugin submission requirements](https://docs.obsidian.md/community-directory/submission-requirements-for-plugins)
- [Manifest reference](https://docs.obsidian.md/Reference/Manifest)

## 3. Verify Locally

Run the quality gates from the repository root:

```powershell
npm run typecheck
npm run build
node test/e2e.mjs
```

Then deploy the built plugin to a test vault and verify in Obsidian:

- The plugin enables without errors.
- The agent console opens correctly.
- The three built-in agent cards remain visible.
- An uninstalled agent opens its official website.
- Installed-agent setup, updates, prompt management, and removal still work.
- The local service responds at `/api/health`.
- Shared files, folders, selections, and notes resolve correctly.
- An agent can create and update notes through the intended local workflow.

Do not create a release until these checks pass.

## 4. Commit and Push

Review the final diff, include only publishable files, and push the release commit to the default branch.

```powershell
git add <approved-files>
git commit -m "Prepare release vX.Y.Z"
git push github main
```

The account owner must complete any GitHub login, token, SSH-key, or two-factor authentication prompt.

## 5. Create the GitHub Release

Build the plugin immediately before creating the release. Attach these files directly to the GitHub Release:

- `main.js`
- `manifest.json`
- `styles.css`

The release tag must exactly match `manifest.json`.

```powershell
gh release create X.Y.Z main.js manifest.json styles.css --target main --title "X.Y.Z" --generate-notes
```

The files must be release assets. Keeping them only in the repository does not satisfy the Community Plugins checker.

## 6. Submit to Obsidian Community Plugins

The account owner completes the account-bound actions:

1. Open [Obsidian Community](https://community.obsidian.md).
2. Sign in and connect the GitHub account.
3. Open **Plugins** and create or manage the agentNote listing.
4. Enter the repository URL: `https://github.com/xinxinrana/agentNote-Obsidian-`.
5. Select the correct owner.
6. Accept the developer policies and maintenance commitment.
7. Submit the listing or the new release for review.

Do not create a duplicate listing for a later version. Publish an incremented GitHub Release and let the directory review the existing listing again.

## 7. Handle Review Feedback

When a check fails, capture the exact error message and identify its category:

- Source-code or API compatibility issue.
- Manifest or README requirement.
- Missing or mismatched release asset.
- Repository visibility, branch, or account configuration.

Fix the root cause, rerun the local quality gates, publish a new incremented release, and let the checker run again. Do not alter an already-published release tag to represent a different build.

## 8. Verify the Published Plugin

After approval, install agentNote from the Community Plugins directory rather than a local development folder. Confirm the plugin enables, the installed version is correct, release assets download, and the local sharing workflow works as expected.

## Recurring Release Checklist

- [ ] Increment version values consistently.
- [ ] Run typecheck, build, and end-to-end tests.
- [ ] Test the built plugin in a local Obsidian vault.
- [ ] Review the public repository for private material.
- [ ] Push the approved release commit.
- [ ] Create a matching GitHub Release with `main.js`, `manifest.json`, and `styles.css` attached.
- [ ] Monitor Community Plugins review results.
- [ ] Verify installation from the official directory after approval.
