import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { DiffMode, DiffView, FileChange, Repo, Theme, Worktree } from '../types'
import { toRows } from './diff'
import { DIFF, baseName, isAbsolute, join, parseNameStatus, parseStatus, parseWorktrees, pathKey, toBlocks, samePath, toSlash, toTree, toView, untracked } from './parse'

const PANE = 'multi-diff'
const COMMAND = 'multi-diff'

const root = atom({ plugin: 'multirepo-diff-mod', key: 'root' } as const, '')
const repos = atom({ plugin: 'multirepo-diff-mod', key: 'repos' } as const, [])
const repo = atom({ plugin: 'multirepo-diff-mod', key: 'repo' } as const, '')
const worktrees = atom({ plugin: 'multirepo-diff-mod', key: 'worktrees' } as const, [])
const worktree = atom({ plugin: 'multirepo-diff-mod', key: 'worktree' } as const, '')
const showDetached = atom({ plugin: 'multirepo-diff-mod', key: 'showDetached' } as const, false)
const mode = atom({ plugin: 'multirepo-diff-mod', key: 'mode' } as const, 'head')
const note = atom({ plugin: 'multirepo-diff-mod', key: 'note' } as const, '')
const files = atom({ plugin: 'multirepo-diff-mod', key: 'files' } as const, [])
const file = atom({ plugin: 'multirepo-diff-mod', key: 'file' } as const, '')
const diff = atom({ plugin: 'multirepo-diff-mod', key: 'diff' } as const, { kind: 'empty' })
const error = atom({ plugin: 'multirepo-diff-mod', key: 'error' } as const, '')
const isListCollapsed = atom({ plugin: 'multirepo-diff-mod', key: 'isListCollapsed' } as const, false)
const collapsedDirs = atom({ plugin: 'multirepo-diff-mod', key: 'collapsedDirs' } as const, [])
const theme = atom({ plugin: 'multirepo-diff-mod', key: 'theme' } as const, 'light')
const diffPage = atom({ plugin: 'multirepo-diff-mod', key: 'diffPage' } as const, 0)
const treePage = atom({ plugin: 'multirepo-diff-mod', key: 'treePage' } as const, 0)

type Engine = EngineInterface

const EMPTY: DiffView = { kind: 'empty' }

const MODES: readonly { value: DiffMode; label: string; empty: string }[] = [
  { value: 'head', label: 'Uncommitted vs HEAD', empty: 'No uncommitted changes' },
  { value: 'unstaged', label: 'Unstaged vs staged', empty: 'No unstaged changes' },
  { value: 'staged', label: 'Staged vs HEAD', empty: 'Nothing is staged' },
  { value: 'base', label: 'Branch vs base (PR)', empty: 'No commits ahead of the base' },
  { value: 'session', label: 'Changes since this session started', empty: 'No changes since this session started' },
]


function git($: Engine, cwd: string, args: string[], env?: Record<string, string>, timeoutMs = 20000) {
  return $.process.run(['git', '--no-pager', ...args], { cwd, env, timeoutMs })
}

// --- discovery -------------------------------------------------------------

async function isRepoRoot($: Engine, dir: string) {
  const r = await git($, dir, ['rev-parse', '--show-toplevel'])
  return r.exitCode === 0 && samePath(r.stdout.trim(), dir)
}

/** The main checkout a repo or linked worktree belongs to (its common .git's folder). */
async function mainCheckout($: Engine, path: string) {
  const r = await git($, path, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  const common = toSlash(r.stdout.trim())
  return r.exitCode === 0 && common.endsWith('/.git') ? common.slice(0, -'/.git'.length) : path
}

/**
 * The folder itself (when it is a repo root) plus every child folder holding
 * a `.git`. A linked worktree of a repo already listed is left out: it shows
 * in that repo's worktree picker instead.
 */
async function discover($: Engine, dir: string): Promise<Repo[]> {
  const candidates: Repo[] = []
  if (await isRepoRoot($, dir)) candidates.push({ name: `${baseName(dir)} (main)`, path: dir })

  const dirs = (await $.fs.list(dir))
    // Symlinked folders list as `other`; the `.git` check below sorts them out.
    .filter(one => one.kind !== 'file' && !one.name.startsWith('.') && one.name !== 'node_modules')
    .map(one => one.name)
    .sort((a, b) => a.localeCompare(b))
  const hasGit = await Promise.all(dirs.map(name => $.fs.exists(join(join(dir, name), '.git'))))
  dirs.forEach((name, i) => {
    if (hasGit[i]) candidates.push({ name, path: join(dir, name) })
  })

  const mains = await Promise.all(candidates.map(one => mainCheckout($, one.path)))
  return candidates.filter((one, i) => samePath(mains[i], one.path) || !candidates.some(other => samePath(other.path, mains[i])))
}

/** Every worktree of the repo, its main checkout first. */
async function listWorktrees($: Engine, repoPath: string): Promise<Worktree[]> {
  const r = await git($, repoPath, ['worktree', 'list', '--porcelain'])
  const list = r.exitCode === 0 ? parseWorktrees(r.stdout) : []
  return list.length ? list : [{ path: repoPath, branch: null, sha: '' }]
}

/** What HEAD is in a checkout, for the comparison line: the branch, or "detached at <sha>". */
async function headLabel($: Engine, cwd: string) {
  const [branch, sha] = await Promise.all([
    git($, cwd, ['branch', '--show-current']),
    git($, cwd, ['rev-parse', '--short', 'HEAD']),
  ])
  const short = sha.exitCode === 0 ? sha.stdout.trim() : ''
  return { name: branch.stdout.trim() || (short ? `detached at ${short}` : 'no commits yet'), sha: short }
}

// --- the base of a branch --------------------------------------------------

type Base = { ref: string; sha: string }

/**
 * Where this branch left the default branch: the merge base of HEAD and the
 * remote's default branch (origin/HEAD), else origin/main, origin/master,
 * main or master, the first that exists.
 */
async function findBase($: Engine, cwd: string): Promise<Base | null> {
  const remoteHead = await git($, cwd, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
  const candidates = [remoteHead.stdout.trim(), 'origin/main', 'origin/master', 'main', 'master']
  for (const ref of [...new Set(candidates.filter(Boolean))]) {
    const exists = await git($, cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
    if (exists.exitCode !== 0) continue
    const mergeBase = await git($, cwd, ['merge-base', 'HEAD', ref])
    if (mergeBase.exitCode === 0) return { ref, sha: mergeBase.stdout.trim() }
  }
  return null
}

// --- changed files per mode ------------------------------------------------

type Listing = { files: FileChange[]; note: string; error?: string }


async function listChanges(
  $: Engine,
  cwd: string,
  mode: DiffMode,
): Promise<Listing> {
  // The comparison line (row 4): what is compared with what, on which branch.
  const head = await headLabel($, cwd)
  const at = head.sha ? ` (${head.sha})` : ''
  const note = {
    head: `${head.name}: working tree vs HEAD${at}`,
    unstaged: `${head.name}: working tree vs staging area`,
    staged: `${head.name}: staging area vs HEAD${at}`,
    base: '',
    session: '',
  }[mode]
  const fail = (r: { stderr: string }, what: string): Listing => ({
    files: [],
    note,
    error: r.stderr.trim() || `${what} failed`,
  })

  if (mode === 'head') {
    const r = await git($, cwd, ['status', '--porcelain=v1', '-uall', '-z'])
    return r.exitCode === 0 ? { files: parseStatus(r.stdout), note } : fail(r, 'git status')
  }

  if (mode === 'unstaged') {
    const [changed, fresh] = await Promise.all([
      git($, cwd, ['diff', '--name-status', '-z', '-M']),
      git($, cwd, ['ls-files', '--others', '--exclude-standard', '-z']),
    ])
    if (changed.exitCode !== 0) return fail(changed, 'git diff')
    return { files: [...parseNameStatus(changed.stdout), ...untracked(fresh.stdout)], note }
  }

  if (mode === 'staged') {
    const r = await git($, cwd, ['diff', '--cached', '--name-status', '-z', '-M'])
    return r.exitCode === 0 ? { files: parseNameStatus(r.stdout), note } : fail(r, 'git diff --cached')
  }

  if (mode === 'base') {
    const base = await findBase($, cwd)
    if (!base) {
      return { files: [], note: '', error: 'No base branch found (looked for origin/HEAD, origin/main, origin/master, main, master).' }
    }
    const r = await git($, cwd, ['diff', '--name-status', '-z', '-M', base.sha, 'HEAD'])
    if (r.exitCode !== 0) return fail(r, 'git diff')
    return {
      files: parseNameStatus(r.stdout),
      note: `${head.name} vs ${base.ref}: commits since merge base ${base.sha.slice(0, 7)} (uncommitted changes not included)`,
    }
  }

  // session: the snapshot from the session's start vs the files now
  const base = await baseline($, cwd)
  const now = await writeTree($, cwd)
  const r = await git($, cwd, ['diff', '--name-status', '-z', '-M', base.tree, now])
  if (r.exitCode !== 0) return fail(r, 'git diff')
  const since = base.isLate ? 'when this pane first saw this checkout' : 'this session started'
  return {
    files: parseNameStatus(r.stdout).map(one => ({ ...one, trees: { base: base.tree, now } })),
    note: `${head.name}: every change since ${since}, by Claude or anyone (snapshot ${base.tree.slice(0, 7)})`,
  }
}

// --- one file's diff -------------------------------------------------------

async function fileDiff($: Engine, cwd: string, mode: DiffMode, change: FileChange): Promise<DiffView> {
  const paths = change.from ? ['--', change.from, change.path] : ['--', change.path]

  if (mode === 'session' && change.trees) {
    const r = await git($, cwd, [...DIFF, change.trees.base, change.trees.now, ...paths])
    return toView(r.stdout)
  }

  if (change.status === '??') {
    const r = await git($, cwd, [...DIFF, '--no-index', '--', '/dev/null', change.path])
    return toView(r.stdout)
  }

  if (mode === 'unstaged') return toView((await git($, cwd, [...DIFF, ...paths])).stdout)
  if (mode === 'staged') return toView((await git($, cwd, [...DIFF, '--cached', ...paths])).stdout)

  if (mode === 'base') {
    const base = await findBase($, cwd)
    if (!base) return { kind: 'text', text: 'No base branch found.' }
    return toView((await git($, cwd, [...DIFF, base.sha, 'HEAD', ...paths])).stdout)
  }

  // head
  const vsHead = await git($, cwd, [...DIFF, 'HEAD', ...paths])
  if (vsHead.exitCode === 0) return toView(vsHead.stdout)
  // No HEAD yet (fresh repo): staged, then unstaged.
  const [staged, unstaged] = await Promise.all([
    git($, cwd, [...DIFF, '--cached', ...paths]),
    git($, cwd, [...DIFF, ...paths]),
  ])
  return toView(`${staged.stdout}\n${unstaged.stdout}`)
}

// --- actions ---------------------------------------------------------------

// Loads overlap (a slow base lookup, a refresh after an edit, quick clicks), so
// each load takes a ticket and only the newest one may write its result.
// Module variables are fine here: a reload just starts the count over.
let listTicket = 0
let diffTicket = 0

async function showFile($: Engine, path: string) {
  const ticket = ++diffTicket
  await update($, file, () => path)
  await update($, diffPage, () => 0)
  const [cwd, current, list] = await Promise.all([read($, worktree), read($, mode), read($, files)])
  const change = list.find(one => one.path === path)
  if (!cwd || !change) {
    if (ticket === diffTicket) await update($, diff, () => EMPTY)
    return
  }
  let view: DiffView
  try {
    view = await fileDiff($, cwd, current, change)
  } catch (err) {
    view = { kind: 'text', text: `Could not load diff: ${String(err)}` }
  }
  if (ticket === diffTicket) await update($, diff, () => view)
}

/** Lists the changes of one checkout: the repo's main path or one of its worktrees. */
async function showTree($: Engine, wanted: string) {
  const ticket = ++listTicket
  // Worktrees come and go (added, moved, removed) outside the pane, so the
  // picker's list is reloaded on every load rather than only on a repo pick,
  // and a worktree that is gone falls back to the main checkout.
  let path = wanted
  const repoPath = await read($, repo)
  if (repoPath) {
    const trees = await listWorktrees($, repoPath)
    await update($, worktrees, () => trees)
    // Use git's own spelling of the path, so it matches the picker's options.
    path = (trees.find(one => samePath(one.path, path)) ?? trees[0]).path
  }
  await update($, worktree, () => path)
  const current = await read($, mode)
  let listing: Listing
  try {
    listing = await listChanges($, path, current)
  } catch (err) {
    listing = { files: [], note: '', error: String(err) }
  }
  // A newer load started meanwhile: drop this stale result.
  if (ticket !== listTicket) return
  await update($, treePage, () => 0)
  await update($, note, () => listing.note)
  await update($, error, () => listing.error ?? '')
  const list = [...listing.files].sort((a, b) => a.path.localeCompare(b.path))
  await update($, files, () => list)
  if (list.length === 0) {
    await update($, file, () => '')
    await update($, diff, () => EMPTY)
    return
  }
  const keep = await read($, file)
  await showFile($, list.some(one => one.path === keep) ? keep : list[0].path)
}

/**
 * Picks a repo: loads its worktrees and shows the main checkout, or `keep`
 * when that is one of its worktrees (so a refresh stays on the same one).
 */
async function selectRepo($: Engine, repoPath: string, keep?: string) {
  await update($, repo, () => repoPath)
  const trees = await listWorktrees($, repoPath)
  await update($, worktrees, () => trees)
  const kept = keep ? trees.find(one => samePath(one.path, keep)) : undefined
  await showTree($, (kept ?? trees[0]).path)
}

async function setMode($: Engine, next: DiffMode) {
  await update($, mode, () => next)
  const current = await read($, worktree)
  // No repo picked yet (e.g. right after a restart): rescan and pick one.
  if (current) await showTree($, current)
  else await refresh($)
}

async function refresh($: Engine, dir?: string) {
  const where = toSlash(dir || (await read($, root)) || (await $.session.cwd()))
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
    const [current, tree] = await Promise.all([read($, repo), read($, worktree)])
    await selectRepo($, (found.find(one => samePath(one.path, current)) ?? found[0]).path, tree)
  } catch (err) {
    await update($, error, () => String(err))
  }
}

async function toggleTheme($: Engine) {
  const next = await update($, theme, current => (current === 'light' ? 'dark' : 'light'))
  await $.store.set(THEME_STORE_KEY, next)
}

/** Shows or hides detached worktrees in the picker; hiding moves off one. */
async function toggleDetached($: Engine) {
  const isShowing = await update($, showDetached, shown => !shown)
  if (isShowing) return
  const [trees, current] = await Promise.all([read($, worktrees), read($, worktree)])
  const viewed = trees.find((one, i) => i > 0 && samePath(one.path, current))
  if (viewed && !viewed.branch) await showTree($, trees[0].path)
}

async function toggleList($: Engine) {
  await update($, isListCollapsed, hidden => !hidden)
}

async function toggleDir($: Engine, path: string) {
  await update($, collapsedDirs, list => (list.includes(path) ? list.filter(one => one !== path) : [...list, path]))
}

// --- session snapshots -----------------------------------------------------
//
// "Changes since this session started" compares each checkout with a git
// snapshot taken when the conversation began: a tree of every file (tracked,
// plus untracked ones .gitignore doesn't exclude), written through a temporary
// index so the real staging area, branches and files are never touched. A ref
// under refs/multirepo-diff/ keeps git from pruning it.
//
// Snapshots are keyed by the session's start time, which stays the same when
// a conversation is resumed after a restart, and starts over on /clear or in a
// new conversation.

const SNAPSHOT_REFS = 'refs/multirepo-diff'

// Snapshots older than this are deleted when a new one is taken.
const SNAPSHOT_KEEP_MS = 30 * 24 * 60 * 60 * 1000

// A snapshot taken this soon after the session started counts as taken at its start.
const SESSION_START_GRACE_MS = 2 * 60 * 1000

// Writing a tree of a big checkout can take a while.
const WRITE_TREE_TIMEOUT_MS = 120_000

/**
 * Writes the checkout's files as they are now into git's store; returns the
 * tree id. It uses a throwaway index file inside the checkout's own git folder
 * (git rev-parse --git-path gives it, worktrees included), seeded from HEAD so
 * git only hashes what changed. The real index is never touched.
 */
async function writeTree($: Engine, cwd: string) {
  const indexPath = await git($, cwd, ['rev-parse', '--path-format=absolute', '--git-path', 'multirepo-diff-index'])
  if (indexPath.exitCode !== 0) throw new Error(indexPath.stderr.trim() || 'git rev-parse failed')
  const env = { GIT_INDEX_FILE: indexPath.stdout.trim() }
  await git($, cwd, ['read-tree', 'HEAD'], env) // fails harmlessly in a repo with no commits
  const added = await git($, cwd, ['add', '-A'], env, WRITE_TREE_TIMEOUT_MS)
  if (added.exitCode !== 0) throw new Error(added.stderr.trim() || 'git add failed')
  const tree = await git($, cwd, ['write-tree'], env)
  if (tree.exitCode !== 0) throw new Error(tree.stderr.trim() || 'git write-tree failed')
  return tree.stdout.trim()
}

/** This session's snapshot ref for a checkout. */
async function snapshotRef($: Engine, cwd: string) {
  const { startedAt } = await $.session.usage()
  return `${SNAPSHOT_REFS}/${startedAt}/${pathKey(cwd)}`
}

/**
 * The checkout's snapshot from this session's start, taking it now if there is
 * none (`isLate`: the checkout wasn't seen when the session started).
 */
async function baseline($: Engine, cwd: string, isAtStart = false) {
  const ref = await snapshotRef($, cwd)
  const found = await git($, cwd, ['rev-parse', '--verify', '--quiet', ref])
  if (found.exitCode === 0) return { tree: found.stdout.trim(), isLate: false }
  const tree = await writeTree($, cwd)
  await git($, cwd, ['update-ref', ref, tree])
  await pruneSnapshots($, cwd)
  return { tree, isLate: !isAtStart }
}

/** Deletes this repo's snapshots from sessions that started more than SNAPSHOT_KEEP_MS ago. */
async function pruneSnapshots($: Engine, cwd: string) {
  const now = await $.clock.now()
  const refs = await git($, cwd, ['for-each-ref', '--format=%(refname)', SNAPSHOT_REFS])
  for (const ref of refs.stdout.split('\n').filter(Boolean)) {
    const startedAt = Number(ref.slice(SNAPSHOT_REFS.length + 1).split('/')[0])
    if (startedAt && now - startedAt > SNAPSHOT_KEEP_MS) await git($, cwd, ['update-ref', '-d', ref])
  }
}

/** Takes the session-start snapshot of every checkout in the folder that has none yet. */
async function snapshotFolder($: Engine, dir: string) {
  // session.start also fires when the mod reloads mid-session; a snapshot
  // taken then is honest only as "since the pane first saw it".
  const [{ startedAt }, now] = await Promise.all([$.session.usage(), $.clock.now()])
  const isAtStart = now - startedAt < SESSION_START_GRACE_MS
  for (const found of await discover($, dir)) {
    for (const tree of await listWorktrees($, found.path)) {
      await baseline($, tree.path, isAtStart).catch(() => undefined)
    }
  }
}

/** After a tool that may change files runs, refresh the open view so the change shows. */
async function refreshAfter($: Engine, e: object, next: (e: never) => Promise<unknown>) {
  const result = await next(e as never)
  const current = await read($, worktree)
  if (current) await showTree($, current).catch(() => undefined)
  return result
}

// --- presses and picks -----------------------------------------------------

// The desktop app (engine 2.1.286) logs "ui_press not handled" for presses
// that should reach a Button's onPress closure, so every control in the pane
// is also answered here by its key, at the ui.press / ui.select events.

async function handlePress($: Engine, key: string) {
  if (key === 'refresh') await refresh($)
  else if (key === 'theme') await toggleTheme($)
  else if (key === 'files') await toggleList($)
  else if (key === 'detached') await toggleDetached($)
  else if (key.startsWith('dir:')) await toggleDir($, key.slice('dir:'.length))
  else if (key.startsWith('file:')) await showFile($, key.slice('file:'.length))
  else if (key.startsWith('prev-')) await turnPage($, -1)
  else if (key.startsWith('next-')) await turnPage($, 1)
  else if (key === 'tree-prev') await turnTreePage($, -1)
  else if (key === 'tree-next') await turnTreePage($, 1)
}

async function turnTreePage($: Engine, by: number) {
  await update($, treePage, n => Math.max(0, n + by))
}

async function turnPage($: Engine, by: number) {
  await update($, diffPage, n => Math.max(0, n + by))
}

async function handleSelect($: Engine, key: string, value: string) {
  if (key === 'repo') await selectRepo($, value)
  else if (key === 'worktree') await showTree($, value)
  else if (key === 'mode') await setMode($, value as DiffMode)
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

// Desktop only. The terminal draws diffs with Claude Code's own `Code
// format="diff"`, but the desktop app (engine 2.1.286) draws that as plain
// text, so there the pane draws its own rows: a tinted row, a stronger tint on
// the words that changed, a colored marker and line number, and a text color
// of the palette's own. Plugins aren't told the app's theme, so the person
// picks with the ☀/☾ toggle. Solid hex only: the desktop did not draw rgba().
type RowLook = { mark: string; background?: string; word?: string; marker?: string; number?: string; text?: string }
type Looks = Record<'add' | 'del' | 'context', RowLook>

const LOOKS: Record<Theme, Looks> = {
  light: {
    add: { mark: '+', background: '#e6ffec', word: '#abf2bc', marker: '#1a7f37', number: '#1a7f37', text: '#1f2328' },
    del: { mark: '-', background: '#ffebe9', word: '#ffc1bc', marker: '#cf222e', number: '#cf222e', text: '#1f2328' },
    context: { mark: ' ' },
  },
  dark: {
    add: { mark: '+', background: '#1c3a27', word: '#2f6b40', marker: '#7ee787', number: '#7ee787', text: '#e6edf3' },
    del: { mark: '-', background: '#4b1e24', word: '#80303a', marker: '#ff8a80', number: '#ff8a80', text: '#e6edf3' },
    context: { mark: ' ' },
  },
}

const THEME_STORE_KEY = 'theme'

// The bar between the file tree and the diff, per palette.
const SEPARATOR: Record<Theme, string> = { light: '#d0d7de', dark: '#3d444d' }

// Diff rows drawn per page on desktop. Past ~300 rows in one drawing the
// desktop stops applying redraws and the pane's controls go dead.
const PAGE_ROWS = 150

// File-tree rows (folders and files) drawn per page, for the same reason.
const TREE_ROWS = 60

function statusLetter(status: string) {
  if (status === '??') return '?'
  const s = status.trim()
  return s.length ? s[0] : '·'
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // Restore the light/dark pick saved in an earlier session.
    const saved = await $.store.get(THEME_STORE_KEY)
    if (saved === 'light' || saved === 'dark') await update($, theme, () => saved)
    await $.command.register({
      name: COMMAND,
      description: 'Browse uncommitted changes across every git repo in this folder',
    })
    // Snapshot every checkout in the folder for "Changes since this session
    // started". Off the startup path, so the first prompt doesn't wait on git.
    // A resumed session already has its snapshots and keeps them.
    $.clock.after(0, () => void snapshotFolder($, toSlash(e.cwd)).catch(() => undefined))
    return next(e)
  })

  // `/multi-diff` scans the session's folder; `/multi-diff <dir>` scans another.
  on('command.run', { command: COMMAND }, async ($, e) => {
    const arg = e.args.trim()
    const target = toSlash(isAbsolute(arg) ? arg : arg ? join(await $.session.cwd(), arg) : await $.session.cwd())
    await refresh($, target)
    await $.ui.open({ id: PANE, title: 'Multi-repo diff', focus: true })
    const found = await read($, repos)
    return { text: `Multi-repo diff: ${found.length} repo(s) in ${target}.` }
  })

  // Refresh the open view after the tools that can change files, shell commands included.
  on('tool.call', { tool: 'Edit' }, ($, e, next) => refreshAfter($, e, next as never))
  on('tool.call', { tool: 'MultiEdit' }, ($, e, next) => refreshAfter($, e, next as never))
  on('tool.call', { tool: 'Write' }, ($, e, next) => refreshAfter($, e, next as never))
  on('tool.call', { tool: 'NotebookEdit' }, ($, e, next) => refreshAfter($, e, next as never))
  on('tool.call', { tool: 'Bash' }, ($, e, next) => refreshAfter($, e, next as never))

  // Answer the pane's controls by key instead of relying on their closures.
  on('ui.press', { requestId: PANE }, async ($, e) => {
    await handlePress($, e.element)
    return { element: e.element }
  })
  on('ui.select', { requestId: PANE }, async ($, e) => {
    await handleSelect($, e.element, e.value)
    return { element: e.element, value: e.value }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Text, Button, Code } = table
    // Mobile has no Select; it shows the repo name instead.
    const Select = 'Select' in table ? table.Select : null

    const [repoList, current, currentMode, about, list, selected, view, problem, where, isListHidden, foldedDirs, colorTheme, page, treeAt, trees, activeTree, isShowingDetached] =
      await Promise.all([
        read($, repos),
        read($, repo),
        read($, mode),
        read($, note),
        read($, files),
        read($, file),
        read($, diff),
        read($, error),
        read($, root),
        read($, isListCollapsed),
        read($, collapsedDirs),
        read($, theme),
        read($, diffPage),
        read($, treePage),
        read($, worktrees),
        read($, worktree),
        read($, showDetached),
      ])

    const cols = e.props.bodyColumns || e.viewport?.columns || 100
    const isWide = cols >= 70
    const leftWidth = isWide ? Math.max(24, Math.min(48, Math.floor(cols * 0.3))) : cols
    const active = repoList.find(one => one.path === current)
    const modeInfo = MODES.find(one => one.value === currentMode) ?? MODES[0]

    const repoOptions = repoList.map(one => ({ value: one.path, label: one.name }))
    // Detached worktrees (no branch checked out, e.g. scratch checkouts) are
    // hidden unless asked for. The main checkout always shows, and so does
    // the worktree being viewed.
    const detachedCount = trees.filter((one: Worktree, i: number) => i > 0 && !one.branch).length
    const treeOptions = trees
      .map((one: Worktree, i: number) => ({ one, i }))
      .filter(({ one, i }) => i === 0 || one.branch || isShowingDetached || one.path === activeTree)
      .map(({ one, i }) => ({
        value: one.path,
        label: `${i === 0 ? 'main checkout' : baseName(one.path)} — ${one.branch ?? `detached at ${one.sha}`}`,
      }))
    const fileCount = `${list.length} file${list.length === 1 ? '' : 's'} changed`

    // Four rows: repo and pane controls; worktree; compare mode and count;
    // what exactly is being compared.
    const header = (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" justifyContent="space-between" alignItems="center">
          <Box flexDirection="row" gap={2} alignItems="center" flexShrink={1}>
            <Button key="files" plain onPress={() => void toggleList($)}>
              ☰
            </Button>
            {repoOptions.length > 0 && Select ? (
              <Select
                key="repo"
                label="Repo: "
                options={repoOptions}
                value={current || repoOptions[0].value}
                autoFocus
                onSelect={value => void selectRepo($, value)}
              />
            ) : (
              <Text bold>{active ? active.name : 'Multi-repo diff'}</Text>
            )}
          </Box>
          <Box flexDirection="row" gap={1} alignItems="center">
            <Button key="refresh" plain onPress={() => void refresh($)}>
              ⟳
            </Button>
            {/* Shows the mode a press switches to: ☾ while light, ☀ while dark. */}
            {e.surface !== 'terminal' && (
              <Button key="theme" plain onPress={() => void toggleTheme($)}>
                {colorTheme === 'light' ? '☾' : '☀'}
              </Button>
            )}
          </Box>
        </Box>
        {treeOptions.length > 0 && Select ? (
          <Box flexDirection="row" gap={2} alignItems="center">
            <Select
              key="worktree"
              label="Worktree: "
              options={treeOptions}
              value={activeTree || treeOptions[0].value}
              onSelect={value => void showTree($, value)}
            />
            {detachedCount > 0 && (
              <Button key="detached" plain dimColor onPress={() => void toggleDetached($)}>
                {isShowingDetached ? 'Hide detached' : `Show detached (${detachedCount})`}
              </Button>
            )}
          </Box>
        ) : null}
        <Box flexDirection="row" justifyContent="space-between" alignItems="center">
          {Select ? (
            <Select
              key="mode"
              label="Compare: "
              options={MODES.map(({ value, label }) => ({ value, label }))}
              value={currentMode}
              onSelect={value => void setMode($, value as DiffMode)}
            />
          ) : (
            <Text dimColor>{modeInfo.label}</Text>
          )}
          <Text dimColor>{fileCount}</Text>
        </Box>
        {about ? <Text dimColor>{about}</Text> : null}
      </Box>
    )

    // Folders first, files under them; the letter in front is the git status.
    // Paged like the diff, so a repo with many changed files can't push the
    // drawing past the desktop's size limit.
    const tree = toTree(list, new Set(foldedDirs))
    const treePages = Math.ceil(tree.length / TREE_ROWS)
    const treeStart = Math.min(treeAt, Math.max(0, treePages - 1)) * TREE_ROWS
    const treeShown = tree.slice(treeStart, treeStart + TREE_ROWS)
    const fileList = (
      <Box flexDirection="column" width={leftWidth} flexShrink={0}>
        {treePages > 1 && (
          <Box flexDirection="row" gap={1} alignItems="center">
            {treeStart > 0 && (
              <Button key="tree-prev" plain onPress={() => void turnTreePage($, -1)}>
                ◀
              </Button>
            )}
            <Text dimColor>{`${treeStart + 1}–${treeStart + treeShown.length} of ${tree.length}`}</Text>
            {treeStart + TREE_ROWS < tree.length && (
              <Button key="tree-next" plain onPress={() => void turnTreePage($, 1)}>
                ▶
              </Button>
            )}
          </Box>
        )}
        {treeShown.map(row => {
          if (row.kind === 'dir') {
            return (
              <Box paddingLeft={row.depth * 2}>
                <Button key={`dir:${row.path}`} plain dimColor onPress={() => void toggleDir($, row.path)}>
                  {`${row.isCollapsed ? '▸' : '▾'} ${row.name}`}
                </Button>
              </Box>
            )
          }
          const letter = statusLetter(row.change.status)
          const isOn = row.change.path === selected
          return (
            <Box flexDirection="row" gap={1} paddingLeft={row.depth * 2}>
              <Text color={STATUS_COLOR[letter] ?? 'gray'} bold>
                {letter}
              </Text>
              <Button key={`file:${row.change.path}`} plain dimColor={!isOn} onPress={() => void showFile($, row.change.path)}>
                {row.name}
              </Button>
            </Box>
          )
        })}
      </Box>
    )

    const changed = view.kind === 'hunks' ? view.hunks.join('\n').split('\n') : []
    const added = changed.filter(line => line.startsWith('+')).length
    const removed = changed.filter(line => line.startsWith('-')).length
    const looks = LOOKS[colorTheme]

    // Terminal: Claude Code's own diff view (line numbers, red/green rows,
    // word highlights, in the theme). Desktop: the pane's own rows (see LOOKS).
    const codeDiff = (hunks: readonly string[]) => (
      <Box flexDirection="column" gap={1}>
        {toBlocks(hunks).map(source => (
          <Code format="diff" source={source} />
        ))}
      </Box>
    )

    const rowDiff = (hunks: readonly string[]) => {
      const rows = toRows(hunks)
      const gutter = String(Math.max(0, ...rows.map(row => ('lineNo' in row ? row.lineNo : 0)))).length
      // A big tree stops the desktop from applying redraws (its controls go
      // dead), so rows are kept to a few elements each and drawn a page at a time.
      // The desktop stops applying redraws past a total tree size (~300 rows
      // here), so the diff is drawn as a fixed window of PAGE_ROWS rows.
      const start = Math.min(page * PAGE_ROWS, Math.max(0, rows.length - 1))
      const shown = rows.slice(start, start + PAGE_ROWS)
      const pageCount = Math.ceil(rows.length / PAGE_ROWS)
      const pager = (where: string) =>
        pageCount > 1 ? (
          <Box flexDirection="row" gap={2} alignItems="center">
            {page > 0 && (
              <Button key={`prev-${where}`} onPress={() => void turnPage($, -1)}>
                ◀ Previous
              </Button>
            )}
            <Text dimColor>{`Rows ${start + 1}–${start + shown.length} of ${rows.length}`}</Text>
            {page < pageCount - 1 && (
              <Button key={`next-${where}`} onPress={() => void turnPage($, 1)}>
                Next ▶
              </Button>
            )}
          </Box>
        ) : null
      const drawRow = (row: (typeof shown)[number]) => {
            if (row.kind === 'hunk') {
              return (
                <Box marginTop={1} paddingLeft={gutter + 3}>
                  <Text dimColor wrap="truncate-end">
                    {`⋯ ${row.text}`}
                  </Text>
                </Box>
              )
            }
            const look = looks[row.kind]
            const text = (seg: { text: string }) => seg.text.replace(/\t/g, '  ') || ' '
            const hasWords = row.segments.some(seg => seg.isChanged)
            return (
              <Box flexDirection="row" backgroundColor={look.background}>
                {/* One fixed-width cell for number and marker keeps them aligned. */}
                <Box width={gutter + 3} flexShrink={0}>
                  <Text color={look.number} dimColor={row.kind === 'context'}>
                    {`${String(row.lineNo).padStart(gutter)} ${look.mark}`}
                  </Text>
                </Box>
                <Text color={look.text}>
                  {hasWords
                    ? row.segments.map(seg => (
                        <Text backgroundColor={seg.isChanged ? look.word : undefined}>{text(seg)}</Text>
                      ))
                    : row.segments.map(text).join('')}
                </Text>
              </Box>
            )
      }
      return (
        <Box flexDirection="column" gap={1}>
          {pager('top')}
          <Box flexDirection="column">{shown.map(drawRow)}</Box>
          {pager('bottom')}
        </Box>
      )
    }

    const diffBody =
      view.kind === 'hunks' ? (
        <Box flexDirection="column" gap={1}>
          {e.surface === 'terminal' ? codeDiff(view.hunks) : rowDiff(view.hunks)}
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
          <Text dimColor>
            {modeInfo.empty} in {active?.name ?? baseName(where)}.
          </Text>
        ) : null}
        {list.length > 0 && (
          <Box flexDirection={isWide ? 'row' : 'column'} gap={2}>
            {isListHidden ? null : fileList}
            {/* Boxes have no one-sided border, so a 1-cell bar, stretched to
                the row's height, stands in for a right border on the tree. */}
            {isListHidden || !isWide ? null : (
              <Box width={1} flexShrink={0} backgroundColor={SEPARATOR[colorTheme]} />
            )}
            <Box flexDirection="column" flexGrow={1} flexShrink={1}>
              <Box flexDirection="row" gap={1} marginBottom={1}>
                <Text bold wrap="truncate-middle">
                  {selected || ' '}
                </Text>
                {added > 0 && <Text color={looks.add.marker}>{`+${added}`}</Text>}
                {removed > 0 && <Text color={looks.del.marker}>{`-${removed}`}</Text>}
              </Box>
              {diffBody}
            </Box>
          </Box>
        )}
      </Box>
    )
  })
}
