# Getting started

This guide assumes stack-manager is running (see [Installation](installation.md)).

## 1. Create the admin account

Open the app. The first visit starts setup:

1. Choose an admin username and a password of at least 12 characters. If you set `STACK_MANAGER_SETUP_TOKEN`, enter it
   here as well.
2. Create a **workspace**. A workspace usually matches one Compose estate, such as "Homelab" or "Production".
3. Connect your first repository (next step).

Setup can only happen once. After that, `/setup` redirects to sign-in.

After sign-in, the sidebar lists **Dashboard**, **Stacks**, **Repositories** and **Settings** (in that order). The
**Dashboard** is your workspace home: a quick overview and the main path to connect a repository when the workspace
is empty. **Settings** has **General**, **Credentials**, **Activity** and **Account** tabs for workspace options,
saved tokens, the audit log, your Git author identity, password and sessions.

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

Every folder that contains a Compose file (`compose.yaml`, `compose.yml`, `docker-compose.yaml` or
`docker-compose.yml`) becomes a stack. By default this happens automatically after each fetch, so new stacks you
commit show up without any clicks. Folders named `node_modules`, `vendor`, `dist`, `build` or CI folders such as
`.github` are skipped. Adding a stack never changes your repository, and a folder that disappears keeps its stack
until you remove it.

To choose stacks yourself, turn off **Add new stacks automatically** on the repository page. The page then lists the
folders (25 per page, with a filter for large repositories), and you can **Add all** at once, tick individual folders
and rename them, or add a folder by path.

Each stack is a folder plus its Compose file, so one repository can hold many stacks. See
[Stack discovery](STACK_DISCOVERY.md) for the rules.

## 4. Work on a stack

### Find a stack

The **Stacks** page lists every stack by repository, then by the folder that contains it (`apps/media`,
`services/auth`). Numbers sort the way you'd read them, so `3-network` comes before `10-core`. Each repository shows
its stack and draft counts, plus a status if its last fetch failed or it hasn't been fetched yet.

- **Search** matches stack names, repository names and paths. Every word must match (`media plex`). Press `/` to jump
  to the search box, Esc to clear it, and ↓ to move into the list; ↑ and ↓ then move between groups and stacks.
- **Filters** narrow the list to stacks **with drafts**, stacks whose repository **needs attention**, or one
  repository.
- **Sort** by name, path or most drafts. **Group** by folder (the default), by repository only, or not at all.
- **Expand all** and **Collapse all** open or fold every repository. Collapsed groups stay that way while you browse
  and open again whenever a search or filter is active, so nothing is hidden.

The search, filters, sort and grouping are kept in the page address, so Back, reload and a shared link show the same
list. On a phone they sit behind **Filters**.

Inside a stack, the breadcrumb (**Stacks › repository › stack**) takes you back to the list as you left it, and
**Switch stack** jumps to another stack in the same repository without leaving the tab you're on.

### Stack tabs

Each stack has these tabs:

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

Committing drafts, safe push and Git history ship in v0.5.0; see the [roadmap](plans/MVP_PLAN.md).

## 5. Files outside stacks

Not everything lives in a stack folder: a root `README.md`, a `docs/` folder or a shared `.env.example` belong to the
whole repository. The repository page has tabs for them:

| Tab | What it's for |
| --- | --- |
| **Overview** | Fetch status, stacks, branches and the credential. |
| **Files** | The whole repository in the same editor as a stack, with the same draft and secret-file rules. |
| **Docs** | Every Markdown file in the repository, grouped by folder, rendered and editable as drafts. |
| **Changes** | Every draft in the repository, including the ones made inside stacks. |

## 6. Keep it up to date

Use **Fetch now** on the repository page to pull the latest commits from your Git server. The editor, docs and environment
views always read from the fetched commit plus your drafts.
