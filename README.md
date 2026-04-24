# gitfiy

Minimal MCP server for exploring git repositories and learning development patterns from real history.

## What it does

- resolves local repositories and GitHub URLs
- reads files and lists directories
- inspects commits, branches, and diffs
- generates one-shot repository pattern reports

## Quick start

```bash
bun install
bun run build
```

Run locally:

```bash
bun dist/index.mjs
```

## MCP config

Published package:

```json
{
  "mcpServers": {
    "gitfiy": {
      "command": "bunx",
      "args": ["-y", "gitfiy"]
    }
  }
}
```

Local development build:

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

## Tools

- `resolve_repo`
- `list_directory`
- `read_repo_file`
- `git_log`
- `git_show_commit`
- `git_diff_refs`
- `repo_overview`
- `list_branches`
- `pattern_report`

## Release flow

```bash
bun run changeset
bun run version-packages
bun run build
bun run release
```
