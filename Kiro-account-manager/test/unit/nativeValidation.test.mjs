import test from 'node:test'
import assert from 'node:assert/strict'
import { loadLibraryForValidation } from '../../scripts/lib/nativeValidation.mjs'

test('Windows native verification pins the exact loaded module before exposing its exports', () => {
  const loaded = [], argumentsSeen = []
  const library = {}
  const koffi = {
    load: name => { loaded.push(name); return name === 'kernel32.dll' ? {
      func: (name, result, args) => {
        assert.equal(name, 'GetModuleHandleExW'); assert.equal(result, 'bool'); assert.equal(args[1], 'str16')
        return (flag, filename, handle) => { argumentsSeen.push([flag, filename]); handle[0] = 123n; return true }
      }
    } : library }, pointer: type => type, out: type => type
  }
  assert.equal(loadLibraryForValidation(koffi, 'C:\\Synthetic\\tls.dll', 'win32'), library)
  assert.deepEqual(loaded, ['C:\\Synthetic\\tls.dll', 'kernel32.dll'])
  assert.deepEqual(argumentsSeen, [[1, 'C:\\Synthetic\\tls.dll']])
})

test('failed Windows module retention aborts validation and other platforms use their native loader', () => {
  const koffi = { load: name => name === 'kernel32.dll' ? { func: () => () => false } : {}, pointer: type => type, out: type => type }
  assert.throws(() => loadLibraryForValidation(koffi, 'C:\\Synthetic\\tls.dll', 'win32'), /Cannot retain/)
  for (const platform of ['linux', 'darwin']) {
    const library = {}
    assert.equal(loadLibraryForValidation({ load: () => library }, '/synthetic/tls.so', platform), library)
  }
})
