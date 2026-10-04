export type Repo = { name: string; path: string; branch: string; changes: number }

export type FileChange = {
  path: string
  /** The original path of a rename or copy. */
  from?: string
  /** Two-letter porcelain status, e.g. ` M`, `A `, `??`. */
  status: string
}

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
      files: FileChange[]
      file: string
      diff: DiffView
      error: string
    }
  }
}
