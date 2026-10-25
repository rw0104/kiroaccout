import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'

test('registration sessions verify upstream certificates for direct and configured proxy paths', () => {
  const ts = createRequire(import.meta.url)('typescript')
  const source = readFileSync(new URL('../../src/main/registration/registrar.ts', import.meta.url), 'utf8')
  const tree = ts.createSourceFile('registrar.ts', source, ts.ScriptTarget.Latest, true)
  const cls = tree.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'Registrar')
  const getter = cls.members.find(node => ts.isGetAccessor(node) && node.name.getText(tree) === 'sessionOpts')
  const context = vm.createContext({ process: { env: {} }, getSystemProxy: () => undefined })
  vm.runInContext(ts.transpileModule(`class Subject { ${getter.getText(tree)} };globalThis.Subject=Subject`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context)
  for (const cfg of [{}, { proxy: 'http://proxy.example.invalid:8080' }, { proxy: 'socks5://proxy.example.invalid:1080', strictProxy: true }]) {
    const subject = new context.Subject()
    subject.cfg = { ...cfg, insecureSkipVerify: true }
    subject.tlsSessionId = 'SYNTHETIC_SESSION'
    assert.equal(subject.sessionOpts.insecureSkipVerify, false)
    assert.equal(subject.sessionOpts.sessionId, 'SYNTHETIC_SESSION')
    assert.equal(subject.sessionOpts.proxyUrl, cfg.proxy)
  }
})
