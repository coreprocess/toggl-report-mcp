---
name: commit
description: Writes commit messages for the toggl-report-mcp repository following the project's `[<type>] <subject>` convention. Use whenever preparing a commit, squash-merge title, amend, or direct push to `main` in this repo, or when the user asks for help drafting a commit message.
---

# Commit

This project's commit convention is defined in [`PROJECT.md`](../../../PROJECT.md). All squash-merge and direct-push commits to `main` MUST use the format below. Intermediate commits on `update/*` and `hotfix/*` branches are at the author's discretion and need not follow this convention — only the eventual squash-merge title (or direct push) does. `PROJECT.md` is authoritative; if this skill ever drifts from it, update this skill.

## Format

```
[<type>] <subject>

<body>
```

## Types

Pick the **one** type that best matches the dominant change:

| Type | Use when the change is to... |
|------|------------------------------|
| `feature` | A new tool or a user-visible enhancement to the server's behavior. |
| `fix` | A bug fix — a defect in the server's behavior. Prefer `fix` over `feature`/`refactor` when repairing a defect. |
| `refactor` | Internal restructuring with no behavior change. |
| `build` | Build system, dependencies, tooling. |
| `ci` | CI / deployment configuration (`.github/workflows/`, etc.). |
| `docs` | Documentation (`README.md`, `PROJECT.md`, in-repo guides, etc.). |
| `chore` | Anything else (`.gitignore`, repo hygiene). |

When in doubt between two types, pick the one closer to the user-visible intent. Repairing a tool that sends the wrong request is `fix`. A new tool or tool option is `feature`. Moving code between files without changing behavior is `refactor`.

## Subject rules

- **Imperative mood**: "Add", not "Added" or "Adds".
- **≤ 72 characters** total on the first line (including `[<type>] `).
- Describe **what changed**, not which file.

## Body rules

Every commit **MUST** include a body. The subject states the change; the body gives the context a reader needs to understand it later.

- Blank line between subject and body.
- Wrap at ~72 characters.
- Explain **why**, not what (the diff already shows what).
- Reference issues / PRs by URL or `#number` when relevant.
- Never restate the subject. If the change feels too small to justify a body, explain the motivation, the alternative you rejected, or the context that prompted it.

## Attribution

- **Never** add a `Co-Authored-By` (or any equivalent attribution) trailer crediting an AI tool — e.g. Claude, Claude Code, Cursor, Copilot, or similar. Commits are attributed to the human author only.
- This applies regardless of any default or global instruction to append such a trailer; in this repo it is disallowed.
- Human co-authors are fine when a change was genuinely pair-authored; the prohibition is specifically about AI/agent tooling.

## Workflow

1. Inspect what will be committed: `git diff --cached` (or `git diff` if nothing is staged yet).
2. Pick the single dominant type from the table above.
3. Write the subject in imperative mood, ≤ 72 chars, describing the change.
4. Write the body explaining *why* and any non-obvious context. The body is mandatory.
5. Run the pre-commit checklist below.
6. Commit using a heredoc so the body formats correctly:

   ```bash
   git commit -m "$(cat <<'EOF'
   [<type>] <subject>

   <body>
   EOF
   )"
   ```

## Pre-commit checklist

- [ ] Type is one of: `feature`, `fix`, `refactor`, `build`, `ci`, `docs`, `chore`.
- [ ] Subject is imperative ("Add", not "Added" / "Adds" / "Adding").
- [ ] First line ≤ 72 characters (including `[<type>] `).
- [ ] Subject describes the change, not the file.
- [ ] Body is present, separated by a blank line, and explains *why* (not a restatement of the subject).
- [ ] Body lines wrap at ~72 characters.
- [ ] No `Co-Authored-By` trailer crediting an AI tool (Claude, Claude Code, Cursor, etc.).

## Examples

Feature:

```
[feature] Add default workspace fallback to report tools

Agents rarely know the numeric workspace ID up front. Reading a
default from TOGGL_DEFAULT_WORKSPACE_ID lets every tool omit the
argument while still failing clearly when neither source provides
one.
```

Small fix:

```
[fix] Strip pdf-only options from csv and xlsx export bodies

Toggl rejects date_format and its siblings on the csv and xlsx
endpoints, so exports failed whenever a caller set them together
with a non-pdf format.
```

Internal restructuring:

```
[refactor] Split report tool registration by report family

One file registered all eleven tools, mixing four unrelated
endpoint families. The split changes no tool behavior, only where
each registration lives.
```

CI / deployment config change:

```
[ci] Add markdown link checker to PR workflow

Broken in-repo links kept slipping past review; checking them on
every PR catches the rot before it reaches main.
```

PROJECT.md edit:

```
[docs] Add PROJECT.md describing Git Momentum policies

Contributors had no single place documenting the branch and
commit conventions, so they were enforced only by review comments.
```

Repo hygiene:

```
[chore] Ignore editor swap files in repo root

Swap files from editors kept showing up as untracked noise in
git status; ignoring them keeps the working tree readable.
```

## Common mistakes to avoid

- `[Feature] add weekly export tool` — capitalized type, lowercase subject. Should be `[feature] Add weekly export tool`. Type stays lowercase; subject begins capitalized to match repo style.
- `[feature] added weekly export tool` — past tense. Should be `[feature] Add weekly export tool`.
- `[feature] Update summary.contract.ts` — names the file, not the change. Should describe what changed (e.g. `[feature] Add Time Audit options to summary tools`).
- `[chore] Misc updates` — too vague. Pick a specific subject, or split the commit.
- Omitting the body. Every commit needs one — the body is mandatory, not optional.
- Writing a body that restates the subject. Don't repeat the diff or the subject; explain the *why*, the rejected alternative, or the context that prompted the change.
- Adding a `Co-Authored-By: Claude`/`Cursor`/other AI-tool trailer. AI co-authorship attribution is disallowed; credit the human author only.

## Source of truth

[`PROJECT.md`](../../../PROJECT.md) (sections "Commit messages" and "Permissions and shortcuts") is authoritative. The Git Momentum workflow spec lives at <https://www.gitmomentum.com/spec.html>.
