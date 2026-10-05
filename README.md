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
  - **This Claude session**: files Claude edited in this session, against their
    content before its first edit
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
