# Getting started

This guide assumes stack-manager is running (see [Installation](installation.md)).

## 1. Create the admin account

Open the app. The first visit starts setup:

1. Choose an admin username and a password of at least 12 characters. If you set `STACK_MANAGER_SETUP_TOKEN`, enter it
   here as well.
2. Create a **workspace**. A workspace usually matches one Compose estate, such as "Homelab" or "Production".
3. Connect your first repository (next step).

Setup can only happen once. After that, `/setup` redirects to sign-in.

## 2. Connect a repository

stack-manager works with GitHub, Gitea and Forgejo over HTTPS.

1. Create an access token on your Git server for the repository. Read access is enough for now; write access will be
   needed once committing from stack-manager is available.
2. In stack-manager, choose **Connect repository** and fill in:
   - **Git provider** and the **HTTPS clone URL**. Never put the token in the URL.
   - **Access token** (or a saved credential), plus a **username** only if your server requires one with the token.
3. Choose **Test connection**, then pick the **default branch** from the branches it found.
4. Choose **Connect repository**. The token is encrypted before it is stored, and the first **fetch** starts in the
   background.

A self-hosted Gitea or Forgejo on your LAN needs `STACK_MANAGER_ALLOW_PRIVATE_NETWORKS=true`. Loopback and cloud
metadata addresses are always blocked.

## 3. Add stacks

After the first successful fetch, the repository page lists every folder that contains a Compose file
(`compose.yaml`, `compose.yml`, `docker-compose.yaml` or `docker-compose.yml`). Pick the ones you want and optionally
rename them. Nothing is added automatically, and adding a stack never changes your repository.

Each stack is a folder plus its Compose file, so one repository can hold many stacks. See
[Stack discovery](STACK_DISCOVERY.md) for the rules.

## 4. Work on a stack

Open a stack from **Stacks**. It has these tabs:

| Tab | What it's for |
| --- | --- |
| **Editor** | Browse files in the explorer, open them in tabs and edit with syntax highlighting. Compose files are validated as you type and issues appear in the problems panel. **Save draft** (Ctrl+S / ⌘S) keeps your edit on the server. |
| **Docs** | Read the stack's Markdown files rendered (README first), follow links between them and edit them as drafts. |
| **Environment** | Variables the Compose file references, whether `.env.example` documents them, env files it expects, and values that look like hard-coded secrets. Values are never shown. |
| **Changes** | Every draft as a line-by-line diff against the fetched commit. Discard the drafts you don't want. |
| **Settings** | Rename the stack, change its Compose file or remove it (files and drafts are kept). |

Files that look like secrets (`.env`, private keys, certificates, anything in a `secrets/` folder) are listed but
can't be opened or edited.

### Drafts

Drafts are stored in stack-manager's database and never leave the server. If the file changes in Git after you start a
draft, the editor warns you, so you don't overwrite someone else's change unknowingly.

Committing and pushing drafts to Git is the next feature on the [roadmap](plans/MVP_PLAN.md).

## 5. Keep it up to date

Use **Fetch now** on the repository page to pull the latest commits from your Git server. The editor, docs and environment
views always read from the fetched commit plus your drafts.
