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
