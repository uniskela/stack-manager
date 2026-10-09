# Backup and restore

## What to back up

Application data directory (indicative layout):

```text
data/
  stack-manager.sqlite       # includes credential ciphertext, session digests, jobs, audit
  stack-manager.sqlite-wal   # WAL mode — back up together with the main file (or checkpoint first)
  stack-manager.sqlite-shm
  repos/                     # local clones (re-creatable from the forge)
  git-home/                  # isolated git HOME (re-creatable)
```

See [SELF_HOSTING.md](SELF_HOSTING.md#data-directory) for ownership and permissions.

Also back up **configuration env** separately (encryption key, session secret) via host secret management — **not** inside the DB dump alone.

## Backup methods (planned)

1. **Volume snapshot** of Docker named volume (preferred operationally)
2. **In-app export** (PR #8): consistent SQLite checkpoint + manifest of version + keyVersion (not the key itself)
3. Document `sqlite` online backup API usage for consistency

## Restore

1. Stop stack-manager
2. Restore volume / files
3. Ensure same `STACK_MANAGER_ENCRYPTION_KEY`
4. Start and run migrations if needed
5. Verify Git remotes fetch; re-test provider connections

## Failure modes

| Situation | Result |
| --- | --- |
| DB restored, wrong encryption key | App starts but credentials unusable — show clear error |
| Key restored, empty DB | Fresh setup; old credentials gone |
| Clone dirs missing | Re-clone from forge on demand |

## What not to back up into Git

- Entire `data/` directory
- Encryption keys
- Session secrets
- Decrypted credential material

## Tests (PR #8)

- Export/import round-trip on fixture workspace
- Wrong-key detection
- Redaction: export archive must not contain plaintext tokens
