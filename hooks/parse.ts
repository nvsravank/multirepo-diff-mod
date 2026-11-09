// Pure helpers for git output: no calls to Claude Code here. (The plugin
// validator follows `$` only within one file, so everything that runs git
// lives in register.tsx.)

import type { DiffMode, DiffView, FileChange, Worktree } from '../types'

// Caps that keep a huge or minified file from swamping the pane.
const MAX_LINE_CHARS = 2000
const MAX_DIFF_CHARS = 400000

export const DIFF = ['diff', '--no-color', '--no-ext-diff', '-M']

// --- paths -----------------------------------------------------------------
// Paths are kept with forward slashes everywhere. Claude Code reports Windows
// folders as C:\Users\…, git as C:/Users/…, and Windows ignores case, so paths
// are normalized on the way in and compared with samePath / isInside.

/** Forward slashes, no trailing slash (a bare root like `/` or `C:/` keeps it). */
export const toSlash = (p: string) => p.replace(/\\/g, '/').replace(/(?<!^|:)\/+$/, '')

/** A Windows drive path such as `C:/x` or `c:\x`. */
export const isWindowsPath = (p: string) => /^[A-Za-z]:[\\/]/.test(p)

/** An absolute path on either system. */
export const isAbsolute = (p: string) => p.startsWith('/') || p.startsWith('\\') || isWindowsPath(p)

const comparable = (p: string) => (isWindowsPath(p) ? toSlash(p).toLowerCase() : toSlash(p))

/** Whether two paths name the same place: separators ignored, case too on Windows. */
export const samePath = (a: string, b: string) => comparable(a) === comparable(b)

/** Whether `path` is inside `dir` (not `dir` itself). */
export const isInside = (path: string, dir: string) => comparable(path).startsWith(`${comparable(dir)}/`)

/** `path` relative to `dir`, assuming isInside(path, dir). */
export const relativeTo = (path: string, dir: string) => toSlash(path).slice(toSlash(dir).length + 1)

export const join = (dir: string, name: string) => {
  const base = toSlash(dir)
  return base.endsWith('/') ? base + name : `${base}/${name}`
}
export const baseName = (p: string) => toSlash(p).split('/').pop() || p

/** A file name safe on every system: Windows forbids <>:"/\|?* and control characters. */
export const safeName = (name: string) => name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')

export function parseStatus(out: string): FileChange[] {
  const parts = out.split('\0')
  const list: FileChange[] = []
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]
    if (entry.length < 4) continue
    const status = entry.slice(0, 2)
    const path = entry.slice(3)
    if (status.includes('R') || status.includes('C')) list.push({ status, path, from: parts[++i] })
    else list.push({ status, path })
  }
  return list
}

/** `git diff --name-status -z`: `M\0path`, or `R100\0old\0new` for a rename. */
export function parseNameStatus(out: string): FileChange[] {
  const parts = out.split('\0').filter(Boolean)
  const list: FileChange[] = []
  for (let i = 0; i < parts.length; i++) {
    const letter = parts[i][0]
    if (letter === 'R' || letter === 'C') {
      list.push({ status: `${letter} `, from: parts[i + 1], path: parts[i + 2] })
      i += 2
    } else {
      list.push({ status: `${letter} `, path: parts[++i] })
    }
  }
  return list
}

export const untracked = (out: string): FileChange[] =>
  out
    .split('\0')
    .filter(Boolean)
    .map(path => ({ status: '??', path }))

/** Splits `git diff` output into its hunks, each starting at its `@@` header. */
export function toView(text: string): DiffView {
  if (!text.trim()) return { kind: 'text', text: 'No textual changes (mode change or empty file).' }
  if (/^Binary files .* differ$/m.test(text) && !text.includes('\n@@')) {
    return { kind: 'text', text: 'Binary file changed.' }
  }
  const isCut = text.length > MAX_DIFF_CHARS
  const lines = (isCut ? text.slice(0, MAX_DIFF_CHARS) : text).split('\n')
  const hunks: string[] = []
  let current: string[] = []
  const flush = () => {
    if (current.length > 1) hunks.push(current.join('\n'))
    current = []
  }
  for (const raw of lines) {
    const line = raw.slice(0, MAX_LINE_CHARS)
    if (line.startsWith('@@')) {
      flush()
      current = [line]
    } else if (line.startsWith('diff --git')) {
      flush()
    } else if (current.length) {
      current.push(line)
    }
  }
  flush()
  if (hunks.length === 0) return { kind: 'text', text: text.slice(0, MAX_LINE_CHARS) }
  return { kind: 'hunks', hunks, isCut }
}


// --- file tree -------------------------------------------------------------

export type TreeRow =
  | { kind: 'dir'; path: string; name: string; depth: number; isCollapsed: boolean }
  | { kind: 'file'; change: FileChange; name: string; depth: number }

type Node = { dirs: Map<string, Node>; files: FileChange[] }

/** Folders first, then files, each sorted by name; a folded folder hides its contents. */
export function toTree(changes: readonly FileChange[], collapsed: ReadonlySet<string>): TreeRow[] {
  const top: Node = { dirs: new Map(), files: [] }
  for (const change of changes) {
    const parts = change.path.split('/')
    let node = top
    for (const part of parts.slice(0, -1)) {
      if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), files: [] })
      node = node.dirs.get(part)!
    }
    node.files.push(change)
  }
  const rows: TreeRow[] = []
  const walk = (node: Node, prefix: string, depth: number) => {
    for (const [name, child] of [...node.dirs].sort(([a], [b]) => a.localeCompare(b))) {
      const path = prefix + name
      const isCollapsed = collapsed.has(path)
      rows.push({ kind: 'dir', path, name, depth, isCollapsed })
      if (!isCollapsed) walk(child, `${path}/`, depth + 1)
    }
    for (const change of [...node.files].sort((a, b) => a.path.localeCompare(b.path))) {
      rows.push({ kind: 'file', change, name: baseName(change.path), depth })
    }
  }
  walk(top, '', 0)
  return rows
}

// --- Code blocks -----------------------------------------------------------

// A Code element takes at most 10,000 characters.
const MAX_BLOCK_CHARS = 9500

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/

/**
 * Packs hunks into as few `Code format="diff"` sources as fit the size limit.
 * A hunk too big on its own is cut into smaller hunks with recounted headers,
 * so each piece still parses as a diff.
 */
export function toBlocks(hunks: readonly string[]): string[] {
  const pieces = hunks.flatMap(splitHunk)
  const blocks: string[] = []
  let current = ''
  for (const piece of pieces) {
    if (current && current.length + piece.length + 1 > MAX_BLOCK_CHARS) {
      blocks.push(current)
      current = ''
    }
    current = current ? `${current}\n${piece}` : piece
  }
  if (current) blocks.push(current)
  return blocks
}

function splitHunk(hunk: string): string[] {
  const [head, ...rest] = hunk.split('\n')
  // Drop trailing blank lines; a blank context line is a single space.
  while (rest.length && rest[rest.length - 1] === '') rest.pop()
  const body = rest.map(line => (line === '' ? ' ' : line))
  if (hunk.length <= MAX_BLOCK_CHARS) return [[head, ...body].join('\n')]

  const match = HUNK_HEADER.exec(head)
  let oldNo = match ? Number(match[1]) : 1
  let newNo = match ? Number(match[2]) : 1
  const pieces: string[] = []
  let lines: string[] = []
  let size = 0
  let oldCount = 0
  let newCount = 0
  let startOld = oldNo
  let startNew = newNo
  const flush = () => {
    if (lines.length) pieces.push([`@@ -${startOld},${oldCount} +${startNew},${newCount} @@`, ...lines].join('\n'))
    lines = []
    size = 0
    oldCount = 0
    newCount = 0
    startOld = oldNo
    startNew = newNo
  }
  for (const line of body) {
    if (size + line.length + 1 > MAX_BLOCK_CHARS - 100) flush()
    lines.push(line)
    size += line.length + 1
    if (line.startsWith('-')) {
      oldCount++
      oldNo++
    } else if (line.startsWith('+')) {
      newCount++
      newNo++
    } else if (!line.startsWith('\\')) {
      oldCount++
      newCount++
      oldNo++
      newNo++
    }
  }
  flush()
  return pieces
}

// --- worktrees -------------------------------------------------------------

/** `git worktree list --porcelain`: blocks of `worktree <path>`, `HEAD <sha>`, `branch <ref>` or `detached`. */
export function parseWorktrees(out: string): Worktree[] {
  return out
    .split(/\r?\n\r?\n/)
    .map(block => {
      const lines = block.split(/\r?\n/)
      const value = (field: string) => lines.find(line => line.startsWith(field + ' '))?.slice(field.length + 1)
      const raw = value('worktree')
      const path = raw ? toSlash(raw) : undefined
      const ref = value('branch')
      return path ? { path, sha: (value('HEAD') ?? '').slice(0, 7), branch: ref ? ref.replace(/^refs\/heads\//, '') : null } : null
    })
    .filter((one): one is Worktree => one !== null)
}

// --- session snapshots ------------------------------------------------------

/**
 * The list of files that were untracked when a snapshot was taken, with the
 * hash of each one's contents (the contents themselves aren't kept): entries
 * of `<hash> <path>`, each ended by a NUL, sorted by path.
 */
export function formatHashList(hashes: ReadonlyMap<string, string>) {
  return [...hashes]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, hash]) => `${hash} ${path}\0`)
    .join('')
}

export function parseHashList(text: string): Map<string, string> {
  const hashes = new Map<string, string>()
  for (const entry of text.split('\0')) {
    const space = entry.indexOf(' ')
    if (space > 0) hashes.set(entry.slice(space + 1), entry.slice(0, space))
  }
  return hashes
}

/** Pairs `git hash-object --stdin-paths` output lines with the paths it was given. */
export function pairHashes(paths: readonly string[], out: string): Map<string, string> {
  const lines = out.split(/\r?\n/).filter(Boolean)
  const hashes = new Map<string, string>()
  if (lines.length === paths.length) paths.forEach((path, i) => hashes.set(path, lines[i]))
  return hashes
}

/**
 * Turns `git diff --name-status <snapshot tree>` into the session's changes.
 *
 * Files that were untracked at the start aren't in the snapshot tree (only
 * their hashes are kept, in `atStart`), so the diff lists every one still
 * around as added. Each is dropped when its hash now (`hashesNow`) matches,
 * and otherwise shown as changed with no earlier version to compare. Ones in
 * `gone` were deleted since, which the diff can't see at all.
 */
export function sessionChanges(
  diffed: readonly FileChange[],
  atStart: ReadonlyMap<string, string>,
  hashesNow: ReadonlyMap<string, string>,
  gone: Iterable<string>,
): FileChange[] {
  const list: FileChange[] = []
  for (const one of diffed) {
    const was = one.status.startsWith('A') && !one.from ? atStart.get(one.path) : undefined
    if (was === undefined) list.push(one)
    else if (hashesNow.get(one.path) !== was) list.push({ ...one, status: 'M ', isUnsaved: true })
  }
  const listed = new Set(list.map(one => one.path))
  for (const path of gone) {
    if (atStart.has(path) && !listed.has(path)) list.push({ status: 'D ', path, isUnsaved: true })
  }
  return list
}

/**
 * A short, stable name for a folder (8 hex characters, FNV-1a of the path as
 * samePath compares it), so each checkout of a repo gets its own snapshot.
 */
export function folderHash(path: string) {
  let hash = 0x811c9dc5
  for (const char of comparable(path)) {
    hash ^= char.codePointAt(0) ?? 0
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}
