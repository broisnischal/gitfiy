#!/usr/bin/env bun

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

const execFileAsync = promisify(execFile);
const DEFAULT_MAX_TEXT_SIZE = 200_000;
const DEFAULT_MAX_ENTRIES = 200;
const DEFAULT_MAX_COMMITS = 30;
const CACHE_DIR = process.env.GITFIY_CACHE_DIR ?? join(homedir(), ".cache", "gitfiy");

type RepoResolution = {
  repoRoot: string;
  source: "local" | "cached";
  original: string;
};

function isGitUrl(input: string): boolean {
  return /^https?:\/\/github\.com\/[^/]+\/[^/]+(?:\.git)?(?:\/)?$/i.test(input.trim());
}

function toCacheFolderName(repo: string): string {
  const normalized = repo.trim().replace(/\.git\/?$/i, "").replace(/\/$/, "");
  const repoName = normalized.split("/").slice(-2).join("_");
  const hash = createHash("sha1").update(normalized).digest("hex").slice(0, 8);
  return `${repoName}_${hash}`;
}

function safeResolveInRepo(repoRoot: string, targetPath: string): string {
  const resolved = resolve(repoRoot, targetPath || ".");
  const repoRootWithSep = `${resolve(repoRoot)}${process.platform === "win32" ? "\\" : "/"}`;
  if (resolved !== resolve(repoRoot) && !resolved.startsWith(repoRootWithSep)) {
    throw new Error("Path escapes repository root.");
  }
  return resolved;
}

async function runGit(args: string[], cwd: string): Promise<string> {
  const { stdout, stderr } = await execFileAsync("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 });
  if (stderr && stderr.trim()) {
    return `${stdout}${stderr}`;
  }
  return stdout;
}

async function ensureLocalClone(repoUrl: string, sync: boolean): Promise<string> {
  const folder = join(CACHE_DIR, toCacheFolderName(repoUrl));
  await mkdir(CACHE_DIR, { recursive: true });
  if (!existsSync(folder)) {
    await runGit(["clone", "--filter=blob:none", repoUrl, folder], process.cwd());
    return folder;
  }
  if (sync) {
    await runGit(["fetch", "--all", "--prune"], folder);
  }
  return folder;
}

async function resolveRepo(repo: string, sync: boolean): Promise<RepoResolution> {
  if (isGitUrl(repo)) {
    const repoRoot = await ensureLocalClone(repo, sync);
    return { repoRoot, source: "cached", original: repo };
  }

  const repoRoot = resolve(repo);
  if (!existsSync(repoRoot)) {
    throw new Error(`Path does not exist: ${repoRoot}`);
  }
  if (!existsSync(join(repoRoot, ".git"))) {
    throw new Error(`Not a git repository: ${repoRoot}`);
  }
  return { repoRoot, source: "local", original: repo };
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function toLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function topEntries<K>(entries: Map<K, number>, limit: number): Array<{ key: K; count: number }> {
  return [...entries.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key, count]) => ({ key, count }));
}

const server = new McpServer({
  name: "gitfiy",
  version: "0.1.0",
});

server.registerTool(
  "resolve_repo",
  {
    title: "Resolve Repository",
    description: "Resolve a local git path or clone/cache a GitHub repository URL.",
    inputSchema: z.object({
      repo: z.string().describe("Local git repo path OR GitHub HTTPS URL."),
      sync: z.boolean().default(true).describe("Fetch latest remote changes for cached repositories."),
    }),
  },
  async ({ repo, sync }) => {
    const resolved = await resolveRepo(repo, sync);
    return textResult(
      JSON.stringify(
        {
          repoRoot: resolved.repoRoot,
          source: resolved.source,
          original: resolved.original,
        },
        null,
        2,
      ),
    );
  },
);

server.registerTool(
  "list_directory",
  {
    title: "List Directory",
    description: "List files and folders at a repository path.",
    inputSchema: z.object({
      repo: z.string(),
      path: z.string().default("."),
      includeHidden: z.boolean().default(false),
      maxEntries: z.number().int().positive().max(1_000).default(DEFAULT_MAX_ENTRIES),
    }),
  },
  async ({ repo, path, includeHidden, maxEntries }) => {
    const { repoRoot } = await resolveRepo(repo, false);
    const absPath = safeResolveInRepo(repoRoot, path);
    const dirents = await readdir(absPath, { withFileTypes: true });
    const entries = dirents
      .filter((entry) => includeHidden || !entry.name.startsWith("."))
      .slice(0, maxEntries)
      .map((entry) => ({
        name: entry.name,
        type: entry.isDirectory() ? "dir" : entry.isFile() ? "file" : "other",
      }));
    return textResult(JSON.stringify({ repoRoot, path, entries }, null, 2));
  },
);

server.registerTool(
  "read_repo_file",
  {
    title: "Read Repository File",
    description: "Read a text file from the repository with optional output truncation.",
    inputSchema: z.object({
      repo: z.string(),
      path: z.string(),
      maxChars: z.number().int().positive().max(1_000_000).default(DEFAULT_MAX_TEXT_SIZE),
    }),
  },
  async ({ repo, path, maxChars }) => {
    const { repoRoot } = await resolveRepo(repo, false);
    const absPath = safeResolveInRepo(repoRoot, path);
    const content = await readFile(absPath, "utf8");
    const truncated = content.length > maxChars ? `${content.slice(0, maxChars)}\n... [truncated]` : content;
    return textResult(truncated);
  },
);

server.registerTool(
  "git_log",
  {
    title: "Git Log",
    description: "Show commit history including hash, author, date, and message.",
    inputSchema: z.object({
      repo: z.string(),
      limit: z.number().int().positive().max(200).default(DEFAULT_MAX_COMMITS),
      ref: z.string().default("HEAD"),
    }),
  },
  async ({ repo, limit, ref }) => {
    const { repoRoot } = await resolveRepo(repo, false);
    const format = "%H%x1f%an%x1f%ad%x1f%s";
    const output = await runGit(
      ["log", `--max-count=${limit}`, "--date=iso-strict", `--pretty=format:${format}`, ref],
      repoRoot,
    );
    const commits = output
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [hash, author, date, subject] = line.split("\u001f");
        return { hash, author, date, subject };
      });
    return textResult(JSON.stringify({ ref, commits }, null, 2));
  },
);

server.registerTool(
  "git_show_commit",
  {
    title: "Show Commit",
    description: "Show a commit with patch, metadata, and file stats.",
    inputSchema: z.object({
      repo: z.string(),
      commit: z.string().default("HEAD"),
      maxChars: z.number().int().positive().max(1_000_000).default(DEFAULT_MAX_TEXT_SIZE),
    }),
  },
  async ({ repo, commit, maxChars }) => {
    const { repoRoot } = await resolveRepo(repo, false);
    const output = await runGit(
      ["show", "--patch", "--date=iso-strict", "--pretty=fuller", "--stat", commit],
      repoRoot,
    );
    const truncated = output.length > maxChars ? `${output.slice(0, maxChars)}\n... [truncated]` : output;
    return textResult(truncated);
  },
);

server.registerTool(
  "git_diff_refs",
  {
    title: "Diff Refs",
    description: "Show patch diff and stat between two refs (branches, tags, or commits).",
    inputSchema: z.object({
      repo: z.string(),
      base: z.string(),
      head: z.string().default("HEAD"),
      maxChars: z.number().int().positive().max(1_000_000).default(DEFAULT_MAX_TEXT_SIZE),
    }),
  },
  async ({ repo, base, head, maxChars }) => {
    const { repoRoot } = await resolveRepo(repo, false);
    const output = await runGit(["diff", "--patch", "--stat", `${base}...${head}`], repoRoot);
    const truncated = output.length > maxChars ? `${output.slice(0, maxChars)}\n... [truncated]` : output;
    return textResult(truncated || "(no diff)");
  },
);

server.registerTool(
  "repo_overview",
  {
    title: "Repository Overview",
    description: "Summarize project structure, top-level file types, and recent commits.",
    inputSchema: z.object({
      repo: z.string(),
      maxDirs: z.number().int().positive().max(100).default(20),
      maxExtensions: z.number().int().positive().max(100).default(20),
      commitCount: z.number().int().positive().max(100).default(10),
    }),
  },
  async ({ repo, maxDirs, maxExtensions, commitCount }) => {
    const { repoRoot } = await resolveRepo(repo, false);
    const rootEntries = await readdir(repoRoot, { withFileTypes: true });
    const topDirectories = rootEntries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .slice(0, maxDirs)
      .map((entry) => entry.name);

    const extensionCount = new Map<string, number>();
    for (const entry of rootEntries) {
      if (!entry.isFile()) {
        continue;
      }
      const ext = extname(entry.name) || "<no-ext>";
      extensionCount.set(ext, (extensionCount.get(ext) ?? 0) + 1);
    }

    const commitOutput = await runGit(
      ["log", `--max-count=${commitCount}`, "--date=short", "--pretty=format:%h %ad %s"],
      repoRoot,
    );

    const extensionSummary = [...extensionCount.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, maxExtensions)
      .map(([ext, count]) => ({ ext, count }));

    return textResult(
      JSON.stringify(
        {
          repoRoot,
          repoName: basename(repoRoot),
          topDirectories,
          topLevelExtensions: extensionSummary,
          recentCommits: commitOutput.split("\n").filter(Boolean),
        },
        null,
        2,
      ),
    );
  },
);

server.registerTool(
  "list_branches",
  {
    title: "List Branches",
    description: "List local and remote branches in the repository.",
    inputSchema: z.object({
      repo: z.string(),
    }),
  },
  async ({ repo }) => {
    const { repoRoot } = await resolveRepo(repo, false);
    const output = await runGit(["branch", "-a", "--no-color"], repoRoot);
    return textResult(output);
  },
);

server.registerTool(
  "pattern_report",
  {
    title: "Pattern Report",
    description:
      "Generate one-shot report of architecture, commit conventions, hotspots, and coding patterns from git history.",
    inputSchema: z.object({
      repo: z.string().describe("Local git repo path OR GitHub HTTPS URL."),
      sync: z.boolean().default(false).describe("Fetch latest updates for cached GitHub repositories."),
      commitWindow: z.number().int().positive().max(500).default(200),
      topFiles: z.number().int().positive().max(50).default(12),
      topContributors: z.number().int().positive().max(20).default(8),
      topExtensions: z.number().int().positive().max(20).default(10),
    }),
  },
  async ({ repo, sync, commitWindow, topFiles, topContributors, topExtensions }) => {
    const resolved = await resolveRepo(repo, sync);
    const { repoRoot } = resolved;

    const [recentCommitsRaw, rootEntries, trackedFilesRaw, churnRaw, authorsRaw] = await Promise.all([
      runGit(
        ["log", `--max-count=${commitWindow}`, "--date=short", "--pretty=format:%h%x1f%an%x1f%ad%x1f%s"],
        repoRoot,
      ),
      readdir(repoRoot, { withFileTypes: true }),
      runGit(["ls-files"], repoRoot),
      runGit(["log", `--max-count=${commitWindow}`, "--name-only", "--pretty=format:"], repoRoot),
      runGit(["shortlog", "-sn", `--max-count=${commitWindow}`], repoRoot),
    ]);

    const recentCommits = toLines(recentCommitsRaw).map((line) => {
      const [hash, author, date, subject] = line.split("\u001f");
      return { hash, author, date, subject };
    });

    const topDirectories = rootEntries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .slice(0, 20);

    const extensionCount = new Map<string, number>();
    for (const file of toLines(trackedFilesRaw)) {
      const extension = extname(file) || "<no-ext>";
      extensionCount.set(extension, (extensionCount.get(extension) ?? 0) + 1);
    }

    const fileChurnCount = new Map<string, number>();
    for (const file of toLines(churnRaw)) {
      fileChurnCount.set(file, (fileChurnCount.get(file) ?? 0) + 1);
    }

    const commitPrefixCount = new Map<string, number>();
    for (const commit of recentCommits) {
      const subject = commit.subject ?? "";
      const prefixMatch = subject.match(/^([a-z]+)(\(.+\))?!?:\s/i);
      const prefix = prefixMatch ? prefixMatch[1].toLowerCase() : "other";
      commitPrefixCount.set(prefix, (commitPrefixCount.get(prefix) ?? 0) + 1);
    }

    const contributors = toLines(authorsRaw).slice(0, topContributors).map((line) => {
      const match = line.match(/^(\d+)\s+(.+)$/);
      if (!match) {
        return { author: line, commits: 0 };
      }
      return { author: match[2], commits: Number(match[1]) };
    });

    const architecture = {
      topDirectories,
      commonExtensions: topEntries(extensionCount, topExtensions).map((item) => ({
        extension: item.key,
        count: item.count,
      })),
    };

    const hotspots = topEntries(fileChurnCount, topFiles).map((item) => ({
      path: item.key,
      touches: item.count,
    }));

    const commitConventions = {
      prefixUsage: topEntries(commitPrefixCount, 10).map((item) => ({
        prefix: item.key,
        count: item.count,
      })),
      sampleMessages: recentCommits.slice(0, 12).map((commit) => commit.subject),
    };

    const codingPatterns = {
      dominantLanguagesByExtension: architecture.commonExtensions,
      likelyStyleSignals: [
        commitConventions.prefixUsage.some((item) => item.prefix !== "other")
          ? "Conventional-commit style appears in history."
          : "Conventional-commit prefixes are not dominant.",
        topDirectories.includes("src") ? "Code is primarily organized under src/." : "No dominant src/ directory.",
      ],
    };

    return textResult(
      JSON.stringify(
        {
          repo: {
            input: repo,
            resolvedPath: repoRoot,
            source: resolved.source,
          },
          window: { commitWindow },
          architecture,
          commitConventions,
          hotspots,
          contributors,
          codingPatterns,
        },
        null,
        2,
      ),
    );
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("gitfiy server running on stdio");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exit(1);
});
