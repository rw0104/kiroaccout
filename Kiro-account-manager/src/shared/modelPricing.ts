/**
 * Display-only credit rules from official Kiro release notes. They are never
 * attached to model requests or used to replace service-reported credit use.
 */
export interface PricingModel {
  id: string
  name?: string
  rateMultiplier?: number
  rateUnit?: string
}

export type CreditPricingTier =
  | { upToTokens: number; multiplier: number }
  | { aboveTokens: number; multiplier: number }

interface DocumentedRule {
  thresholdTokens: number
  shortMultiplier: number
  longMultiplier: number
  sourceUrl: string
  verifiedOn: string
}

export type ModelPricingInfo =
  | {
      kind: 'tiered'
      tiers: CreditPricingTier[]
      unit: string
      sourceUrl: string
      verifiedOn: string
    }
  | {
      kind: 'catalog'
      multiplier: number
      unit: string
      documentedRateMismatch: boolean
      sourceUrl?: string
      verifiedOn?: string
    }

const VERIFIED_ON = '2026-10-24'
const GPT_SOURCE = 'https://kiro.dev/changelog/models/gpt-5-6-1m-context-window/'
const RULES: Readonly<Record<string, DocumentedRule>> = {
  'claude-haiku-5.5': {
    thresholdTokens: 100000,
    shortMultiplier: 0.06,
    longMultiplier: 0.3,
    sourceUrl: 'https://kiro.dev/changelog/models/claude-haiku-5-5/',
    verifiedOn: VERIFIED_ON
  },
  ...Object.fromEntries(
    [
      ['sol', 4.4],
      ['terra', 2.2],
      ['luna', 1.1]
    ].map(([name, rate]) => [
      `gpt-5.6-${name}`,
      {
        thresholdTokens: 272000,
        shortMultiplier: Number(rate),
        longMultiplier: Number(rate) * 2,
        sourceUrl: GPT_SOURCE,
        verifiedOn: VERIFIED_ON
      }
    ])
  )
}

function normalizeIdentity(value?: string): string {
  if (typeof value !== 'string') return ''
  return value
    .trim()
    .toLowerCase()
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/[\s_]+/g, '-')
    .replace(/^(?:anthropic|openai)[.:/]/, '')
    .replace(/-\d{8}(?:-v\d+-\d+)?$/, '')
}

function canonicalIdentity(value?: string): string | undefined {
  const identity = normalizeIdentity(value)
  const claude = /^claude-(haiku|sonnet|opus|fable)-(\d+)[.-](\d+)$/.exec(identity)
  if (claude) return `claude-${claude[1]}-${claude[2]}.${claude[3]}`
  const gpt = /^gpt-(\d+)[.-](\d+)-(sol|terra|luna)$/.exec(identity)
  if (gpt) return `gpt-${gpt[1]}.${gpt[2]}-${gpt[3]}`
  return undefined
}

function documentedRule(model: PricingModel): DocumentedRule | undefined {
  const id = canonicalIdentity(model.id)
  const name = canonicalIdentity(model.name)
  if (id) {
    if (name && name !== id) return undefined
    return RULES[id]
  }
  // An explicit, unrecognized model variant must not inherit the price of a
  // nearby named model. An opaque catalog ID may use an exact public name.
  if (/(?:^|-)(?:claude|gpt)(?:-|$)/.test(normalizeIdentity(model.id))) return undefined
  return name ? RULES[name] : undefined
}

export function getModelPricing(model: PricingModel): ModelPricingInfo | undefined {
  const rate = model.rateMultiplier
  if (rate !== undefined && (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0))
    return undefined
  const rule = documentedRule(model)
  const unit =
    typeof model.rateUnit === 'string' && model.rateUnit.trim() ? model.rateUnit.trim() : 'credit'
  if (rule && (rate === undefined || Math.abs(rate - rule.shortMultiplier) < 1e-10)) {
    return {
      kind: 'tiered',
      tiers: [
        { upToTokens: rule.thresholdTokens, multiplier: rule.shortMultiplier },
        { aboveTokens: rule.thresholdTokens, multiplier: rule.longMultiplier }
      ],
      unit,
      sourceUrl: rule.sourceUrl,
      verifiedOn: rule.verifiedOn
    }
  }
  if (rate === undefined) return undefined
  return {
    kind: 'catalog',
    multiplier: rate,
    unit,
    documentedRateMismatch: Boolean(rule),
    ...(rule ? { sourceUrl: rule.sourceUrl, verifiedOn: rule.verifiedOn } : {})
  }
}

export function formatPricingTier(tier: CreditPricingTier): string {
  const tokens = 'upToTokens' in tier ? tier.upToTokens : tier.aboveTokens
  const threshold = tokens % 1000 === 0 ? `${tokens / 1000}K` : String(tokens)
  return `${'upToTokens' in tier ? '≤' : '>'}${threshold}: ${tier.multiplier}x`
}
