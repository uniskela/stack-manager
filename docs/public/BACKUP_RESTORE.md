# Backup and restore

A complete backup has two parts that you store **separately**:

1. **The data volume** (`/data` in the container): the SQLite database plus local Git clones.
2. **The configuration secrets**: `STACK_MANAGER_ENCRYPTION_KEY` (and its `STACK_MANAGER_ENCRYPTION_KEY_VERSION`)
   and `STACK_MANAGER_SESSION_SECRET`, kept in your host's secret management, never inside the data backup.

Without the matching encryption key, a restored database starts but cannot decrypt any stored Git token,
Git webhook signing secret or deployment webhook URL. Without the session secret, everyone is signed out.

## What is in the data volume

```text
/data/
  stack-manager.sqlite       # users, session digests, workspaces, credential ciphertext, jobs, audit,
                             # webhook delivery ledger, deployment bindings, attempts and routing decisions
  stack-manager.sqlite-wal   # write-ahead log while the app runs (absent after a clean stop)
  stack-manager.sqlite-shm
  repos/<connection-id>/     # local clones, including unpushed commits under refs/stack-manager/heads/*
  git-home/                  # isolated HOME for git (re-created automatically)
```

Drafts live in the database. Commits made in the app but not yet pushed live only in `repos/`, so back up
the whole volume, not just the database file.

## Take a consistent backup

The database runs in WAL mode. Copying `stack-manager.sqlite` while the app runs, without its WAL, can
produce an inconsistent or out-of-date backup. Use one of these methods.

### Stop, then archive the volume (recommended)

A clean stop checkpoints the WAL into the main database file.

```sh
docker compose stop stack-manager
docker run --rm -v <project>_stack-manager-data:/data:ro -v "$PWD":/backup alpine \
  tar -C /data -czf /backup/stack-manager-data-$(date +%F).tgz .
chmod 600 stack-manager-data-*.tgz
docker compose start stack-manager
```

Replace `<project>_stack-manager-data` with the volume name shown by `docker volume ls`. Snapshots of the
underlying volume or filesystem taken while the app is stopped are equally good.

### Online backup of the database (bind mounts)

If the data directory is a host bind mount and the `sqlite3` CLI is installed on the host, its backup command
is consistent while the app runs:

```sh
sqlite3 /srv/stack-manager/data/stack-manager.sqlite ".backup '/backups/stack-manager.sqlite'"
sqlite3 /backups/stack-manager.sqlite "PRAGMA integrity_check;"   # expect: ok
tar -C /srv/stack-manager/data -czf /backups/stack-manager-repos.tgz repos
```

The `repos/` archive taken this way can be slightly newer or older than the database. Prefer the stopped
method before an upgrade.

Backups contain credential ciphertext and session digests. Keep them owner-readable only (`chmod 600`) and
treat them as sensitive even though they are encrypted.

## Restore

1. Stop Stack Manager: `docker compose stop stack-manager`.
2. Restore into an **empty** volume (or move the old one aside):

   ```sh
   docker volume create <project>_stack-manager-data
   docker run --rm -v <project>_stack-manager-data:/data -v "$PWD":/backup:ro alpine \
     tar -C /data -xzpf /backup/stack-manager-data-YYYY-MM-DD.tgz --numeric-owner
   ```

   Files must stay owned by uid/gid 1000 (`node`). `-p --numeric-owner` preserves that.
3. Set the **same** `STACK_MANAGER_ENCRYPTION_KEY` and key version that were in use when the backup was taken.
4. Run the **application version that created the backup** (set `STACK_MANAGER_VERSION`), then start it.
   A newer version migrates the restored database forward on start; an older version must not be used on a
   database that a newer version has already migrated (see [Rolling back an upgrade](#rolling-back-an-upgrade)).
5. Sign in, open each repository and choose **Fetch now**; check that clone credentials still work.

## Failure modes

| Situation | Result |
| --- | --- |
| Encryption key missing, empty or a placeholder | The server refuses to start (`invalid configuration; refusing to start`). |
| Database restored with a different key | The server starts, but each credential fails to decrypt: fetches fail, signed Git webhooks return 401 and deployment requests are rejected before anything is sent. Restore the correct key. |
| Key restored, database empty or missing | A fresh first-run setup; old credentials are gone. |
| `repos/` missing | Clones are re-created on the next fetch, but unpushed in-app commits are lost. |

## Rolling back an upgrade

Database migrations only move forward and there are no down migrations. To roll back:

1. Stop Stack Manager.
2. If automatic deployment was enabled, inspect your deployment receivers (Portainer, generic endpoints) for
   requests that were sent after the backup. A restore cannot undo a request that was already sent.
3. Restore the **pre-upgrade** backup, keep the same encryption key, set `STACK_MANAGER_VERSION` back to the
   previous release and start it.

Do not run an older version against a database that a newer version has migrated, even if it appears to
start: newer tables and queued jobs remain in the database without the code that manages them. For example,
deployment requests queued by v0.6.0 stay dormant under v0.5.0 and can be sent if you later upgrade again.

### Restoring an older replay and routing ledger

v0.6.0 stores which Git webhook deliveries it has accepted, which pushes were routed to which stacks and
which deployment requests were sent. Restoring an older backup restores that older ledger:

- Forge redeliveries of pushes received after the backup are no longer recognised as duplicates and can be
  fetched and, for opted-in stacks, routed again.
- Deployment requests sent after the backup are not undone and no longer appear in history.

After restoring a backup older than your last deployments, keep automatic deployment **off** (or keep forge
webhooks disabled) until you have inspected the receivers. Then re-enable it deliberately; saving the
automatic settings sets a new baseline at the current fetched commit.

## What not to put in Git

- The data volume or any part of it
- Encryption keys and session secrets
- Decrypted credential material
