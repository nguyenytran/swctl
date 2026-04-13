# swctl

`swctl` is a pure Bash CLI for managing Shopware 6 Git worktrees with Docker or OrbStack, Traefik routing, MariaDB/Redis shared infra, and an ANSI-only TUI dashboard.

## Features

- `swctl init` bootstraps shared local infra: `swctl-proxy`, Traefik v3, MariaDB, and Redis.
- `swctl create <issue> <branch>` creates a Git worktree, inspects the Git diff against your base branch, chooses a DB strategy, writes `.env.local`, and starts the app container with Traefik labels.
- `swctl batch create` provisions multiple worktrees at once from CLI pairs, a text file, or open GitLab MRs / GitHub PRs. Supports `--parallel` for concurrent creation.
- `swctl logs`, `restart`, and `open` give quick access to container logs, restarts, and browser opening.
- `swctl status`, `exec`, and `clean` manage worktrees safely and idempotently.
- `swctl tui` provides a full-screen menu with live worktree/container/database stats.
- `swctl dashboard` shows live CPU, memory, DB sizes, and worktree state every 5 seconds.
- Works with plain Bash on macOS and Linux. `gum`, `fzf`, and `jq` are optional enhancements only.

## File Layout

Put these files in your repository or package them with Homebrew:

- `swctl`
- `.swctl.conf.example`
- `docker-compose.swctl.yml`
- `README.md`

The project-specific `.swctl.conf` should live in the Shopware repository root. `swctl` auto-detects it from the current directory upward.

## Quick Start

1. Copy the example config into your Shopware project:

   ```bash
   cp .swctl.conf.example /path/to/shopware/.swctl.conf
   ```

2. Edit `.swctl.conf`:

   - Set `SW_PROJECT` and `SW_DOMAIN_SUFFIX`.
   - Point `SW_PHP_IMAGE` at your PHP image with `bash`, `php`, `composer`, and your frontend tooling.
   - Adjust `SW_BASE_BRANCH` and `SW_INSTALL_ARGS` if your setup needs non-default install flags.

3. Make the CLI executable:

   ```bash
   chmod +x swctl
   ```

4. Start shared infra:

   ```bash
   ./swctl init
   ```

5. Create a worktree:

   ```bash
   ./swctl create 1245 feature/SW-1245
   ```

6. Open the routed domain:

   ```text
   http://<SW_PROJECT>-1245.<SW_DOMAIN_SUFFIX>
   ```

## How `swctl create` Decides What To Provision

`swctl create` runs:

```bash
git diff <BASE_BRANCH>...<branch> --name-only
```

Then it counts:

- `Migration/` or `Migrations/` changes
- `Entity/` changes
- Frontend changes matching `*.js`, `*.vue`, `*.scss`, `*.ts`, `*.twig`

Decision matrix:

- If migration or entity changes are present:
  - create a dedicated database for the issue
  - run `system:install`
- If no schema-touching changes are present:
  - reuse the shared project database
  - run `dal:refresh:index`
  - run `cache:clear`
- If frontend changes are present:
  - run `bundle:dump`
  - run `theme:compile --active-only`
- If no frontend changes are present:
  - skip frontend build steps

This keeps worktree provisioning fast while isolating schema-heavy changes.

## Commands

### `swctl init`

Creates or starts:

- Docker network `swctl-proxy`
- Traefik container `swctl-traefik`
- MariaDB container `swctl-mariadb`
- Redis container `swctl-redis`

The command is idempotent and safe to rerun.

### `swctl create <issue> <branch>`

- Finds `.swctl.conf` in the current directory tree
- Creates or attaches a Git worktree
- Generates `.env.local`
- Starts the `app` service with Traefik labels
- Writes instance metadata under:

  ```text
  ~/.local/state/swctl/instances
  ```

### `swctl status`

Prints:

- issue id
- project slug
- routed domain
- container status
- DB state (`shared` or `dedicated`)

If you run it inside a configured repository, it filters to that project. Outside a repo, it shows every tracked instance.

### `swctl exec <issue> '<cmd>'`

Runs a shell command inside the issue's `app` container:

```bash
./swctl exec 1245 'bin/console plugin:list'
```

### `swctl batch create`

Creates multiple worktrees in one command. Three input sources are supported:

**CLI pairs:**

```bash
./swctl batch create 1245 feature/SW-1245 1300 bugfix/SW-1300
```

**From a file** (one `ISSUE BRANCH` per line, `#` comments allowed):

```bash
./swctl batch create --file issues.txt
```

**From GitLab or GitHub** (requires `jq`):

```bash
./swctl batch create --gitlab 12345
./swctl batch create --github your-org/shopware
```

For GitHub, run `swctl auth login` to authenticate. For GitLab, set `SWCTL_GITLAB_TOKEN` in your environment or `.swctl.conf`. The command presents an interactive selection list when using API sources.

**Parallel mode** creates worktrees concurrently:

```bash
./swctl batch create --parallel --jobs 4 --file issues.txt
```

Each parallel job runs in an isolated subshell. A file lock serializes shared-database bootstrapping to prevent race conditions.

### `swctl logs <issue> [--follow|-f]`

Shows the last 100 lines of the app container logs, or follows live output with `--follow`:

```bash
./swctl logs 1245
./swctl logs 1245 --follow
```

### `swctl restart <issue>`

Restarts the app container without tearing down or reprovisioning:

```bash
./swctl restart 1245
```

### `swctl open <issue>`

Opens the worktree URL in the default browser:

```bash
./swctl open 1245
```

### `swctl clean <issue>`

Stops the compose project, removes labeled `vendor-*` and `node_modules-*` volumes, drops dedicated databases, and removes the Git worktree. Shared databases are intentionally preserved.

### `swctl tui`

The TUI menu uses pure ANSI sequences and works in a normal terminal. Menu options:

- `1` init infra
- `2` create worktree
- `3` status
- `4` exec inside a container
- `5` clean a worktree
- `6` open the live dashboard
- `7` tail container logs
- `8` restart a container
- `9` open worktree URL in browser
- `r` refresh
- `q` quit

If `gum` is installed, prompt inputs become nicer. If `fzf` is installed, issue selection uses fuzzy filtering.

### `swctl dashboard`

Refreshes every 5 seconds and shows:

- `docker stats` for all `swctl`-managed containers
- database sizes from MariaDB
- tracked worktree status

Exit with `Ctrl+C`.

## Docker and OrbStack Notes

- Routing pattern: `<SW_PROJECT>-<issue>.<SW_DOMAIN_SUFFIX>`
- Example: `sw66-1245.sw66.localhost`
- The app service always joins the external network `swctl-proxy`
- DB access defaults to `host.docker.internal:3306`, which works with OrbStack and Docker Desktop
- `docker-compose.swctl.yml` mounts:
  - worktree source as a bind mount
  - `vendor-<issue>` as a named volume
  - `node_modules-<issue>` as a named volume

## Homebrew Packaging

### Build a local release tarball

```bash
make release VERSION=0.1.0
```

That creates:

```text
dist/swctl-0.1.0.tar.gz
```

The target also prints a SHA256 checksum.

### Local tap setup

1. Build the tarball:

   ```bash
   make release VERSION=0.1.0
   ```

2. Update `Formula/swctl.rb` with the printed SHA256 if it still contains a placeholder.

3. Create or reuse a tap:

   ```bash
   brew tap-new your-user/local
   ```

4. Copy the formula into the tap:

   ```bash
   cp Formula/swctl.rb "$(brew --repo your-user/local)/Formula/swctl.rb"
   ```

5. Install:

   ```bash
   brew install --build-from-source your-user/local/swctl
   ```

The formula currently uses a `file://` URL for local testing. To publish, switch the `url` to a GitHub Releases archive and replace `sha256`.

## Troubleshooting

### Traefik route does not resolve

- Run `./swctl init` again and confirm `swctl-traefik` is running.
- Check the Traefik dashboard at [http://localhost:8080](http://localhost:8080).
- Verify the generated host matches `<SW_PROJECT>-<issue>.<SW_DOMAIN_SUFFIX>`.

### MariaDB is unreachable

- Confirm port `3306` is free on the host.
- Check `docker logs swctl-mariadb`.
- Make sure `.swctl.conf` uses the same root password you used during `swctl init`.

### `system:install` fails

- Your image may be missing PHP extensions or CLI tooling.
- Override `SW_INSTALL_ARGS` in `.swctl.conf` with the exact flags your project needs.
- Test manually with:

  ```bash
  ./swctl exec 1245 'bin/console system:install --help'
  ```

### Composer or Node commands fail

- Ensure `SW_PHP_IMAGE` includes `composer` and the relevant Node package manager.
- `swctl` will warn and continue, but the app container will not be usable until the image is fixed.

### Worktree cleanup leaves Git state behind

- Check `git worktree list` in the project root.
- If the path was manually deleted first, run:

  ```bash
  git worktree prune
  ```

## Suggested Project Workflow

```bash
./swctl init
./swctl create 1245 feature/SW-1245
./swctl open 1245
./swctl logs 1245 --follow
./swctl exec 1245 'bin/console cache:clear'
./swctl restart 1245
./swctl status
./swctl tui
./swctl clean 1245
```

### Batch QA workflow

```bash
./swctl init
./swctl batch create --parallel --file qa-issues.txt
./swctl status
./swctl batch create --gitlab 12345      # select MRs interactively
./swctl batch create --github org/repo   # select PRs interactively
```
