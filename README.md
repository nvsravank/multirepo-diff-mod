# multirepo-diff-mod

A Claude Code mod that shows the changes in **every git repo in a folder** in
one pane.

- `/multi-diff` scans the session's folder. The folder itself is included when
  it is a repo, along with every child folder that has a `.git`.
- `/multi-diff <path>` scans another folder.
- Pick a **repo**, then a **worktree** of it. Detached worktrees are hidden
  until you choose **Show detached**.
- Pick what to **compare**:
  - **Uncommitted vs HEAD**: staged and unstaged changes
  - **Unstaged vs staged**
  - **Staged vs HEAD**
  - **Branch vs base (PR)**: the branch's commits since it left `origin/main`
    (or the repo's default branch)
  - **Changes since this session started**: every change since the
    conversation began, made by Claude or anyone, by any tool (edits, scripts,
    shell commands). When a session starts, the mod takes a git snapshot of
    each repo and worktree in the folder; a resumed conversation keeps its
    snapshot, while `/clear` or a new conversation starts a new one. The
    snapshots live in each repo's `.git` under `refs/multirepo-diff/` and are
    removed after 30 days. Your files, branches and staged changes are never
    touched.
- Changed files show as a tree on the left (☰ hides it), and the selected
  file's diff is on the right. ⟳ rescans, and ☀/☾ switches the diff's colors.

In the Desktop app, long diffs and file lists are shown a page at a time
(Previous/Next), because very large panes stop responding there.

## Install (local)

```bash
claude --plugin-dir /path/to/multirepo-diff-mod
```

Or add the folder to `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of
`~/.claude/settings.json`. Sessions started by the desktop app will then load it,
and it hot-reloads when you edit it.

## What it runs and changes

**It sends nothing anywhere.** The mod makes no network requests and doesn't
read your conversation with Claude. It only reads your files through `git`,
and shows the result in its own pane.

**The only program it runs is `git`**, in the folder you open and the repos and
worktrees inside it. The git commands, and why:

| Command | Why |
| --- | --- |
| `git --version` | Check git works before scanning |
| `git rev-parse` | Find a repo's root, its main checkout, HEAD, and git's own folder paths |
| `git branch --show-current`, `git symbolic-ref`, `git merge-base` | Name the branch and find the base for the pull request view |
| `git worktree list` | List a repo's worktrees |
| `git status`, `git diff`, `git ls-files` | List changed files and show diffs |
| `git read-tree`, `git add -A`, `git write-tree` | Build a session snapshot, using the mod's own index file, never yours |
| `git update-ref`, `git for-each-ref` | Keep and clean up its snapshot refs |

**What it writes, all inside each repo's `.git` folder:**

- **Session snapshots.** When a session starts, it stores a snapshot of the
  repo's files (a git tree) and a ref under `refs/multirepo-diff/` that points
  to it, and deletes its own refs after 30 days.
- **A scratch index file**, `.git/multirepo-diff-index`, used to build those
  snapshots.

It never commits, changes branches, edits your files or touches your staging
area. It also reads the folder you open, one level deep, to find repos, and
remembers your light/dark choice in Claude Code's plugin storage.

**How it hooks into Claude Code:** it adds the `/multi-diff` command and answers
only that command. It watches Claude's file-editing and shell tools only to
refresh its pane after they run; it passes every tool call through unchanged
and never approves, blocks or alters one.

To remove the snapshots from a repo, run
`git for-each-ref --format='%(refname)' refs/multirepo-diff/ | xargs -n1 git update-ref -d`
in it, and delete `.git/multirepo-diff-index`.

## Platforms

Tested on macOS, in the terminal and the Desktop app. It is written to work on
Linux and Windows too, but it has not been tested on Windows yet. If you try it
there, please [open an issue](https://github.com/nvsravank/multirepo-diff-mod/issues/new/choose)
whether it works or not.

## Feedback

Bug reports and feature requests are welcome as
[issues](https://github.com/nvsravank/multirepo-diff-mod/issues/new/choose). This project doesn't accept pull requests;
see [CONTRIBUTING.md](CONTRIBUTING.md). Report security problems privately, as
described in [SECURITY.md](SECURITY.md).

## Develop

```bash
claude plugin validate .
```

```bash
claude plugin test .
```

The Claude Code function-hooks API is in early access and may change between
releases.

## License

MIT. See [LICENSE](LICENSE).
