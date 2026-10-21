# Path-based deployment relevance and change routing

## Scope and activation

Issue #55 implements opt-in routing from verified GitHub, Gitea and Forgejo pushes to explicit
per-stack deployment bindings. It uses the existing persisted jobs and outbound deployment worker;
it does not observe runtime health or add a CI engine. Automatic deployment defaults to false.

Enabling automation requires an enabled binding, saved routing rules, a configured signed repository
webhook and a ready synchronized repository with a valid fetched HEAD. Saving settings with automation
enabled establishes that HEAD and tracked branch as the binding's routing baseline. Earlier history is
not replayed. Every subsequent automatic-settings save establishes a new baseline deliberately.

Manual Fetch now, polling and in-app pushes only request fetching. An in-app push needs its corresponding
signed forge webhook to become a routing source. Fetching alone grants no deployment authority.

## Authoritative pipeline

1. Verify the native HMAC-SHA256 signature over bounded unchanged request bytes; verify repository
   identity, event and tracked branch. Persist accepted delivery ID and body fingerprint with the fetch
   job transaction. Replayed IDs or accepted bodies create no additional work.
2. Preserve each accepted source's signed target identifier and signing credential version internally.
   Coalesce fetch jobs; a source arriving during a running fetch requests a durable follow-up.
3. After the source's fetch succeeds, drain pending sources through a leased routing job. The signed
   `after` SHA is only an identifier. Local commit objects must prove that it is an ancestor of the
   fetched HEAD. Webhook changed-file lists are ignored.
4. For each binding, skip targets already included in its baseline. Otherwise require a fast-forward
   range from the binding baseline to the signed target and compare the committed trees through
   `GitCli`, never the working tree. Deletions remain paths; renames yield old and new paths.
5. Evaluate paths against the saved per-stack policy and produce deploy, skip or blocked decisions.
6. In one immediate SQLite transaction, recheck the lease, binding revision, baseline, signing
   configuration and active attempt; save decisions, deployment attempts and jobs, advance applicable
   binding cursors and mark the source processed. Uniqueness on source delivery plus stack prevents
   duplicate routing. A failed transaction commits none of those changes.
7. The existing deployment worker rechecks binding, deployment credential version and signed-source
   configuration at the send boundary. Only an enabled, unchanged configuration can send.

The range is bounded to 1,000 commits and 10,000 changed paths, with Git timeouts and output limits.
Missing objects, non-ancestor or rewritten histories, unsafe paths, truncation and oversized comparisons
block routing. They never fall back to deploying all stacks. Inspect the repository and fetch, then
save automatic settings deliberately to establish a new baseline; deploy manually if needed.

## Rule semantics

Default rules include the four standard Compose filenames, `config/**` and `scripts/runtime/**`, and
exclude `README.md`, `docs/**` and `**/*.md`. The UI also includes the stack's selected Compose path.

```yaml
include:
  - compose.yaml
  - config/**
  - scripts/runtime/**
exclude:
  - README.md
  - docs/**
  - "**/*.md"
dependencies:
  - shared/proxy/**
  - shared/env/**
```

- Includes match paths relative to the stack root. An empty include list matches no root paths,
  including the Compose file. Use an explicit `**` to opt into every non-excluded root path.
- Dependencies match repository-relative paths, including paths outside the stack root, and bypass
  the include list.
- Exclusions win for both classes: evaluate root paths relative to the stack, and dependency paths
  relative to the repository. A dependency must survive its repository-relative exclusion checks.
- Only `*`, `?` and whole-segment `**` wildcards are supported. `*` matches characters within one
  segment; `?` matches one character; `**` matches zero or more path segments. There are no brace,
  character-class, negation or extended glob expressions. Reject absolute paths, traversal, `.git`,
  backslashes and control characters. Each list has at most 32 patterns, each at most 256 characters.
- The primary Compose file is not an unconditional override of includes or exclusions.

A change to `apps/wiki/compose.yaml` matches Wiki's root includes. A change to
`shared/proxy/nginx.conf` can match Wiki and Notes when both explicitly list `shared/proxy/**` as a
dependency. Documentation-only changes that match exclusions produce a skip.

The preview uses sample repository-relative paths and unsaved rules without saving or sending a
request. It explains policy relevance assuming automation is enabled; it does not verify the live
baseline, credentials, worker or receiver.

## Serialization, uncertainty and operator recovery

At most one queued or running attempt exists per stack. If a later relevant source arrives while an
attempt is active, persist a blocked `deployment_active` decision and advance the evaluated cursor;
there is no automatic replay of that later intent. Inspect the active outcome and use Deploy now
deliberately for the later change.

Known acceptance is never resent. Request intent is recorded before network I/O; a crash after intent
can leave an unknown outcome even if nothing reached the receiver. Unknown outcomes set the binding's
persistent `automationHold`; subsequent relevant sources are blocked. Saving, rotating settings or recreating a binding does
not clear the hold. After inspecting the receiver, a new deliberate manual Deploy now transaction
clears it and queues a new request; another unknown outcome restores it. Do not promise exactly-once
execution across the external HTTP boundary. Generic receivers can deduplicate the attempt ID.

Disabling or removing a binding prevents its queued attempt from sending when execution rechecks it;
it cannot recall an in-flight request. Credential rotation, tracked-branch changes and signing-secret
rotation/unlinking invalidate affected queued automatic requests.

## History, audit and dashboard

The Deployment tab shows manual/automatic attempts and recent routing decisions with safe before/after
SHAs, matched paths, reason, explanation and optional attempt reference. URLs, bearer tokens, raw
payloads and credential/signing nonces never appear in history or job payloads. Nonces remain internal
version checks. Use redacting audit/logger APIs for source- and provider-derived metadata.

Successful routine routing evaluation and stack-skip audit entries are excluded from the dashboard's
five-item recent activity feed before its limit is applied; failures stay visible. Full activity remains
in Settings → Activity. HTTP acceptance means provider acceptance, never runtime health.

## Migration and release gate

Migration `0010_large_salo`, after `0009`, adds routing decisions, binding policy/baseline/hold state and
internal source verification metadata. Existing bindings remain opted out. Back up SQLite consistently
with WAL and retain encryption keys separately before upgrading. Rollback requires stopping workers,
inspecting receivers and restoring the pre-upgrade backup with its keys and matching prior application
version. Restoring state cannot undo external sends and can restore an older replay ledger.

Implementation remains subject to validation and review. Keep final release verification
[#57](https://github.com/uniskela/stack-manager/issues/57) open, including genuine forge-to-receiver
acceptance and the documented release checks. This document makes no CI or release-pass claim.
