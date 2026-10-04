import { expect, test } from 'claude-code/testing'

// A fake workspace: the root is a clean repo, `alpha` has changes, `beta` is
// clean, `notes` is a plain folder. Git and the filesystem are answered below.
const DIR = '/work'

const STATUS: Record<string, string> = {
  [DIR]: '',
  [`${DIR}/alpha`]: ' M a.txt\0?? new.md\0',
  [`${DIR}/beta`]: '',
}

const DIFF_A = `diff --git a/a.txt b/a.txt
index 1111111..2222222 100644
--- a/a.txt
+++ b/a.txt
@@ -1,2 +1,3 @@
 one
-two
+TWO
+three
`

const DIFF_NEW = `diff --git a/new.md b/new.md
new file mode 100644
--- /dev/null
+++ b/new.md
@@ -0,0 +1 @@
+hello
`

function fakeGit(cwd: string, args: readonly string[]) {
  const ok = (stdout: string, exitCode = 0) => ({
    exitCode,
    stdout,
    stderr: '',
    isStdoutTruncated: false,
    isStderrTruncated: false,
  })
  if (args[0] === '--version') return ok('git version 2.0')
  if (args[0] === 'rev-parse') return cwd in STATUS ? ok(`${cwd}\n`) : ok('', 128)
  if (args[0] === 'branch') return ok('main\n')
  if (args[0] === 'status') return ok(STATUS[cwd] ?? '')
  if (args[0] === 'diff' && args.includes('new.md')) return ok(DIFF_NEW, 1)
  if (args[0] === 'diff' && args.includes('a.txt')) return ok(DIFF_A)
  return ok('')
}

const dirEntry = (name: string) => ({ name, kind: 'directory', size: 0, mtimeMs: 0, isLink: false }) as const

const PANE_PROPS = {
  title: 'Multi-repo diff',
  isFocused: true,
  bodyColumns: 120,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
} as const

test('lists repos, changed files and the diff', async ($, on) => {
  on('session.cwd', () => ({ value: DIR }))
  on('command.run', () => ({ text: '' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('fs.list', (_, e) => ({ value: e.path === DIR ? ['alpha', 'beta', 'notes', '.git'].map(dirEntry) : [] }))
  on('fs.exists', (_, e) => ({ value: [`${DIR}/alpha/.git`, `${DIR}/beta/.git`].includes(e.path) }))
  // argv is ['git', '--no-pager', ...args]
  on('process.run', (_, e) => ({ value: fakeGit(String(e.init?.cwd ?? DIR), e.argv.slice(2)) }))

  await $.command.run({ command: 'multi-diff', args: '' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'multirepo-diff-mod',
      surface,
      component: 'Pane',
      requestId: 'multi-diff',
      props: PANE_PROPS,
    })
    const picker = await ui.find({ key: 'repo' })
    const labels = ((picker?.props.options ?? []) as { label: string }[]).map(o => o.label)
    expect(labels).toEqual(['work (main)  [main]  clean', 'alpha  [main]  2 changed', 'beta  [main]  clean'])

    await ui.select({ key: 'repo', value: `${DIR}/alpha` })
    expect((await ui.find({ key: 'file-0' }))?.text).toContain('a.txt')
    expect((await ui.find({ key: 'file-1' }))?.text).toContain('new.md')
    expect(String((await ui.find({ type: 'Code' }))?.props.source)).toContain('+TWO')

    await ui.press({ key: 'file-1' })
    expect(String((await ui.find({ type: 'Code' }))?.props.source)).toContain('+hello')

    await ui.select({ key: 'repo', value: `${DIR}/beta` })
    expect(await ui.find({ text: /Working tree clean/ })).toBeDefined()
    await ui.unmount()
  }
})
