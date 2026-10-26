import type { KiroSettingsTarget } from './kiroSettings'

export const KIRO_AUTO_APPROVAL_TEMPLATE_VERSION = '2026-10-26-v1'

export const KIRO_AUTO_APPROVAL_TEMPLATE_YAML =
  'rules:\n  - capability: all\n    effect: allow\n\n  - capability: fs_write\n    effect: allow\n'

export type KiroAutoApprovalCapability = 'all' | 'fs_write'

export const KIRO_AUTO_APPROVAL_RULES: ReadonlyArray<{
  capability: KiroAutoApprovalCapability
  effect: 'allow'
}> = [
  { capability: 'all', effect: 'allow' },
  { capability: 'fs_write', effect: 'allow' }
]

export interface KiroPermissionsTargetInfo {
  type: 'default' | 'instance'
  instanceId?: string
  label: string
  permissionsPath: string
}

export type KiroPermissionsCompatibilityStatus = 'supported' | 'unverified' | 'unsupported'

export interface KiroPermissionsCompatibility {
  status: KiroPermissionsCompatibilityStatus
  ideVersion?: string
  writable: boolean
  reason?: string
}

export type KiroPermissionsContentStatus = 'unconfigured' | 'partial' | 'configured' | 'invalid'

export interface KiroPermissionsRevision {
  exists: boolean
  sha256: string | null
}

export interface KiroPermissionsRestrictionSummary {
  askCount: number
  denyCount: number
  evaluateCount: number
  scopedAllowCount: number
  unknownRuleCount: number
  hasPolicyReferences: boolean
  hasRestrictiveRules: boolean
}

export interface KiroAutoApprovalRulePresence {
  allAllow: boolean
  fsWriteAllow: boolean
  missingRules: KiroAutoApprovalCapability[]
}

export type KiroPermissionsRestoreStatus =
  | 'none'
  | 'available'
  | 'external_modified'
  | 'pending_verification'
  | 'corrupted'

export interface KiroPermissionsRestoreInfo {
  status: KiroPermissionsRestoreStatus
  canRestore: boolean
  operationId?: string
  appliedAt?: string
  addedRules?: KiroAutoApprovalCapability[]
  originalExisted?: boolean
  backupDir?: string
  message?: string
}

export type KiroPermissionsErrorCode =
  | 'UNTRUSTED_SENDER'
  | 'INVALID_TARGET'
  | 'PATH_REDIRECTED'
  | 'COMPATIBILITY_UNVERIFIED'
  | 'FILE_TOO_LARGE'
  | 'TOO_MANY_RULES'
  | 'INVALID_YAML'
  | 'JSON_POLICY_READ_ONLY'
  | 'REVISION_CONFLICT'
  | 'OPERATION_IN_PROGRESS'
  | 'BACKUP_FAILED'
  | 'WRITE_FAILED'
  | 'VERIFY_FAILED'
  | 'NO_RESTORE_SNAPSHOT'
  | 'RESTORE_CONFLICT'
  | 'EXPORT_FAILED'
  | 'IO_ERROR'

export interface KiroPermissionsState {
  target: KiroPermissionsTargetInfo
  compatibility: KiroPermissionsCompatibility
  contentStatus: KiroPermissionsContentStatus
  revision: KiroPermissionsRevision
  presence: KiroAutoApprovalRulePresence
  restrictions: KiroPermissionsRestrictionSummary
  restore: KiroPermissionsRestoreInfo
  parseError?: string
}

export interface KiroPermissionsStateResult {
  success: boolean
  state?: KiroPermissionsState
  error?: string
  code?: KiroPermissionsErrorCode
}

export interface KiroPermissionsWriteResult {
  success: boolean
  changed?: boolean
  addedRules?: KiroAutoApprovalCapability[]
  state?: KiroPermissionsState
  error?: string
  code?: KiroPermissionsErrorCode
}

export interface KiroPermissionsRestoreResult {
  success: boolean
  restored?: boolean
  state?: KiroPermissionsState
  error?: string
  code?: KiroPermissionsErrorCode
}

export interface KiroPermissionsExportResult {
  success: boolean
  canceled?: boolean
  error?: string
  code?: KiroPermissionsErrorCode
}

export type { KiroSettingsTarget }
