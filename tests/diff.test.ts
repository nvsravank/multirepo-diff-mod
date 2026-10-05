import { expect, test } from 'claude-code/testing'

import { toRows, wordDiff } from '../hooks/diff'

test('rows carry line numbers and pair edited lines', () => {
  const rows = toRows(['@@ -10,3 +10,3 @@ function f() {\n keep\n-const a = 1\n+const a = 2\n tail'])
  expect(rows.map(row => row.kind)).toEqual(['hunk', 'context', 'del', 'add', 'context'])
  expect(rows.map(row => ('lineNo' in row ? row.lineNo : null))).toEqual([null, 10, 11, 11, 12])
  const del = rows[2]
  expect('segments' in del && del.segments).toEqual([
    { text: 'const a = ', isChanged: false },
    { text: '1', isChanged: true },
  ])
})

test('unrelated lines get no word highlight', () => {
  const [before, after] = wordDiff('return x', 'import { y } from "z"')
  expect(before).toEqual([{ text: 'return x', isChanged: false }])
  expect(after).toEqual([{ text: 'import { y } from "z"', isChanged: false }])
})

test('a short unchanged gap between changes folds into one highlight', () => {
  const [before, after] = wordDiff('const x = foo(a, b)', 'const x = bar(x, y)')
  expect(before.filter(seg => seg.isChanged).map(seg => seg.text)).toEqual(['foo(a, b'])
  expect(after.filter(seg => seg.isChanged).map(seg => seg.text)).toEqual(['bar(x, y'])
})

test('a longer unchanged gap keeps the changes apart', () => {
  const [, after] = wordDiff('return a === "directory"', 'return a !== "file"')
  expect(after.filter(seg => seg.isChanged).map(seg => seg.text)).toEqual(['!', 'file'])
})

test('lines only added or only removed number on their own side', () => {
  const rows = toRows(['@@ -5,2 +5,3 @@\n keep\n-gone\n+one\n+two'])
  expect(rows.map(row => ('lineNo' in row ? `${row.kind}:${row.lineNo}` : row.kind))).toEqual([
    'hunk',
    'context:5',
    'del:6',
    'add:6',
    'add:7',
  ])
})
