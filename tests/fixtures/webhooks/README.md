# Native push fixtures

Published payload examples, retained with their provider-specific fields. Only `ref` and
`repository.clone_url` are adapted to the local test repository. Signatures use synthetic keys.

- GitHub: <https://github.com/octokit/webhooks/blob/main/payload-examples/api.github.com/push/with-new-branch.payload.json>
- Gitea: <https://github.com/go-gitea/gitea/blob/v1.20.0/docs/content/doc/usage/webhooks.en-us.md>
- Forgejo: <https://forgejo.org/docs/latest/user/repository/webhooks/>

Header behavior is independently checked against the official current docs through Context7.
Gitea v1.24.0 `services/webhook/deliver.go` also confirms native bare SHA-256 and compatibility
headers. These are deterministic contract fixtures, not a claim of live provider testing.
