# gitfiy

`gitfiy` is a minimal Model Context Protocol (MCP) server for repository exploration and learning team patterns from real git history.

It can:
- clone/cache a GitHub repository URL
- list directories and read files
- inspect commit history/messages
- show commit diffs and compare refs
- provide a quick repo overview

## Install

```bash
bun install
```

## Current status

Validated locally:
- `bun run typecheck` ✅
- `bun run build` ✅

## Build

```bash
bun run build
```

`obuild` bundles the server into a single executable file at `dist/index.mjs`.

## Run locally

```bash
bun run start
```

or during development:

```bash
bun run dev
```

## npx usage

After publishing:

```bash
npx gitfiy
```

Before publishing, run from this project:

```bash
npx gitfiy@file:.
```

or directly:

```bash
bun dist/index.mjs
```

## Example MCP client config

### Use local build (recommended while developing)

```json
{
  "mcpServers": {
    "gitfiy-local": {
      "command": "bun",
      "args": ["/absolute/path/to/gitfiy/dist/index.mjs"]
    }
  }
}
```

### Use npm package (after publish)

```json
{
  "mcpServers": {
    "gitfiy": {
      "command": "npx",
      "args": ["-y", "gitfiy"]
    }
  }
}
```

## Tools exposed

- `resolve_repo`
- `list_directory`
- `read_repo_file`
- `git_log`
- `git_show_commit`
- `git_diff_refs`
- `repo_overview`
- `list_branches`
- `pattern_report`

## How to use in an AI client

1. Add one of the MCP configs above to your client settings.
2. Restart/reload the client so the server is discovered.
3. Ask the agent to call tools, for example:
   - "Run `resolve_repo` for `https://github.com/unjs/obuild`"
   - "Run `repo_overview` for that repo"
   - "Show last 20 commits with `git_log`"
   - "Compare `main...HEAD` with `git_diff_refs`"
   - "Read `src/index.ts` with `read_repo_file`"

## Notes

- GitHub URL repos are cloned locally into `~/.cache/gitfiy`.
- Local path repos are used in-place (must already be a git repo).
- Use `sync: true` in `resolve_repo` to fetch latest remote updates.
- This project is Bun-first for local runtime and development.

## Changesets and GitHub Actions release

This repo is configured for Changesets release flow:
- `.changeset/config.json` tracks versioning config.
- `.github/workflows/release.yml` creates release PRs and publishes from `main`.
- Add a changeset with:

```bash
bun run changeset
```

Required GitHub repository setup:
- Create repo: `https://github.com/nees/gitfiy`
- Add repository secret: `NPM_TOKEN` (npm automation token with publish access)
- Keep default `GITHUB_TOKEN` enabled for Actions
