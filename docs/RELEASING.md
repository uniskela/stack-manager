# CI, releases and container images

Modelled on the ts6-manager pipeline: Release Please drives versions, and images are published only from immutable
release tags after passing a security gate.

## Workflows

| Workflow | Runs on | What it does |
| --- | --- | --- |
| `ci.yml` | PRs, pushes to `main` | actionlint + shellcheck; format, lint, typecheck, unit/integration tests; migration drift; build; HTTP smoke test; Playwright + axe; `pnpm audit --prod`; Docker image boot test |
| `gitleaks.yml` | PRs, pushes to `main`, nightly | Scans the **full Git history** for secrets using `.gitleaks.toml` (default rules + narrow test-fixture allowlists) |
| `container-security.yml` | PRs/pushes touching the image, weekly, manual | Trivy: Dockerfile misconfiguration, `pnpm-lock.yaml` vulnerabilities, full image inventory (artifact) and a gate on fixable HIGH/CRITICAL; checks the runtime ships no package managers |
| `pr-title.yml` | PRs | Requires a Conventional Commit title (squash merges use the title as the commit message) |
| `release-please.yml` | pushes to `main` | Opens/updates the release PR; when it is merged, tags `vX.Y.Z`, creates the GitHub Release and calls `publish-image.yml` |
| `publish-image.yml` | called by Release Please, or manually for an existing tag | Builds the tag, smoke-tests the container, Trivy-gates it, pushes to GHCR with SBOM + provenance, then moves `X.Y`/`latest` if it is the newest release |

All third-party actions are pinned to commit SHAs; Dependabot proposes weekly updates for npm packages
(minor/patch), GitHub Actions and the Docker base image.

## Release flow

1. Merge PRs with Conventional Commit titles. `feat:` → minor, `fix:`/`perf:` → patch; while the version is `0.x`,
   breaking changes (`feat!:`) bump the minor version. `docs:` appears in the changelog; `chore:`, `ci:`, `build:`,
   `test:`, `refactor:` and `style:` are hidden and do not trigger a release on their own.
2. Release Please keeps a single **release PR** open (`chore(main): release x.y.z`) that bumps `package.json` and
   `CHANGELOG.md`. Review it like any other PR.
3. Merging the release PR creates the `vX.Y.Z` tag and GitHub Release, then publishes
   `ghcr.io/uniskela/stack-manager` with tags `vX.Y.Z`, `X.Y.Z`, `X.Y` and `sha-<commit>`. `latest` moves only after
   the image passed its smoke test and vulnerability gate.
4. Version tags are **immutable**: a published release is never rebuilt or retargeted. Running **Publish container
   image** manually for an existing tag only restores missing tags (byte-identical copies of the published digest)
   and fails if tags of one release disagree.
5. Moving tags follow Git tags: `latest` moves only to the highest `vX.Y.Z`, and `X.Y` only to the highest patch of
   that line, so republishing an old release or runs finishing out of order never move them backwards. Promotions
   share one concurrency group. The tag logic lives in `scripts/ci/release-image.sh`.

## One-time repository settings

- **Settings → Actions → General → Workflow permissions:** enable *Allow GitHub Actions to create and approve pull
  requests*, otherwise Release Please cannot open its PR.
- PRs opened with the default `GITHUB_TOKEN` do not trigger other workflows, so CI will not run on the release PR.
  If branch protection requires checks, add a fine-grained token (Contents + Pull requests: read/write) as the
  `RELEASE_PLEASE_TOKEN` secret; the workflow uses it automatically.
- The GHCR package inherits the repository's visibility. While the repository is private, pulling needs
  `docker login ghcr.io` with a `read:packages` token.
- Images are linux/amd64. arm64 (e.g. Raspberry Pi) needs emulated or arm64 runners and can be added to
  `publish-image.yml` later.
