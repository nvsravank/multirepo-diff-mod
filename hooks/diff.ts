// Turns unified-diff hunks into rows the pane draws: one per line, with its
// line number and, for edited lines, which words changed.

export type Segment = { text: string; isChanged: boolean }

export type DiffRow =
  | { kind: 'hunk'; text: string }
  | { kind: 'context' | 'add' | 'del'; lineNo: number; segments: Segment[] }

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/

// Lines longer than this in tokens are not compared word by word.
const MAX_TOKENS = 400

export function toRows(hunks: readonly string[]): DiffRow[] {
  const rows: DiffRow[] = []
  for (const hunk of hunks) {
    const lines = hunk.split('\n')
    const header = HUNK_HEADER.exec(lines[0])
    let oldNo = header ? Number(header[1]) : 0
    let newNo = header ? Number(header[2]) : 0
    rows.push({ kind: 'hunk', text: header?.[3].trim() ?? '' })

    let dels: string[] = []
    let adds: string[] = []
    const flush = () => {
      // Pair the n-th removed line with the n-th added one for word highlights.
      const pairs = Array.from({ length: Math.min(dels.length, adds.length) }, (_, i) => wordDiff(dels[i], adds[i]))
      dels.forEach((text, i) => {
        rows.push({ kind: 'del', lineNo: oldNo++, segments: pairs[i]?.[0] ?? [{ text, isChanged: false }] })
      })
      adds.forEach((text, i) => {
        rows.push({ kind: 'add', lineNo: newNo++, segments: pairs[i]?.[1] ?? [{ text, isChanged: false }] })
      })
      dels = []
      adds = []
    }

    for (const line of lines.slice(1)) {
      if (line.startsWith('\\')) continue // "\ No newline at end of file"
      const mark = line[0]
      const text = line.slice(1)
      if (mark === '-') {
        if (adds.length) flush()
        dels.push(text)
      } else if (mark === '+') {
        adds.push(text)
      } else {
        flush()
        rows.push({ kind: 'context', lineNo: newNo, segments: [{ text, isChanged: false }] })
        oldNo++
        newNo++
      }
    }
    flush()
  }
  return rows
}

const tokenize = (s: string) => s.match(/\w+|\s+|[^\w\s]/g) ?? []

/**
 * Word-level diff of an edited line pair. Returns the old line's and the new
 * line's segments, changed tokens marked. Lines with little in common are
 * left unmarked, as a highlight there is just noise.
 */
export function wordDiff(before: string, after: string): [Segment[], Segment[]] {
  const plain: [Segment[], Segment[]] = [
    [{ text: before, isChanged: false }],
    [{ text: after, isChanged: false }],
  ]
  const a = tokenize(before)
  const b = tokenize(after)
  if (a.length > MAX_TOKENS || b.length > MAX_TOKENS) return plain

  // Longest common subsequence over tokens.
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }
  const common = lcs[0][0]
  if (common === 0 || common / Math.max(a.length, b.length) < 0.3) return plain

  const keepA = new Array(a.length).fill(false)
  const keepB = new Array(b.length).fill(false)
  for (let i = 0, j = 0; i < a.length && j < b.length; ) {
    if (a[i] === b[j]) {
      keepA[i++] = true
      keepB[j++] = true
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) i++
    else j++
  }
  return [merge(a, keepA), merge(b, keepB)]
}

// An unchanged gap this short between two changed runs is folded into one
// highlight (`foo(a, b)` → `bar(x, y)` reads as one change, not five).
const MAX_GAP_CHARS = 3

function merge(tokens: string[], kept: boolean[]): Segment[] {
  const runs: Segment[] = []
  tokens.forEach((text, i) => {
    const isChanged = !kept[i]
    const last = runs[runs.length - 1]
    if (last && last.isChanged === isChanged) last.text += text
    else runs.push({ text, isChanged })
  })
  const out: Segment[] = []
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i]
    const prev = out[out.length - 1]
    const next = runs[i + 1]
    const isShortGap = !run.isChanged && run.text.length <= MAX_GAP_CHARS && prev?.isChanged && next?.isChanged
    if (isShortGap || (run.isChanged && prev?.isChanged)) prev!.text += run.text
    else out.push({ ...run })
  }
  return out
}
