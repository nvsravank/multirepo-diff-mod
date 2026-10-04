import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { DiffView, FileChange, Repo } from '../types'

const PANE = 'multi-diff'
const COMMAND = 'multi-diff'

// A Code block takes at most 10000 characters; cap the whole diff too.
const MAX_HUNK_CHARS = 10000
const MAX_DIFF_CHARS = 400000

const root = atom({ plugin: 'multirepo-diff-mod', key: 'root' } as const, '')
const repos = atom({ plugin: 'multirepo-diff-mod', key: 'repos' } as const, [])
const repo = atom({ plugin: 'multirepo-diff-mod', key: 'repo' } as const, '')
const files = atom({ plugin: 'multirepo-diff-mod', key: 'files' } as const, [])
const file = atom({ plugin: 'multirepo-diff-mod', key: 'file' } as const, '')
const diff = atom({ plugin: 'multirepo-diff-mod', key: 'diff' } as const, { kind: 'empty' })
const error = atom({ plugin: 'multirepo-diff-mod', key: 'error' } as const, '')

type $ = EngineInterface

const EMPTY: DiffView = { kind: 'empty' }

const join = (dir: string, name: string) => (dir.endsWith('/') ? dir + name : `${dir}/${name}`)
const baseName = (p: string) => p.replace(/\/+$/, '').split('/').pop() || p

function git($: $, cwd: string, args: string[]) {
  return $.process.run(['git', '--no-pager', ...args], { cwd, timeoutMs: 20000 })
}

// --- discovery -------------------------------------------------------------

async function isRepoRoot($: $, dir: string) {
  const r = await git($, dir, ['rev-parse', '--show-toplevel'])
  return r.exitCode === 0 && r.stdout.trim().replace(/\/+$/, '') === dir.replace(/\/+$/, '')
}

async function describe($: $, path: string, name: string): Promise<Repo> {
  const [branch, status] = await Promise.all([
    git($, path, ['branch', '--show-current']),
    git($, path, ['status', '--porcelain=v1', '-uall', '-z']),
  ])
  return {
    name,
    path,
    branch: branch.stdout.trim() || 'detached',
    changes: parseStatus(status.stdout).length,
  }
}

/** The folder itself (when it is a repo root) plus every child folder holding a `.git`. */
async function discover($: $, dir: string): Promise<Repo[]> {
  const found: Promise<Repo>[] = []
  if (await isRepoRoot($, dir)) found.push(describe($, dir, `${baseName(dir)} (main)`))

  const dirs = (await $.fs.list(dir))
    .filter(one => one.kind === 'directory' && !one.name.startsWith('.') && one.name !== 'node_modules')
    .map(one => one.name)
    .sort((a, b) => a.localeCompare(b))
  const hasGit = await Promise.all(dirs.map(name => $.fs.exists(join(join(dir, name), '.git'))))
  dirs.forEach((name, i) => {
    if (hasGit[i]) found.push(describe($, join(dir, name), name))
  })
  return Promise.all(found)
}

// --- status and diff -------------------------------------------------------

function parseStatus(out: string): FileChange[] {
  const parts = out.split('\0')
  const list: FileChange[] = []
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]
    if (entry.length < 4) continue
    const status = entry.slice(0, 2)
    const path = entry.slice(3)
    // With -z a rename or copy is followed by its original path.
    if (status.includes('R') || status.includes('C')) list.push({ status, path, from: parts[++i] })
    else list.push({ status, path })
  }
  return list
}

/** Splits `git diff` output into hunks the `Code` element draws with format="diff". */
function toView(text: string): DiffView {
  if (!text.trim()) return { kind: 'text', text: 'No textual changes (mode change or empty file).' }
  if (/^Binary files .* differ$/m.test(text) && !text.includes('\n@@')) {
    return { kind: 'text', text: 'Binary file changed.' }
  }
  const isCut = text.length > MAX_DIFF_CHARS
  const lines = (isCut ? text.slice(0, MAX_DIFF_CHARS) : text).split('\n')
  const hunks: string[] = []
  let current: string[] = []
  let size = 0
  const flush = () => {
    if (current.length > 1) hunks.push(current.join('\n'))
    current = []
    size = 0
  }
  for (const raw of lines) {
    const line = raw.slice(0, MAX_HUNK_CHARS - 200)
    if (line.startsWith('@@')) {
      flush()
      current = [line]
      size = line.length
    } else if (line.startsWith('diff --git')) {
      flush()
    } else if (current.length) {
      if (size + line.length + 1 > MAX_HUNK_CHARS) {
        // An oversized hunk continues in a new block under a placeholder header.
        flush()
        current = ['@@ -0,0 +0,0 @@ (continued)']
        size = current[0].length
      }
      current.push(line)
      size += line.length + 1
    }
  }
  flush()
  if (hunks.length === 0) return { kind: 'text', text: text.slice(0, MAX_HUNK_CHARS) }
  return { kind: 'hunks', hunks, isCut }
}

async function fileDiff($: $, cwd: string, change: FileChange): Promise<DiffView> {
  const base = ['diff', '--no-color', '--no-ext-diff', '-M']
  if (change.status === '??') {
    const r = await git($, cwd, [...base, '--no-index', '--', '/dev/null', change.path])
    return toView(r.stdout)
  }
  const paths = change.from ? ['--', change.from, change.path] : ['--', change.path]
  const vsHead = await git($, cwd, [...base, 'HEAD', ...paths])
  if (vsHead.exitCode === 0) return toView(vsHead.stdout)
  // No HEAD yet (fresh repo): staged, then unstaged.
  const [staged, unstaged] = await Promise.all([
    git($, cwd, [...base, '--cached', ...paths]),
    git($, cwd, [...base, ...paths]),
  ])
  return toView(`${staged.stdout}\n${unstaged.stdout}`)
}

// --- actions ---------------------------------------------------------------

async function showFile($: $, path: string) {
  await update($, file, () => path)
  const cwd = await read($, repo)
  const change = (await read($, files)).find(one => one.path === path)
  if (!cwd || !change) {
    await update($, diff, () => EMPTY)
    return
  }
  let view: DiffView
  try {
    view = await fileDiff($, cwd, change)
  } catch (err) {
    view = { kind: 'text', text: `Could not load diff: ${String(err)}` }
  }
  await update($, diff, () => view)
}

async function showRepo($: $, path: string) {
  await update($, repo, () => path)
  const status = await git($, path, ['status', '--porcelain=v1', '-uall', '-z'])
  if (status.exitCode !== 0) {
    await update($, files, () => [])
    await update($, diff, () => EMPTY)
    await update($, error, () => status.stderr.trim() || 'git status failed')
    return
  }
  await update($, error, () => '')
  const list = parseStatus(status.stdout).sort((a, b) => a.path.localeCompare(b.path))
  await update($, files, () => list)
  if (list.length === 0) {
    await update($, file, () => '')
    await update($, diff, () => EMPTY)
    return
  }
  const keep = await read($, file)
  await showFile($, list.some(one => one.path === keep) ? keep : list[0].path)
}

async function refresh($: $, dir?: string) {
  const where = dir || (await read($, root)) || (await $.session.cwd())
  await update($, root, () => where)
  try {
    // A broken git (e.g. macOS's Xcode stub before its license is accepted)
    // would otherwise look like "no repos found".
    const probe = await git($, where, ['--version'])
    if (probe.exitCode !== 0) {
      await update($, repos, () => [])
      await update($, files, () => [])
      await update($, error, () => `git is not usable: ${(probe.stderr || probe.stdout).trim()}`)
      return
    }
    const found = await discover($, where)
    await update($, repos, () => found)
    if (found.length === 0) {
      await update($, files, () => [])
      await update($, error, () => `No git repositories found in ${where}`)
      return
    }
    const current = await read($, repo)
    await showRepo($, found.some(one => one.path === current) ? current : found[0].path)
  } catch (err) {
    await update($, error, () => String(err))
  }
}

// --- drawing ---------------------------------------------------------------

const STATUS_COLOR: Record<string, string> = {
  M: 'yellow',
  A: 'green',
  '?': 'green',
  D: 'red',
  R: 'cyan',
  C: 'cyan',
  U: 'magenta',
}

function statusLetter(status: string) {
  if (status === '??') return '?'
  const s = status.trim()
  return s.length ? s[0] : '·'
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Browse uncommitted changes across every git repo in this folder',
    })
    return next(e)
  })

  // `/multi-diff` scans the session's folder; `/multi-diff <dir>` scans another.
  on('command.run', { command: COMMAND }, async ($, e) => {
    const arg = e.args.trim()
    const target = arg.startsWith('/') ? arg : arg ? join(await $.session.cwd(), arg) : await $.session.cwd()
    await refresh($, target)
    await $.ui.open({ id: PANE, title: 'Multi-repo diff', focus: true })
    const found = await read($, repos)
    return { text: `Multi-repo diff: ${found.length} repo(s) in ${target}.` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Text, Button, Code } = table
    // Mobile has no Select; it shows the repo name instead.
    const Select = 'Select' in table ? table.Select : null

    const [repoList, current, list, selected, view, problem, where] = await Promise.all([
      read($, repos),
      read($, repo),
      read($, files),
      read($, file),
      read($, diff),
      read($, error),
      read($, root),
    ])

    const cols = e.props.bodyColumns || e.viewport?.columns || 100
    const isWide = cols >= 70
    const leftWidth = isWide ? Math.max(24, Math.min(48, Math.floor(cols * 0.3))) : cols
    const active = repoList.find(one => one.path === current)

    const options = repoList.map(one => ({
      value: one.path,
      label: `${one.name}  [${one.branch}]  ${one.changes ? `${one.changes} changed` : 'clean'}`,
    }))

    const header = (
      <Box flexDirection="row" gap={2} alignItems="center">
        {options.length > 0 && Select ? (
          <Select
            key="repo"
            label="Repo: "
            options={options}
            value={current || options[0].value}
            autoFocus
            onSelect={value => void showRepo($, value)}
          />
        ) : (
          <Text bold>{active ? active.name : 'Multi-repo diff'}</Text>
        )}
        <Button key="refresh" hotkey="r" onPress={() => void refresh($)}>
          Refresh
        </Button>
      </Box>
    )

    const fileList = (
      <Box flexDirection="column" width={leftWidth} flexShrink={0}>
        <Text dimColor>
          {list.length} changed file{list.length === 1 ? '' : 's'}
        </Text>
        {list.map((change, i) => {
          const letter = statusLetter(change.status)
          const isOn = change.path === selected
          return (
            <Box flexDirection="row" gap={1}>
              <Text color={STATUS_COLOR[letter] ?? 'gray'} bold>
                {letter}
              </Text>
              <Button key={`file-${i}`} plain dimColor={!isOn} onPress={() => void showFile($, change.path)}>
                {(isOn ? '▸ ' : '') + change.path}
              </Button>
            </Box>
          )
        })}
      </Box>
    )

    const diffBody =
      view.kind === 'hunks' ? (
        <Box flexDirection="column" gap={1}>
          {view.hunks.map(hunk => (
            <Code source={hunk} format="diff" path={selected} wrap="truncate-end" />
          ))}
          {view.isCut && <Text dimColor>Diff truncated: too large to show in full.</Text>}
        </Box>
      ) : view.kind === 'text' ? (
        <Text dimColor>{view.text}</Text>
      ) : (
        <Text dimColor>Pick a file on the left.</Text>
      )

    return (
      <Box flexDirection="column" gap={1}>
        {header}
        {problem ? <Text color="red">{problem}</Text> : null}
        {!problem && repoList.length > 0 && list.length === 0 ? (
          <Text dimColor>Working tree clean in {active?.name ?? baseName(where)}.</Text>
        ) : null}
        {list.length > 0 && (
          <Box flexDirection={isWide ? 'row' : 'column'} gap={2}>
            {fileList}
            <Box flexDirection="column" flexGrow={1} flexShrink={1}>
              <Text bold wrap="truncate-middle">
                {selected || ' '}
              </Text>
              {diffBody}
            </Box>
          </Box>
        )}
      </Box>
    )
  })
}
