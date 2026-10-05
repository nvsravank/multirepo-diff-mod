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

The mod makes no network requests and sends no data anywhere. On your machine
it does the following:

- **Runs `git`** in the folder you open and in the repos and worktrees inside
  it, to list repos, worktrees and changed files and to produce diffs.
- **Reads the folder listing** of the folder you open, one level deep, to find
  repos.
- **Writes session snapshots into each repo's `.git` folder.** When a session
  starts, it stores a snapshot of the repo's files (a git tree) and a ref under
  `refs/multirepo-diff/` that points to it. It deletes its own refs after 30
  days. It never commits, changes branches, edits your files or touches your
  staging area.
- **Writes a temporary git index file** per checkout in your system's temp
  folder (`TMPDIR`, `TEMP` or `TMP`), under `multirepo-diff-mod/`, to build those
  snapshots.
- **Remembers your light/dark choice** in Claude Code's plugin storage.

To remove the snapshots from a repo, run
`git for-each-ref --format='%(refname)' refs/multirepo-diff/ | xargs -n1 git update-ref -d`
in it.

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
