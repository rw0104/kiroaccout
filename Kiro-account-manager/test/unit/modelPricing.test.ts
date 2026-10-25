import test from 'node:test'
import assert from 'node:assert/strict'
import { getModelPricing, formatPricingTier } from '../../src/shared/modelPricing.ts'

test('Haiku 5.5 prices the inclusive 100K boundary separately from longer context', () => {
  const pricing = getModelPricing({ id: 'claude-haiku-5.5', rateMultiplier: 0.06 })
  assert.equal(pricing?.kind, 'tiered')
  if (pricing?.kind !== 'tiered') return
  assert.deepEqual(pricing.tiers, [
    { upToTokens: 100000, multiplier: 0.06 },
    { aboveTokens: 100000, multiplier: 0.3 }
  ])
  assert.equal(formatPricingTier(pricing.tiers[0]), '≤100K: 0.06x')
  assert.equal(formatPricingTier(pricing.tiers[1]), '>100K: 0.3x')
  assert.equal(pricing.verifiedOn, '2026-10-24')
  assert.match(pricing.sourceUrl, /^https:\/\/kiro\.dev\/changelog\/models\/claude-haiku-5-5\/$/)
})

test('GPT-5.6 variants share the inclusive 272K boundary and double the long-context multiplier', () => {
  for (const [family, short] of [
    ['sol', 4.4],
    ['terra', 2.2],
    ['luna', 1.1]
  ] as const) {
    const pricing = getModelPricing({ id: `gpt-5.6-${family}`, rateMultiplier: short })
    assert.equal(pricing?.kind, 'tiered')
    if (pricing?.kind !== 'tiered') continue
    assert.deepEqual(pricing.tiers, [
      { upToTokens: 272000, multiplier: short },
      { aboveTokens: 272000, multiplier: short * 2 }
    ])
    assert.match(formatPricingTier(pricing.tiers[0]), /^≤272K: /)
    assert.match(formatPricingTier(pricing.tiers[1]), /^>272K: /)
    assert.match(pricing.sourceUrl, /gpt-5-6-1m-context-window/)
  }
})

test('documented pricing accepts exact public names, aliases and dated model snapshots', () => {
  for (const id of [
    'CLAUDE_HAIKU_5_5_20261023_V1_0',
    'claude-haiku-5-5-20261023',
    'anthropic.claude-haiku-5.5-20261023',
    'GPT_5_6_SOL_20260914'
  ])
    assert.equal(getModelPricing({ id })?.kind, 'tiered', id)
  assert.equal(getModelPricing({ id: 'opaque-model-id', name: 'Claude Haiku 5.5' })?.kind, 'tiered')
  assert.equal(getModelPricing({ id: 'opaque-model-id', name: 'GPT‑5.6 Terra' })?.kind, 'tiered')
})

test('nearby versions, custom variants and contradictory identities do not inherit public model prices', () => {
  for (const id of [
    'claude-haiku-4.5',
    'claude-haiku-5.50',
    'claude-haiku-5.5-custom',
    'my-claude-haiku-5.5',
    'gpt-5.6-sol-fast',
    'gpt-5.6'
  ]) {
    const pricing = getModelPricing({ id, rateMultiplier: 0.2 })
    assert.equal(pricing?.kind, 'catalog', id)
  }
  assert.equal(getModelPricing({ id: 'claude-haiku-4.5', name: 'Claude Haiku 5.5' }), undefined)
  assert.equal(
    getModelPricing({ id: 'claude-haiku-5.5-custom', name: 'Claude Haiku 5.5' }),
    undefined
  )
  assert.equal(getModelPricing({ id: 'gpt-5.6-sol', name: 'GPT-5.6 Luna' }), undefined)
})

test('current catalog rates win over a documented rule when the service changes its multiplier', () => {
  const input = { id: 'claude-haiku-5.5', rateMultiplier: 0.08, rateUnit: 'credit' }
  const before = JSON.stringify(input)
  const pricing = getModelPricing(input)
  assert.equal(pricing?.kind, 'catalog')
  if (pricing?.kind !== 'catalog') return
  assert.equal(pricing.multiplier, 0.08)
  assert.equal(pricing.documentedRateMismatch, true)
  assert.match(pricing.sourceUrl ?? '', /claude-haiku-5-5/)
  assert.equal(JSON.stringify(input), before)
})

test('the current Luna catalog multiplier of 0.6 suppresses older 1.1 and 2.2 documentation rates', () => {
  const pricing = getModelPricing({ id: 'gpt-5.6-luna', rateMultiplier: 0.6 })
  assert.equal(pricing?.kind, 'catalog')
  if (pricing?.kind !== 'catalog') return
  assert.equal(pricing.multiplier, 0.6)
  assert.equal(pricing.documentedRateMismatch, true)
  assert.equal('tiers' in pricing, false)
  assert.match(pricing.sourceUrl ?? '', /gpt-5-6-1m-context-window/)
})

test('unknown models preserve valid server metadata without inventing missing prices', () => {
  assert.equal(getModelPricing({ id: 'future-model' }), undefined)
  for (const rateMultiplier of [NaN, Infinity, -1]) {
    assert.equal(getModelPricing({ id: 'future-model', rateMultiplier }), undefined)
  }
  assert.deepEqual(
    getModelPricing({ id: 'future-model', rateMultiplier: 0.4, rateUnit: 'request' }),
    {
      kind: 'catalog',
      multiplier: 0.4,
      unit: 'request',
      documentedRateMismatch: false
    }
  )
  assert.equal(getModelPricing({ id: 'free-model', rateMultiplier: 0 })?.kind, 'catalog')
})
