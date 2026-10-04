# multirepo-diff-mod

A Claude Code mod that shows uncommitted changes across **every git repo in a
folder** in one pane.

- `/multi-diff` scans the session's folder. The folder itself is included when
  it is a repo, along with every child folder that has a `.git`.
- `/multi-diff <path>` scans another folder.
- Pick a repo from the dropdown. Changed files are listed on the left, and the
  selected file's diff is on the right.
- Press `r` (or **Refresh**) to rescan.

The diff is shown against `HEAD`, so it includes both staged and unstaged
changes. Untracked files show as new files.

## Install (local)

```bash
claude --plugin-dir /path/to/multirepo-diff-mod
```

Or add the folder to `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of
`~/.claude/settings.json`. Sessions started by the desktop app will then load it,
and it hot-reloads when you edit it.

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
