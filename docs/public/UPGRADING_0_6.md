# Upgrading to v0.6.0

v0.6.0 adds automatic Git fetching, signed GitHub/Gitea/Forgejo push webhooks, per-stack Portainer and
generic deployment webhooks, and opt-in selective deployment after verified pushes. Nothing deploys
automatically after the upgrade: every stack starts with no deployment binding and automatic deployment off.

## Before you upgrade

1. Note your current `STACK_MANAGER_VERSION` (you need it to roll back).
2. Stop Stack Manager and back up the data volume; keep the encryption key and session secret separately.
   Follow [Backup and restore](BACKUP_RESTORE.md#take-a-consistent-backup).
3. Read the [release notes](https://github.com/uniskela/stack-manager/releases).

## Upgrade

1. Set `STACK_MANAGER_VERSION=0.6.0` in `.env` and run `docker compose up -d`.
2. Migrations `0004`–`0010` run on start. They only add tables and columns; existing users, workspaces,
   repositories, credentials, stacks, drafts, unpushed commits, jobs and audit history are kept unchanged.
3. Background fetching starts every 15 minutes by default. Change it with
   `STACK_MANAGER_AUTO_FETCH_INTERVAL_MINUTES` (5–1440) or `STACK_MANAGER_AUTO_FETCH_ENABLED=false`, or per
   repository in **Overview → Automatic fetching**.
4. Optional features stay off until you configure them: [Git push webhooks](GIT_WEBHOOKS.md) and
   [Deployment webhooks](DEPLOYMENT_WEBHOOKS.md).

To roll back, follow [Rolling back an upgrade](BACKUP_RESTORE.md#rolling-back-an-upgrade): restore the
pre-upgrade backup and run the previous version. Do not run the previous version on the upgraded database.

## Acceptance checklist before enabling automatic deployment

Automated tests cover these behaviours with mock forges and receivers. They cannot prove that your forge
version, reverse proxy, TLS chain and deployment receiver behave the same way. Run this checklist once on a
**disposable** stack before opting real stacks into automatic deployment. Record each result.

Use a throwaway repository folder and a throwaway receiver stack (for example a Portainer stack running a
`traefik/whoami` container, or a generic HTTPS endpoint you control that logs requests). Never use a
production stack for steps 6–12.

| # | Check | How | Expected result |
| --- | --- | --- | --- |
| 1 | Backup | Stop, archive the volume, start again ([guide](BACKUP_RESTORE.md#take-a-consistent-backup)). Store keys separately. | Archive exists, `chmod 600`, keys stored elsewhere. |
| 2 | Webhook ingress through the reverse proxy | Configure the repository's **Git webhooks** signing secret and the forge hook (POST, JSON, push only). Push a commit to the tracked branch. | Forge delivery history shows HTTP 202 `accepted`; Overview shows **Last accepted delivery**. GitHub's initial ping returns 200 `ignored`, which is expected. Any 401, 413, 415 or redirect means the secret, proxy or hook settings need fixing. |
| 3 | Provider signature format | In the forge delivery details, check the headers. | GitHub: `X-Hub-Signature-256: sha256=…`. Gitea: `X-Gitea-Signature`. Forgejo: `X-Forgejo-Signature`. A wrong secret returns 401. |
| 4 | Automatic fetch | Set the repository's **Check interval** to 5 minutes, disable the forge hook, push a commit from outside Stack Manager and wait. | The new commit appears without **Fetch now**; last-checked time updates. Re-enable the hook. |
| 5 | Outbound webhook configuration | On the disposable stack's **Deployment** tab, save the Portainer or generic HTTPS URL, then choose **Validate destination**. | Settings show only a mask. Validation passes without sending a request. Private addresses need `STACK_MANAGER_ALLOW_PRIVATE_NETWORKS=true`. |
| 6 | Manual deployment | Choose **Deploy now** and confirm. | **Recent deployments** shows **Accepted** with an HTTP status, and the receiver shows exactly one request. Accepted means the receiver answered 2xx, not that containers are healthy: check them in Portainer. |
| 7 | Routing rules and preview | Review the include/exclude/dependency patterns. Enter `<stack root>/compose.yaml` and `<stack root>/README.md` as sample paths and choose **Preview routing**. | Compose change: deploy; README-only: no deployment. No request is sent. |
| 8 | Opt in | Select **Deploy automatically after verified Git pushes** and save. | Saved. No request is sent on save; the baseline is the current fetched commit. |
| 9 | Relevant push | Change the disposable stack's Compose file and push to the tracked branch. | **Recent routing decisions** shows **deploy** for this stack only; one new **Automatic** attempt; the receiver shows one request. Other opted-in stacks show skip. |
| 10 | Irrelevant push | Change only a Markdown file in the stack folder and push. | Decision **skip** (`no_relevant_changes`); no new attempt; no receiver request. |
| 11 | Repeated delivery | In the forge, **Redeliver** the push from step 9. | Forge shows HTTP 200 with `duplicate`; no new decision or attempt; no receiver request. |
| 12 | Unknown outcome recovery | Make the receiver slow or unreachable so a request times out (for example a generic endpoint that waits longer than 15 seconds, or stop the receiver's proxy route), then push a relevant change. | Attempt shows **Unknown**; automation is on hold; a further relevant push is **blocked** (`outcome_unknown`). Check whether the receiver acted, restore it, then use **Deploy now**: the hold clears and the next relevant push deploys. |
| 13 | Audit and history | Open **Settings → Activity** and the stack's **Deployment** tab. | Entries for webhook configured, destination checked, manual and automatic requests, accepted, unknown and stack not deployed. No URLs, tokens or secrets appear anywhere. |
| 14 | Restore on a separate instance | Restore the step 1 archive into a new volume. Start it with the same keys on another port and `STACK_MANAGER_WORKER_ENABLED=false`, so it cannot send deployment requests. Disable every deployment binding on the copy, then restart it with the worker enabled and choose **Fetch now**. | Sign-in works, repositories, stacks and drafts are present, and the fetch succeeds (credentials decrypt). The copy sends no deployment requests. Remove it afterwards. |

When all checks pass, opt real stacks in one at a time. Keep Git polling enabled as a fallback for missed
webhooks, and keep regular backups.
