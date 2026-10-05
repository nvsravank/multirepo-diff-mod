export type Repo = { name: string; path: string }

/** One checkout of a repo: its main working tree or a linked worktree. */
export type Worktree = { path: string; sha: string; /** null when detached */ branch: string | null }

export type FileChange = {
  /** Relative to the repo root. */
  path: string
  /** The original path of a rename or copy. */
  from?: string
  /** Two-letter status, e.g. ` M`, `A `, `??`. */
  status: string
  /** Session mode: the file's content before Claude's first edit (a snapshot path, or /dev/null). */
  before?: string
}

/**
 * What a diff compares:
 * - head: working tree (staged + unstaged) against the last commit
 * - unstaged: working tree against the staging area
 * - staged: staging area against the last commit
 * - base: the branch's commits against where it left the default branch (a PR's view)
 * - session: files Claude edited in this session, against their content before the first edit
 */
export type DiffMode = 'head' | 'unstaged' | 'staged' | 'base' | 'session'

/** A file Claude edited this session: its absolute path and its content before the first edit. */
export type SessionEdit = { path: string; before: string }

export type Theme = 'light' | 'dark'

export type DiffView =
  | { kind: 'empty' }
  | { kind: 'hunks'; hunks: string[]; isCut: boolean }
  | { kind: 'text'; text: string }

declare module 'claude-code' {
  interface PluginState {
    'multirepo-diff-mod': {
      root: string
      repos: Repo[]
      repo: string
      worktrees: Worktree[]
      /** The checkout being compared: the repo's main path or one of its worktrees. */
      worktree: string
      /** Whether the worktree picker lists detached worktrees. */
      showDetached: boolean
      mode: DiffMode
      /** A line under the header explaining what is compared, e.g. the base branch. */
      note: string
      files: FileChange[]
      file: string
      diff: DiffView
      error: string
      theme: Theme
      /** Desktop: which page of PAGE_ROWS diff rows is shown, from 0. */
      diffPage: number
      /** Which page of TREE_ROWS file-tree rows is shown, from 0. */
      treePage: number
      sessionEdits: SessionEdit[]
      /** True while the file list is folded away. */
      isListCollapsed: boolean
      /** Folders folded in the file tree, by path. */
      collapsedDirs: string[]
    }
  }
}
