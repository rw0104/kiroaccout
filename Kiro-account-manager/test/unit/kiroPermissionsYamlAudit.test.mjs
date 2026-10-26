import assert from 'node:assert/strict'
import test from 'node:test'
import { parseDocument } from 'yaml'
import {
  inspectKiroPermissionsDocument,
  planKiroAutoApprovalMerge
} from '../../src/main/kiroPermissions.ts'

const LARGE_INTEGER = '9007199254740993'
const NEGATIVE_INTEGER = '-9223372036854775809'

test('auto-approval merge preserves large integers in unknown top-level metadata', () => {
  const original = [
    '# preserve exact metadata values',
    'metadata:',
    '  revision: ' + LARGE_INTEGER,
    '  previous: ' + NEGATIVE_INTEGER,
    '  nested: [0, ' + LARGE_INTEGER + ', "' + LARGE_INTEGER + '"]',
    'rules: []',
    ''
  ].join('\r\n')
  const merged = planKiroAutoApprovalMerge('\uFEFF' + original)
  assert.equal(merged.changed, true)
  assert.equal(merged.afterInspection.contentStatus, 'configured')
  const parsed = parseDocument(merged.content, { intAsBigInt: true }).toJS()
  assert.equal(parsed.metadata.revision, BigInt(LARGE_INTEGER))
  assert.equal(parsed.metadata.previous, BigInt(NEGATIVE_INTEGER))
  assert.deepEqual(parsed.metadata.nested, [0n, BigInt(LARGE_INTEGER), LARGE_INTEGER])
  assert.match(merged.content, /# preserve exact metadata values\r\n/)
  assert.ok(merged.content.startsWith('\uFEFF'))
  assert.equal(merged.content.includes('\n') && !merged.content.replace(/\r\n/g, '').includes('\n'), true)
  const repeated = planKiroAutoApprovalMerge(merged.content)
  assert.equal(repeated.changed, false)
  assert.equal(repeated.content, merged.content)
})

test('auto-approval merge preserves large integers inside existing deny rules and rule snapshots', () => {
  const original = [
    'rules:',
    '  - capability: shell',
    '    effect: deny',
    '    ruleId: ' + LARGE_INTEGER,
    '    metadata: {counter: ' + NEGATIVE_INTEGER + '}',
    ''
  ].join('\n')
  const merged = planKiroAutoApprovalMerge(original)
  assert.equal(merged.changed, true)
  assert.equal(merged.afterInspection.restrictions.denyCount, 1)
  assert.equal(merged.afterInspection.restrictions.unknownRuleCount, 1)
  const parsed = parseDocument(merged.content, { intAsBigInt: true }).toJS()
  assert.equal(parsed.rules[0].ruleId, BigInt(LARGE_INTEGER))
  assert.equal(parsed.rules[0].metadata.counter, BigInt(NEGATIVE_INTEGER))
  assert.deepEqual(
    merged.afterInspection.rulesSnapshot.slice(0, 1),
    inspectKiroPermissionsDocument(original).rulesSnapshot
  )
  assert.deepEqual(merged.addedRules, ['all', 'fs_write'])
})
