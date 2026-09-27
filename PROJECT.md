# Project Guideline

This project follows the [Git Momentum](https://www.gitmomentum.com) workflow. For workflow rules, see the [specification](https://www.gitmomentum.com/spec.html). This document defines the project-specific policies.

---

## Names

| Item | Value |
|------|-------|
| Trunk branch | `main` |
| Deployment branches | _none_ |
| Update branch pattern | `update/<YYYYMMDD>-<short-description>` or `update/<YYYYMMDD>-<ticket-id>-<short-description>` |
| Hotfix branch pattern | `hotfix/<YYYYMMDD>-<short-description>` or `hotfix/<YYYYMMDD>-<ticket-id>-<short-description>` |

The ticket-id segment is optional; the date is always required. This repository ships a locally-run stdio MCP server and has no deployment branches.

---

## Conventions

### Commit messages

When committing with an AI agent, use the [commit skill](.claude/skills/commit/SKILL.md), which encodes the rules below.

Squash-merge and direct-push commits to `main` MUST follow:

```
[<type>] <subject>

<body>
```

**Types:**

| Type | When to use |
|------|-------------|
| `feature` | A new tool or a user-visible enhancement to the server's behavior. |
| `fix` | Bug fix (a defect in the server's behavior). |
| `refactor` | Internal restructuring with no behavior change. |
| `build` | Build system, dependencies, tooling. |
| `ci` | CI configuration. |
| `docs` | Documentation (`README.md`, `PROJECT.md`, in-repo guides, etc.). |
| `chore` | Anything else (`.gitignore`, repo hygiene). |

**Subject rules:**
- Imperative mood ("Add", not "Added").
- ≤ 72 characters on the first line.
- Describes what changed, not which file.

**Body:** mandatory, blank line above. Explains *why* and any non-obvious context; never just restates the subject.

**Example:**

```
[feature] Add default workspace fallback to report tools

Agents rarely know the numeric workspace ID up front. Reading a
default from TOGGL_DEFAULT_WORKSPACE_ID lets every tool omit the
argument while still failing clearly when neither source provides
one.
```

### Version tags

When tagging with an AI agent, use the [version skill](.claude/skills/version/SKILL.md), which encodes the rules below and the major / minor / patch decision logic.

Pattern: `v<major>.<minor>.<patch>` (matched by `v[0-9]*`).

Tags are created manually by the [maintainer](MAINTAINERS.md) on release-worthy commits. The version of any commit is derived with:

```
git describe --tags --candidates=100 --match='v[0-9]*' --abbrev=4
```

---

## Permissions and shortcuts

| Item | Policy |
|------|--------|
| Direct push to `main` | Allowed for the [maintainer](MAINTAINERS.md). The pushed commit MUST follow the commit message convention. |

---

## Review

| Item | Policy |
|------|--------|
| Update PRs | May be self-merged by the [maintainer](MAINTAINERS.md). PRs from external contributors require [maintainer](MAINTAINERS.md) review and approval. |
| Hotfix PRs | May be self-merged by the [maintainer](MAINTAINERS.md). |

---

## Repository layout

```
toggl-report-mcp/
├── src/
│   ├── main.ts        Composition root; stdio entry point.
│   ├── config/        Environment-driven configuration.
│   ├── errors/        Structured tool error type and codes.
│   ├── toggl/         Toggl HTTP client (retries, rate limiting, error mapping)
│   │                  and workspace resolution.
│   ├── store/         Local export-file store (filename sanitizing, atomic writes).
│   └── reports/       Filter schemas, shared result helpers and the MCP tool
│                      registrations.
├── .github/workflows/ CI running the full check suite.
└── dist/              Bundled server (build output, not committed).
```

---

## Automation

GitHub Actions CI runs typecheck, lint, test, knip and build on pushes to `main` and on pull requests. No deployment pipelines. The server is built locally with `pnpm build` and run from `dist/main.js` by an MCP client.

---

## Feature flags

Not used in this project. The server is configured entirely through environment variables; there are no runtime-gated features.
