# Notify the Uniskela documentation site

stack-manager's user documentation is published at [uniskela.com/docs/stack-manager](https://uniskela.com/docs/stack-manager/)
by `uniskela/.com`, the same way as adhd-hub and ts6-manager.

- [`docs/manifest.json`](../docs/manifest.json) lists the pages to publish: `source` file, URL `slug`, sidebar `title`
  and `group`. Published pages live under `docs/public/`. `docs/internal/` (plans, architecture decisions) and
  `docs/agents/` are not imported; links to them fall back to GitHub URLs on the site.
- The `Notify Uniskela documentation` workflow sends an update notification after README/docs changes merge to
  `main` (and on each published release). It does not publish the website directly: `uniskela/.com` imports the
  content, runs its checks and proposes a draft PR for review.

## One-time setup

1. In `uniskela/.com`, add `uniskela/stack-manager` to the receiver's list of documentation sources and select its
   pages (see `docs/docs-dispatch-setup.md` in that repository).
2. In this repository, configure the Actions variable `DOCS_SYNC_APP_CLIENT_ID` and the Actions secret
   `DOCS_SYNC_APP_PRIVATE_KEY` for the dedicated documentation GitHub App (installed only on `uniskela/.com` with
   Contents read/write). The workflow creates a short-lived, destination-only installation token, which is revoked
   after the job. It never runs on pull requests or forks and does not check out source code.
3. Run the workflow manually on `main` and verify the receiver in `uniskela/.com` succeeds.

Missing credentials make the workflow fail visibly. The weekly sync in `uniskela/.com` remains a fallback. GitHub does
not start push-triggered workflows for pushes made with `GITHUB_TOKEN`; use a manual run in that case.

Never put the App private key in repository files, PRs or chats.

## Adding a page

Write it in `docs/public/`, link it from [`docs/public/index.md`](../docs/public/index.md) and add an entry to
`docs/manifest.json`. The slug is the public URL and does not include `public`. Use relative links between docs so
they work both on GitHub and on the site. Put implementation plans and architecture decisions in `docs/internal/`,
and agent-only notes in `docs/agents/`.
