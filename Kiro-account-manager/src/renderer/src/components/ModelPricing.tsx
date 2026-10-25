import { Zap } from 'lucide-react'
import { formatPricingTier, getModelPricing } from '../../../shared/modelPricing'
import type { PricingModel } from '../../../shared/modelPricing'

interface ModelPricingProps {
  model: PricingModel
  isEn: boolean
}

export function ModelPricing({ model, isEn }: ModelPricingProps): React.ReactNode {
  const pricing = getModelPricing(model)
  if (!pricing) return null
  return (
    <div className="mt-2 space-y-1 text-[10px] leading-relaxed">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-amber-700 dark:text-amber-400">
        <Zap className="h-3 w-3 shrink-0" aria-hidden="true" />
        {pricing.kind === 'tiered' && (
          <span className="text-muted-foreground">{isEn ? 'Context tokens' : '上下文 tokens'}</span>
        )}
        {pricing.kind === 'tiered' ? (
          pricing.tiers.map((tier, index) => (
            <span key={index} className="font-mono">
              {formatPricingTier(tier)}
            </span>
          ))
        ) : (
          <span className="font-mono">
            {isEn ? 'Catalog rate' : '目录倍率'}: {pricing.multiplier}x
          </span>
        )}
        <span className="break-all text-muted-foreground">{pricing.unit}</span>
      </div>
      {pricing.kind === 'catalog' && pricing.documentedRateMismatch && (
        <p className="text-muted-foreground">
          {isEn
            ? 'The catalog rate differs from the verified tiers. Check the official pricing.'
            : '目录倍率与已核对规则不同，请查看官方计费说明。'}
        </p>
      )}
      <div className="flex flex-wrap items-baseline gap-x-2 text-muted-foreground">
        {pricing.sourceUrl && (
          <>
            <button
              type="button"
              className="text-primary underline underline-offset-2 hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-sm"
              onClick={() => window.api.openExternal(pricing.sourceUrl!)}
            >
              {isEn ? 'Official pricing' : '官方计费说明'}
            </button>
            <span>
              {isEn ? 'Verified' : '核对于'} {pricing.verifiedOn}
            </span>
          </>
        )}
        <span>
          {isEn ? 'Actual credit use is returned by Kiro.' : '实际消耗以 Kiro 返回为准。'}
        </span>
      </div>
    </div>
  )
}
