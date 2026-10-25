import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { createRemoteImageDownloader } from '../../src/main/proxy/remoteImage.ts'

const ts = createRequire(import.meta.url)('typescript')
const sourcePath = new URL('../../src/main/proxy/proxyServer.ts', import.meta.url)
// An explicit source fixture permits the historical vulnerability to be reproduced offline.
const source = readFileSync(process.env.KIRO_SECURITY_SOURCE_FIXTURE || sourcePath, 'utf8')
const tree = ts.createSourceFile('proxyServer.ts', source, ts.ScriptTarget.Latest, true)
const declaration = tree.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'ProxyServer')
const names = ['downloadImageDataUrl', 'resolveOpenAIHttpImages', 'resolveClaudeHttpImages']
const methods = declaration.members.filter(node => names.includes(node.name?.getText(tree))).map(node => node.getText(tree)).join('\n')

test('actual OpenAI and Claude image entrypoints reject internal/unsupported URLs without requesting them', async () => {
  let networkCalls = 0
  const fakeFetch = async () => { networkCalls++; return new Response('internal synthetic image', { headers: { 'content-type': 'image/png' } }) }
  const context = { Buffer, AbortController, setTimeout, clearTimeout, URL, Response, console,
    fetch: fakeFetch, downloadRemoteImageDataUrl: createRemoteImageDownloader({ getProxyUrl: () => undefined }),
    require: name => name === 'undici' ? { fetch: fakeFetch } : { getSystemProxy: () => null, safeCreateProxyAgent: () => undefined } }
  vm.runInNewContext(ts.transpileModule(`class Subject { ${methods} }; globalThis.Subject = Subject`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText, context)
  const subject = new context.Subject()
  for (const url of ['http://127.0.0.1/private', 'http://169.254.169.254/metadata', 'file:///private', 'ftp://private.invalid/image']) {
    await assert.rejects(subject.resolveOpenAIHttpImages({ messages: [{ content: [{ type: 'image_url', image_url: { url } }] }] }))
    await assert.rejects(subject.resolveClaudeHttpImages({ messages: [{ content: [{ type: 'image', source: { type: 'url', url } }] }] }))
  }
  assert.equal(networkCalls, 0)
  const inline = { messages: [{ content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,aW1hZ2U=' } }] }] }
  assert.equal(await subject.resolveOpenAIHttpImages(inline), inline)
})
