import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeUsageDate, parseAccountUsage } from '../../src/shared/accountUsage.ts'

const now = Date.parse('2026-10-22T12:00:00Z')
const future = '2027-03-01T00:00:00.000Z'
const past = '2026-01-01T00:00:00.000Z'
const response = (
  credit: Record<string, unknown>,
  reset: unknown = '2026-11-01T00:00:00Z'
): unknown => ({
  usageBreakdownList: [{ resourceType: 'CREDIT', currentUsage: 100, usageLimit: 100, ...credit }],
  nextDateReset: reset
})

test('a depleted monthly plan with purchased balance remains below its combined allowance', () => {
  const usage = parseAccountUsage(
    response({ overageCredits: [{ currentUsage: 10, usageLimit: 500, expiresAt: future }] }),
    now
  )
  assert.equal(usage.current, 110)
  assert.equal(usage.limit, 600)
  assert.equal(usage.limit - usage.current, 490)
  assert.equal(usage.percentUsed, 110 / 600)
  assert.deepEqual(usage.addOnCredits, [
    {
      id: 'add-on-0-0',
      current: 10,
      limit: 500,
      remaining: 490,
      expiresAt: future,
      status: 'active'
    }
  ])
  assert.equal(usage.baseCurrent, 100)
  assert.equal(usage.baseLimit, 100)
})

test('monthly reset changes only the monthly allowance and never replenishes or removes purchased packs', () => {
  const packs = [{ currentUsage: 120, usageLimit: 500, expiresAt: future }]
  const before = parseAccountUsage(response({ overageCredits: packs }), now)
  const after = parseAccountUsage(
    response({ currentUsage: 0, overageCredits: packs }, '2026-12-01T00:00:00Z'),
    Date.parse('2026-11-02T00:00:00Z')
  )
  assert.deepEqual(after.addOnCredits, before.addOnCredits)
  assert.equal(after.addOnCurrent, 120)
  assert.equal(after.addOnLimit, 500)
  assert.equal(after.current, 120)
  assert.equal(after.nextResetDate, '2026-12-01T00:00:00.000Z')
})

test('expired and inactive packs remain inspectable without phantom balance; depleted packs count as fully consumed', () => {
  const usage = parseAccountUsage(
    response({
      overageCredits: [
        { currentUsage: 5, usageLimit: 1000, expiresAt: past },
        { currentUsage: 20, usageLimit: 20, expiresAt: future },
        { currentUsage: 0, usageLimit: 200, status: 'EXHAUSTED', expiresAt: future },
        { currentUsage: 0, usageLimit: 999, status: 'INACTIVE', expiresAt: future },
        { currentUsage: 0, usageLimit: 999, expiresAt: 'invalid' },
        { currentUsage: 0, usageLimit: 999, expiresAt: now / 1000 }
      ]
    }),
    now
  )
  assert.equal(usage.addOnCredits.filter((pack) => pack.status === 'expired').length, 2)
  assert.equal(usage.addOnCredits.filter((pack) => pack.status === 'inactive').length, 2)
  assert.equal(
    usage.addOnCredits.every((pack) => pack.remaining === 0),
    true
  )
  assert.equal(usage.addOnCurrent, 220)
  assert.equal(usage.addOnLimit, 220)
  assert.equal(usage.current, usage.limit)
})

test('precision, trial aliases, bonuses and multiple CREDIT rows aggregate while unrelated resources do not', () => {
  const usage = parseAccountUsage(
    {
      usageBreakdownList: [
        {
          resourceType: 'REQUEST',
          currentUsage: 9999,
          usageLimit: 9999,
          overageCredits: [{ usageLimit: 9999 }]
        },
        {
          resourceType: 'CREDIT',
          currentUsageWithPrecision: 1.25,
          currentUsage: 1,
          usageLimitWithPrecision: 10.5,
          usageLimit: 10,
          freeTrialUsage: {
            freeTrialStatus: 'ACTIVE',
            currentUsageWithPrecision: 2.5,
            usageLimit: 20,
            freeTrialExpiry: future
          },
          bonuses: [
            {
              bonusCode: 'synthetic',
              displayName: 'Synthetic',
              currentUsageWithPrecision: 1.5,
              usageLimit: 5,
              status: 'ACTIVE',
              expiresAt: future
            },
            { currentUsage: 5, usageLimit: 5, status: 'EXHAUSTED', expiresAt: future },
            { usageLimit: 999, status: 'ACTIVE', expiresAt: past }
          ],
          overageCredits: [
            { currentUsageWithPrecision: 0.25, usageLimitWithPrecision: 50.5, expiresAt: future }
          ]
        },
        { resourceType: 'CREDIT', currentUsage: 1, usageLimit: 2 }
      ]
    },
    now
  )
  assert.equal(usage.baseCurrent, 2.25)
  assert.equal(usage.baseLimit, 12.5)
  assert.equal(usage.freeTrialCurrent, 2.5)
  assert.equal(usage.freeTrialLimit, 20)
  assert.equal(usage.bonuses.length, 2)
  assert.equal(usage.current, 11.5)
  assert.equal(usage.limit, 93)
  assert.equal(usage.totalCurrent, usage.current)
  assert.equal(usage.totalLimit, usage.limit)
})

test('trial expires at the boundary; date parsing accepts seconds, milliseconds, ISO and SDK Dates safely', () => {
  for (const value of [
    Date.parse(future) / 1000,
    `${Date.parse(future) / 1000}`,
    Date.parse(future),
    future,
    new Date(future)
  ]) {
    assert.equal(normalizeUsageDate(value), future)
    const usage = parseAccountUsage(
      response(
        { freeTrialInfo: { freeTrialStatus: 'ACTIVE', usageLimit: 500, freeTrialExpiry: value } },
        value
      ),
      now
    )
    assert.equal(usage.freeTrialLimit, 500)
    assert.equal(usage.nextResetDate, future)
  }
  for (const value of [null, undefined, {}, NaN, Infinity, 'bad', 1e30])
    assert.equal(normalizeUsageDate(value), undefined)
  const usage = parseAccountUsage(
    response({
      freeTrialInfo: { freeTrialStatus: 'ACTIVE', usageLimit: 500, freeTrialExpiry: now / 1000 }
    }),
    now
  )
  assert.equal(usage.freeTrialLimit, 0)
})

test('malformed numeric values never poison totals and packs sort by expiry without mutating input', () => {
  const data = response({
    currentUsageWithPrecision: NaN,
    currentUsage: 2,
    usageLimitWithPrecision: -1,
    usageLimit: 100,
    overageCredits: [
      { currentUsage: -10, usageLimit: Infinity },
      { usageLimit: 200, expiresAt: future },
      { usageLimit: 50, expiresAt: '2026-12-01T00:00:00Z' }
    ]
  })
  const before = JSON.stringify(data)
  const usage = parseAccountUsage(data, now)
  assert.equal(usage.current, 2)
  assert.equal(usage.limit, 350)
  assert.equal(usage.addOnCredits[0].expiresAt, '2026-12-01T00:00:00.000Z')
  assert.equal(JSON.stringify(data), before)
  assert.equal(parseAccountUsage(null, now).limit, 0)
  assert.equal(parseAccountUsage({ usageBreakdownList: 'wrong' }, now).percentUsed, 0)
})
