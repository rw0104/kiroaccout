import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const source = readFileSync(new URL('../../src/main/proxy/tokenCounter.ts', import.meta.url), 'utf8')

function harness() {
  const imports = []
  const exports = {}
  const context = vm.createContext({ exports, Buffer, console, require(name) { imports.push(name); return require(name) } })
  vm.runInContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, context)
  return { counter: exports, imports }
}

test('loading the account manager and reading model limits do not load tokenizer tables', () => {
  const { counter, imports } = harness()
  assert.equal(counter.getModelContextLength('claude-sonnet-4'), 200000)
  assert.equal(counter.countTokens(''), 0)
  assert.deepEqual(imports.filter(name => name.startsWith('js-tiktoken')), [])
})

test('token estimation lazily loads only cl100k and preserves counts for prose, code and Unicode', () => {
  const { counter, imports } = harness()
  const { Tiktoken } = require('js-tiktoken/lite')
  const ranks = require('js-tiktoken/ranks/cl100k_base')
  const expected = new Tiktoken(ranks)
  for (const text of ['hello world', '请检查账号切换的性能。', 'const answer = 42;\n', 'emoji 🐱 and 日本語']) {
    assert.equal(counter.countTokens(text), expected.encode(text).length)
  }
  assert.deepEqual(imports.filter(name => name.startsWith('js-tiktoken')), ['js-tiktoken/lite', 'js-tiktoken/ranks/cl100k_base'])
})
