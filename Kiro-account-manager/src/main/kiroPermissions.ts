import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import {
  isAlias,
  isCollection,
  isMap,
  isPair,
  isScalar,
  isSeq,
  parseAllDocuments,
  parseDocument,
  type Document,
  type ParsedNode,
  type YAMLMap,
  type YAMLSeq
} from 'yaml'
import {
  KIRO_AUTO_APPROVAL_RULES,
  KIRO_AUTO_APPROVAL_TEMPLATE_YAML,
  type KiroAutoApprovalCapability,
  type KiroAutoApprovalRulePresence,
  type KiroPermissionsContentStatus,
  type KiroPermissionsErrorCode,
  type KiroPermissionsRestrictionSummary,
  type KiroPermissionsRevision
} from '../shared/kiroPermissions'

export const MAX_PERMISSIONS_BYTES = 1024 * 1024
export const MAX_PERMISSIONS_RULES = 4096

const KNOWN_CAPABILITIES = new Set<string>([
  'all',
  'builtin',
  'filesystem',
  'fs_read',
  'fs_write',
  'shell',
  'web_fetch',
  'web_search',
  'mcp',
  'subagent',
  'skill',
  'power',
  'context',
  'diagnostics',
  'workflow',
  'sandbox_network'
])

const KNOWN_EFFECTS = new Set<string>(['allow', 'ask', 'deny', 'evaluate'])
const KNOWN_RULE_KEYS = new Set<string>(['capability', 'effect', 'match', 'exclude'])

export class KiroPermissionsError extends Error {
  readonly code: KiroPermissionsErrorCode
  constructor(code: KiroPermissionsErrorCode, message: string) {
    super(message)
    this.name = 'KiroPermissionsError'
    this.code = code
  }
}

export function sha256Buffer(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

export function sha256String(content: string): string {
  return sha256Buffer(Buffer.from(content, 'utf8'))
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function assertSafeAstNode(node: unknown): void {
  if (!node || typeof node !== 'object') return
  const candidate = node as { anchor?: string; tag?: string }
  if (isAlias(node)) {
    throw new KiroPermissionsError(
      'INVALID_YAML',
      '权限配置文件包含 YAML 别名引用，无法安全修改；原文件未更改。'
    )
  }
  if (typeof candidate.anchor === 'string' && candidate.anchor.length > 0) {
    throw new KiroPermissionsError(
      'INVALID_YAML',
      '权限配置文件包含 YAML 锚点，无法安全修改；原文件未更改。'
    )
  }
  if (typeof candidate.tag === 'string' && candidate.tag.length > 0) {
    throw new KiroPermissionsError(
      'INVALID_YAML',
      '权限配置文件包含自定义 YAML 标签，无法安全修改；原文件未更改。'
    )
  }
  if (isMap(node)) {
    const keys = new Set<string>()
    for (const pair of node.items) {
      if (!isPair(pair) || !isScalar(pair.key) || typeof pair.key.value !== 'string') {
        throw new KiroPermissionsError(
          'INVALID_YAML',
          '权限配置文件包含非字符串键，无法安全修改；原文件未更改。'
        )
      }
      assertSafeAstNode(pair.key)
      if (keys.has(pair.key.value)) {
        throw new KiroPermissionsError(
          'INVALID_YAML',
          '权限配置文件包含重复键，请修正后重试；原文件未更改。'
        )
      }
      keys.add(pair.key.value)
      assertSafeAstNode(pair.value)
    }
    return
  }
  if (isSeq(node)) {
    for (const item of node.items) {
      assertSafeAstNode(item)
    }
    return
  }
  if (isCollection(node)) {
    throw new KiroPermissionsError(
      'INVALID_YAML',
      '权限配置文件包含不支持的集合类型；原文件未更改。'
    )
  }
}

function parseValidatedYamlDocument(content: string): {
  doc: ReturnType<typeof parseAllDocuments>[number]
  hasBom: boolean
  eol: '\r\n' | '\n'
  body: string
} {
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > MAX_PERMISSIONS_BYTES) {
    throw new KiroPermissionsError(
      'FILE_TOO_LARGE',
      '权限配置文件超过 1 MiB 处理上限；原文件未更改。'
    )
  }
  const hasBom = content.startsWith('\uFEFF')
  const body = hasBom ? content.slice(1) : content
  if (body.includes('\0')) {
    throw new KiroPermissionsError(
      'INVALID_YAML',
      '权限配置文件包含非法空字符；原文件未更改。'
    )
  }
  const eol: '\r\n' | '\n' = body.includes('\r\n') ? '\r\n' : '\n'
  const docs = parseAllDocuments(body, {
    strict: true,
    uniqueKeys: true,
    merge: false,
    intAsBigInt: true
  })
  if (docs.length > 1) {
    throw new KiroPermissionsError(
      'INVALID_YAML',
      '权限配置文件包含多个 YAML 文档，无法安全修改；原文件未更改。'
    )
  }
  const doc =
    docs[0] ??
    parseDocument(body, {
      strict: true,
      uniqueKeys: true,
      merge: false,
      intAsBigInt: true
    })
  if (doc.errors.length > 0 || doc.warnings.length > 0) {
    throw new KiroPermissionsError(
      'INVALID_YAML',
      '权限配置文件不是有效的 YAML 或包含重复键；原文件未更改。'
    )
  }
  if (doc.contents !== null && !isMap(doc.contents)) {
    throw new KiroPermissionsError(
      'INVALID_YAML',
      '权限配置文件根节点必须是 YAML 对象；原文件未更改。'
    )
  }
  assertSafeAstNode(doc.contents)
  return { doc, hasBom, eol, body }
}

function isUnconditionalTemplateRule(
  rule: Record<string, unknown>,
  capability: KiroAutoApprovalCapability
): boolean {
  const keys = Object.keys(rule)
  if (keys.length !== 2) return false
  if (!keys.includes('capability') || !keys.includes('effect')) return false
  return rule.capability === capability && rule.effect === 'allow'
}

function isValidStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(item => typeof item === 'string' && item.length > 0)
  )
}

function isRecognizedRuleSemantics(rule: Record<string, unknown>): boolean {
  const keys = Object.keys(rule)
  if (keys.some(key => !KNOWN_RULE_KEYS.has(key))) return false
  if (typeof rule.capability !== 'string' || !KNOWN_CAPABILITIES.has(rule.capability)) return false
  if (typeof rule.effect !== 'string' || !KNOWN_EFFECTS.has(rule.effect)) return false
  if (rule.match !== undefined && !isValidStringArray(rule.match)) return false
  if (rule.exclude !== undefined && !isValidStringArray(rule.exclude)) return false
  return true
}

export interface KiroPermissionsInspection {
  revision: KiroPermissionsRevision
  contentStatus: KiroPermissionsContentStatus
  presence: KiroAutoApprovalRulePresence
  restrictions: KiroPermissionsRestrictionSummary
  rulesSnapshot: Array<Record<string, unknown>>
  topLevelSnapshot: Record<string, unknown>
}

export function emptyPermissionsInspection(): KiroPermissionsInspection {
  return {
    revision: { exists: false, sha256: null },
    contentStatus: 'unconfigured',
    presence: {
      allAllow: false,
      fsWriteAllow: false,
      missingRules: ['all', 'fs_write']
    },
    restrictions: {
      askCount: 0,
      denyCount: 0,
      evaluateCount: 0,
      scopedAllowCount: 0,
      unknownRuleCount: 0,
      hasPolicyReferences: false,
      hasRestrictiveRules: false
    },
    rulesSnapshot: [],
    topLevelSnapshot: {}
  }
}

export function inspectKiroPermissionsDocument(
  content: string | null | undefined
): KiroPermissionsInspection {
  if (content === null || content === undefined) {
    return emptyPermissionsInspection()
  }
  const { doc } = parseValidatedYamlDocument(content)
  const sha256 = sha256String(content)

  let allAllow = false
  let fsWriteAllow = false
  let askCount = 0
  let denyCount = 0
  let evaluateCount = 0
  let scopedAllowCount = 0
  let unknownRuleCount = 0
  let hasPolicyReferences = false
  const rulesSnapshot: Array<Record<string, unknown>> = []
  const topLevelSnapshot: Record<string, unknown> = {}

  if (doc.contents && isMap(doc.contents)) {
    const rootMap = doc.contents as YAMLMap<ParsedNode, ParsedNode | null>
    for (const pair of rootMap.items) {
      if (!isScalar(pair.key) || typeof pair.key.value !== 'string') continue
      const key = pair.key.value
      if (key === 'rules') continue
      topLevelSnapshot[key] = pair.value && typeof (pair.value as any).toJS === 'function'
        ? (pair.value as any).toJS(doc)
        : null
    }

    if ('policies' in topLevelSnapshot && topLevelSnapshot.policies !== undefined && topLevelSnapshot.policies !== null) {
      const policies = topLevelSnapshot.policies
      if (!Array.isArray(policies) || !policies.every(item => typeof item === 'string')) {
        throw new KiroPermissionsError(
          'INVALID_YAML',
          '权限配置文件中的 policies 字段必须是字符串数组；原文件未更改。'
        )
      }
      hasPolicyReferences = policies.length > 0
    }

    const rulesPair = rootMap.items.find(
      pair => isScalar(pair.key) && pair.key.value === 'rules'
    )
    if (rulesPair) {
      if (!rulesPair.value || !isSeq(rulesPair.value)) {
        throw new KiroPermissionsError(
          'INVALID_YAML',
          '权限配置文件中的 rules 字段必须是数组；原文件未更改。'
        )
      }
      const rulesSeq = rulesPair.value as YAMLSeq<ParsedNode | null>
      if (rulesSeq.items.length > MAX_PERMISSIONS_RULES) {
        throw new KiroPermissionsError(
          'TOO_MANY_RULES',
          '权限配置文件规则数量超过 4096 条上限；原文件未更改。'
        )
      }
      for (const itemNode of rulesSeq.items) {
        if (!itemNode || !isMap(itemNode)) {
          throw new KiroPermissionsError(
            'INVALID_YAML',
            '权限配置文件中的规则项必须是对象；原文件未更改。'
          )
        }
        const jsRule: unknown = itemNode.toJS(doc as unknown as Document)
        if (!isPlainObject(jsRule)) {
          throw new KiroPermissionsError(
            'INVALID_YAML',
            '权限配置文件中的规则项必须是对象；原文件未更改。'
          )
        }
        rulesSnapshot.push(jsRule)
        if (isUnconditionalTemplateRule(jsRule, 'all')) {
          allAllow = true
          continue
        }
        if (isUnconditionalTemplateRule(jsRule, 'fs_write')) {
          fsWriteAllow = true
          continue
        }
        const recognized = isRecognizedRuleSemantics(jsRule)
        if (!recognized) {
          unknownRuleCount++
        }
        if (jsRule.effect === 'ask') {
          askCount++
        } else if (jsRule.effect === 'deny') {
          denyCount++
        } else if (jsRule.effect === 'evaluate') {
          evaluateCount++
        } else if (
          jsRule.effect === 'allow' &&
          (recognized || jsRule.match !== undefined || jsRule.exclude !== undefined)
        ) {
          scopedAllowCount++
        }
      }
    }
  }

  const missingRules: KiroAutoApprovalCapability[] = []
  if (!allAllow) missingRules.push('all')
  if (!fsWriteAllow) missingRules.push('fs_write')

  const contentStatus: KiroPermissionsContentStatus =
    missingRules.length === 0
      ? 'configured'
      : missingRules.length === KIRO_AUTO_APPROVAL_RULES.length
        ? 'unconfigured'
        : 'partial'

  return {
    revision: { exists: true, sha256 },
    contentStatus,
    presence: {
      allAllow,
      fsWriteAllow,
      missingRules
    },
    restrictions: {
      askCount,
      denyCount,
      evaluateCount,
      scopedAllowCount,
      unknownRuleCount,
      hasPolicyReferences,
      hasRestrictiveRules: askCount > 0 || denyCount > 0
    },
    rulesSnapshot,
    topLevelSnapshot
  }
}

export interface KiroAutoApprovalMergePlan {
  changed: boolean
  addedRules: KiroAutoApprovalCapability[]
  content: string
  beforeHash: string | null
  afterHash: string
  beforeInspection: KiroPermissionsInspection
  afterInspection: KiroPermissionsInspection
}

export function planKiroAutoApprovalMerge(
  content: string | null | undefined
): KiroAutoApprovalMergePlan {
  const beforeInspection = inspectKiroPermissionsDocument(content)
  const missingRules = beforeInspection.presence.missingRules
  if (missingRules.length === 0 && typeof content === 'string') {
    return {
      changed: false,
      addedRules: [],
      content,
      beforeHash: beforeInspection.revision.sha256,
      afterHash: beforeInspection.revision.sha256!,
      beforeInspection,
      afterInspection: beforeInspection
    }
  }

  if (
    beforeInspection.rulesSnapshot.length + missingRules.length >
    MAX_PERMISSIONS_RULES
  ) {
    throw new KiroPermissionsError(
      'TOO_MANY_RULES',
      '合并后规则数量将超过 4096 条上限；原文件未更改。'
    )
  }

  let nextContent: string
  if (content === null || content === undefined) {
    nextContent = KIRO_AUTO_APPROVAL_TEMPLATE_YAML
  } else {
    const { doc, hasBom, eol, body } = parseValidatedYamlDocument(content)
    const hasComments =
      Boolean(doc.commentBefore) ||
      Boolean(doc.comment) ||
      body.includes('#')
    if (doc.contents === null && !hasComments) {
      const normalizedTemplate =
        eol === '\r\n'
          ? KIRO_AUTO_APPROVAL_TEMPLATE_YAML.replace(/\n/g, '\r\n')
          : KIRO_AUTO_APPROVAL_TEMPLATE_YAML
      nextContent = (hasBom ? '\uFEFF' : '') + normalizedTemplate
    } else {
      const rulesToAdd = missingRules.map(capability => ({
        capability,
        effect: 'allow' as const
      }))
      if (doc.contents === null) {
        if (!doc.commentBefore && doc.comment) {
          doc.commentBefore = doc.comment
          doc.comment = null
        }
        doc.contents = doc.createNode({ rules: rulesToAdd }) as unknown as ParsedNode
      } else if (isMap(doc.contents)) {
        const rootMap = doc.contents as YAMLMap<ParsedNode, ParsedNode | null>
        if (rootMap.flow && rootMap.items.length === 0) {
          rootMap.flow = false
        }
        const rulesPair = rootMap.items.find(
          pair => isScalar(pair.key) && pair.key.value === 'rules'
        )
        if (!rulesPair) {
          doc.set('rules', doc.createNode(rulesToAdd))
        } else if (rulesPair.value && isSeq(rulesPair.value)) {
          const rulesSeq = rulesPair.value as YAMLSeq<unknown>
          if (rulesSeq.flow && rulesSeq.items.length === 0) {
            rulesSeq.flow = false
          }
          for (const rule of rulesToAdd) {
            rulesSeq.add(doc.createNode(rule))
          }
        } else {
          throw new KiroPermissionsError(
            'INVALID_YAML',
            '权限配置文件中的 rules 字段必须是数组；原文件未更改。'
          )
        }
      }
      const rendered = doc.toString({ lineWidth: 0 })
      const withEol = eol === '\r\n' ? rendered.replace(/\r?\n/g, '\r\n') : rendered
      nextContent = (hasBom ? '\uFEFF' : '') + withEol
    }
  }

  const afterInspection = inspectKiroPermissionsDocument(nextContent)
  if (
    !afterInspection.presence.allAllow ||
    !afterInspection.presence.fsWriteAllow ||
    afterInspection.presence.missingRules.length !== 0
  ) {
    throw new KiroPermissionsError(
      'VERIFY_FAILED',
      '权限配置合并后未能确认双规则齐全；原文件未更改。'
    )
  }

  const preservedPrefix = afterInspection.rulesSnapshot.slice(
    0,
    beforeInspection.rulesSnapshot.length
  )
  if (
    afterInspection.rulesSnapshot.length !==
      beforeInspection.rulesSnapshot.length + missingRules.length ||
    !isDeepStrictEqual(preservedPrefix, beforeInspection.rulesSnapshot) ||
    !isDeepStrictEqual(afterInspection.topLevelSnapshot, beforeInspection.topLevelSnapshot)
  ) {
    throw new KiroPermissionsError(
      'VERIFY_FAILED',
      '权限配置合并校验发现原有规则或字段发生变化；原文件未更改。'
    )
  }

  return {
    changed: true,
    addedRules: [...missingRules],
    content: nextContent,
    beforeHash: beforeInspection.revision.sha256,
    afterHash: afterInspection.revision.sha256!,
    beforeInspection,
    afterInspection
  }
}
