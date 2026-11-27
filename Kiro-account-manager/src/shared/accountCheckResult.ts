/** A failed operation can leave the last confirmed account status intact. */
export interface BackgroundAccountResult extends CredentialVersion {
  id: string
  success: boolean
  preserveStatus?: boolean
  /** The renewal completed even if the following health check failed. */
  credentialsRefreshed?: boolean
  data?: unknown
  error?: string
}

export interface CredentialVersion {
  expectedAccessToken?: string
  expectedRefreshToken?: string
}

export interface AccountCredentialsUpdate {
  id: string
  credentials: Record<string, unknown>
  profileArn?: string
  previous?: CredentialVersion
}
