import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { parseAccountUsage } from '../../src/shared/accountUsage.ts'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const { renderToStaticMarkup } = require('react-dom/server')
const now = Date.parse('2026-10-22T12:00:00Z')
const source = readFileSync(new URL('../../src/renderer/src/components/accounts/AddOnCredits.tsx', import.meta.url), 'utf8')
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
const exports = {}
vm.runInNewContext(code, { exports, require, Date: class extends Date { static now() { return now } } })
const credits = parseAccountUsage({ usageBreakdownList: [{ resourceType: 'CREDIT', overageCredits: [
  { currentUsage: 20.25, usageLimit: 100, expiresAt: '2027-03-01T00:00:00Z' },
  { currentUsage: 10, usageLimit: 50, expiresAt: '2026-12-01T00:00:00Z' },
  { currentUsage: 0, usageLimit: 999, expiresAt: '2026-01-01T00:00:00Z' },
  { currentUsage: 50, usageLimit: 50, expiresAt: '2027-05-01T00:00:00Z' }
] }] }, now).addOnCredits
const render = (props = {}) => renderToStaticMarkup(exports.AddOnCredits({ credits, isEn: false, ...props }))

test('quota details show purchased balance, per-pack usage, status and expiry in Chinese and English', () => {
  const html = render({ detailed: true, precision: true })
  assert.match(html, /充值额度包/)
  assert.match(html, /119.75.*剩余/)
  assert.match(html, /20.25.*100.*已用/)
  assert.match(html, /2026-12-01.*到期/)
  assert.match(html, /已过期/)
  assert.match(html, /已耗尽/)
  assert.match(html, /不随月度套餐重置/)
  const english = render({ detailed: true, isEn: true })
  assert.match(english, /Add-on credits/)
  assert.match(english, /remaining/)
  assert.match(english, /2027-03-01 expires/)
})

test('compact virtual rows show remaining amount and earliest live expiry with every pack in the tooltip', () => {
  const html = render({ inline: true, precision: true })
  assert.match(html, /119.75.*剩余.*2026-12-01/)
  assert.match(html, /title="[^"\n]*充值包/)
  assert.match(html, /已过期/)
  assert.match(html, /已耗尽/)
  assert.doesNotMatch(html.replace(/title="[^"]*"/, ''), /999/)
})

test('old account data without packs renders nothing and a pack that expires after its last check stops showing balance', () => {
  assert.equal(render({ credits: undefined }), '')
  const expiredAfterCheck = [{ id: 'synthetic', current: 0, limit: 100, remaining: 100, status: 'active', expiresAt: '2026-10-21T00:00:00Z' }]
  const html = render({ credits: expiredAfterCheck, inline: true })
  assert.match(html, /充值包.*0.*剩余/)
  assert.match(html, /已过期/)
})
