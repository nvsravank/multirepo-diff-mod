import { describe, expect, test } from 'claude-code/testing'

import { parseNameStatus, parseStatus, parseWorktrees, toBlocks, toTree, toView, untracked } from '../hooks/parse'

describe('git output', () => {
  test('status: modified, untracked, rename with its original path, spaces in names', () => {
    const out = ' M a.ts\0?? new file.md\0R  b.ts\0old b.ts\0D  gone.ts\0'
    expect(parseStatus(out)).toEqual([
      { status: ' M', path: 'a.ts' },
      { status: '??', path: 'new file.md' },
      { status: 'R ', path: 'b.ts', from: 'old b.ts' },
      { status: 'D ', path: 'gone.ts' },
    ])
  })

  test('name-status: letters, and a rename with a score taking two paths', () => {
    const out = 'M\0a.ts\0R100\0old.ts\0new.ts\0A\0dir/added.ts\0'
    expect(parseNameStatus(out)).toEqual([
      { status: 'M ', path: 'a.ts' },
      { status: 'R ', from: 'old.ts', path: 'new.ts' },
      { status: 'A ', path: 'dir/added.ts' },
    ])
  })

  test('untracked files list as ??', () => {
    expect(untracked('a.ts\0b c.ts\0')).toEqual([
      { status: '??', path: 'a.ts' },
      { status: '??', path: 'b c.ts' },
    ])
  })

  test('worktrees: branch, detached, and the main checkout first', () => {
    const out = [
      'worktree /repo\nHEAD 1310f3a0123456789\nbranch refs/heads/main',
      'worktree /repo/.claude/worktrees/x\nHEAD 550368d0123456789\ndetached',
      'worktree /tmp/feature\nHEAD 5491668abcdef\nbranch refs/heads/feature/a-b',
      '',
    ].join('\n\n')
    expect(parseWorktrees(out)).toEqual([
      { path: '/repo', sha: '1310f3a', branch: 'main' },
      { path: '/repo/.claude/worktrees/x', sha: '550368d', branch: null },
      { path: '/tmp/feature', sha: '5491668', branch: 'feature/a-b' },
    ])
  })
})

describe('diff text', () => {
  test('hunks are split out and file headers dropped', () => {
    const text = [
      'diff --git a/a b/a',
      'index 1..2 100644',
      '--- a/a',
      '+++ b/a',
      '@@ -1,2 +1,2 @@',
      ' keep',
      '-old',
      '+new',
      '@@ -10 +10 @@',
      '-x',
      '+y',
      '',
    ].join('\n')
    const view = toView(text)
    expect(view.kind).toBe('hunks')
    if (view.kind === 'hunks') {
      expect(view.hunks.length).toBe(2)
      expect(view.hunks[0].startsWith('@@ -1,2 +1,2 @@')).toBe(true)
      expect(view.isCut).toBe(false)
    }
  })

  test('binary and empty diffs say so instead of drawing hunks', () => {
    expect(toView('Binary files a/x.png and b/x.png differ\n')).toEqual({ kind: 'text', text: 'Binary file changed.' })
    expect(toView('').kind).toBe('text')
  })
})

describe('Code blocks for the terminal diff view', () => {
  // Every line of a block must be a hunk header or a diff line, or the
  // terminal refuses the block and the pane doesn't draw.
  const isDiffLine = (line: string) => /^(@@ -\d+(,\d+)? \+\d+(,\d+)? @@|[ +\-\\])/.test(line)

  test('small hunks pack into one block', () => {
    const blocks = toBlocks(['@@ -1 +1 @@\n-a\n+b', '@@ -9 +9 @@\n-c\n+d'])
    expect(blocks.length).toBe(1)
    expect(blocks[0].split('\n').every(isDiffLine)).toBe(true)
  })

  test('a hunk too big for one block splits under 10,000 characters with recounted headers', () => {
    const lines = Array.from({ length: 3000 }, (_, i) => (i % 3 === 0 ? `+added ${i}` : ` context ${i}`))
    const blocks = toBlocks([`@@ -1,2000 +1,3000 @@\n${lines.join('\n')}`])
    expect(blocks.length > 1).toBe(true)
    for (const block of blocks) {
      expect(block.length < 10000).toBe(true)
      const [head, ...body] = block.split('\n')
      expect(body.every(isDiffLine)).toBe(true)
      // The header's counts match the lines under it.
      const [, oldCount, newCount] = /^@@ -\d+,(\d+) \+\d+,(\d+) @@/.exec(head) ?? []
      expect(Number(oldCount)).toBe(body.filter(line => !line.startsWith('+')).length)
      expect(Number(newCount)).toBe(body.filter(line => !line.startsWith('-')).length)
    }
  })

  test('blank context lines become a single space and trailing blanks are dropped', () => {
    const [block] = toBlocks(['@@ -1,3 +1,3 @@\n a\n\n b\n\n'])
    expect(block).toBe('@@ -1,3 +1,3 @@\n a\n \n b')
  })
})

describe('file tree', () => {
  const files = [
    { status: ' M', path: 'z.ts' },
    { status: ' M', path: 'hooks/register.tsx' },
    { status: '??', path: 'hooks/parse.ts' },
    { status: ' M', path: 'types/index.d.ts' },
  ]

  test('folders first, then files, each sorted, with depth', () => {
    const rows = toTree(files, new Set())
    expect(rows.map(row => `${'  '.repeat(row.depth)}${row.name}`)).toEqual([
      'hooks',
      '  parse.ts',
      '  register.tsx',
      'types',
      '  index.d.ts',
      'z.ts',
    ])
  })

  test('a folded folder hides what is inside it', () => {
    const rows = toTree(files, new Set(['hooks']))
    expect(rows.map(row => row.name)).toEqual(['hooks', 'types', 'index.d.ts', 'z.ts'])
    expect(rows[0].kind === 'dir' && rows[0].isCollapsed).toBe(true)
  })
})
