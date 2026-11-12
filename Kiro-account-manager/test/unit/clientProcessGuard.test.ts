import test from 'node:test'
import assert from 'node:assert/strict'
import { resolve, join } from 'node:path'
import { hasCrewProcess } from '../../src/main/clientProcessGuard'

const directory = resolve('synthetic-official-crew')
const installation = { executablePath: join(directory, 'KiroCrew.exe'),
  pythonExecutable: join(directory, 'resources/backend-dist/kirocrew-backend/python.exe'),
  bundleDirectory: join(directory, 'resources/backend-dist/kirocrew-backend') }

test('repair stop checks include the selected desktop, Python and bundled engine processes', () => {
  for (const executable of [installation.executablePath, installation.pythonExecutable, join(installation.bundleDirectory, 'engines/agent.exe')]) {
    assert.equal(hasCrewProcess([{ ExecutablePath: executable, Name: 'synthetic.exe' }], installation), true)
  }
  assert.equal(hasCrewProcess([{ Name: 'KiroCrew.exe', ExecutablePath: null }], installation), true)
  assert.equal(hasCrewProcess([{ Name: 'python.exe', CommandLine: 'python -m kiro_crew gateway' }], installation), true)
})

test('unrelated process paths and sibling directory prefixes are not the selected Crew installation', () => {
  assert.equal(hasCrewProcess([{ ExecutablePath: join(installation.bundleDirectory + '-unrelated', 'python.exe'), Name: 'python.exe' },
    { ExecutablePath: resolve('unrelated/KiroCrew.exe'), Name: 'KiroCrew.exe' }], installation), false)
  assert.equal(hasCrewProcess([], installation), false)
})

test('unreadable potential backend processes cannot be treated as proof that Crew has stopped', () => {
  for (const Name of ['python.exe', 'pythonw.exe', 'node.exe', 'kiro_agent.exe']) {
    assert.throws(() => hasCrewProcess([{ Name, ExecutablePath: null, CommandLine: null }], installation), { code: 'process-state-unknown' })
  }
})
