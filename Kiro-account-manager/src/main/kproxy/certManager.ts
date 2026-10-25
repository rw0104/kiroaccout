// K-Proxy CA certificates: native key parsing and WebCrypto signing.
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  createCertificateAuthority, issueServerCertificate, normalizeCertificateHostname,
  validateCertificatePair, type CertificatePair
} from '../certificates'
import type { CACertInfo } from './types'

const initializations = new Map<string, Promise<CACertInfo>>()

async function loadOrCreateCA(dataPath: string): Promise<CACertInfo> {
  fs.mkdirSync(dataPath, { recursive: true })
  const certPath = path.join(dataPath, 'kproxy-ca.crt')
  const keyPath = path.join(dataPath, 'kproxy-ca.key')
  let pair: CertificatePair | undefined
  if (fs.existsSync(certPath) || fs.existsSync(keyPath)) {
    // A missing/mismatched key must not silently replace an already trusted CA.
    if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) throw new Error('Incomplete existing CA certificate/key pair')
    pair = { cert: fs.readFileSync(certPath, 'utf8'), key: fs.readFileSync(keyPath, 'utf8') }
    const existing = validateCertificatePair(pair, true)
    if (Date.parse(existing.validFrom) > Date.now()) throw new Error('Existing CA certificate is not yet valid')
    if (Date.parse(existing.validTo) <= Date.now()) pair = undefined
  }
  if (!pair) {
    pair = await createCertificateAuthority()
    fs.writeFileSync(keyPath, pair.key, { mode: 0o600 })
    fs.writeFileSync(certPath, pair.cert)
  }
  const cert = validateCertificatePair(pair, true)
  return { certPath, keyPath, certPem: pair.cert, keyPem: pair.key, fingerprint: cert.fingerprint256,
    validFrom: new Date(cert.validFrom), validTo: new Date(cert.validTo) }
}

export class CertManager {
  private readonly dataPath: string
  private caInfo: CACertInfo | null = null
  private initialization: Promise<CACertInfo> | null = null
  private readonly certCache = new Map<string, { expires: number; promise: Promise<CertificatePair> }>()

  constructor(dataPath: string) { this.dataPath = path.resolve(dataPath) }

  initialize(): Promise<CACertInfo> {
    if (this.caInfo && this.caInfo.validTo.getTime() > Date.now()) return Promise.resolve(this.caInfo)
    if (this.initialization) return this.initialization
    const identity = process.platform === 'win32' ? this.dataPath.toLowerCase() : this.dataPath
    let pending = initializations.get(identity)
    if (!pending) {
      pending = loadOrCreateCA(this.dataPath)
      initializations.set(identity, pending)
      void pending.finally(() => { if (initializations.get(identity) === pending) initializations.delete(identity) }).catch(() => {})
    }
    this.initialization = pending.then(info => {
      this.certCache.clear()
      this.caInfo = info
      return info
    }).finally(() => { this.initialization = null })
    return this.initialization
  }

  generateCertForHost(hostname: string): Promise<CertificatePair> {
    if (!this.caInfo) return Promise.reject(new Error('CA certificate not initialized'))
    const host = normalizeCertificateHostname(hostname)
    const cacheKey = `${this.caInfo.fingerprint}:${host}`
    const cached = this.certCache.get(cacheKey)
    if (cached && cached.expires > Date.now()) return cached.promise
    const expires = Math.min(Date.now() + 365 * 86400_000, this.caInfo.validTo.getTime())
    const promise = issueServerCertificate([host], { cert: this.caInfo.certPem, key: this.caInfo.keyPem }, { notAfter: new Date(expires) })
    this.certCache.set(cacheKey, { expires, promise })
    void promise.catch(() => { if (this.certCache.get(cacheKey)?.promise === promise) this.certCache.delete(cacheKey) })
    return promise
  }

  getCACertInfo(): CACertInfo | null { return this.caInfo }
  getCACertPem(): string | null { return this.caInfo?.certPem || null }
  clearCache(): void { this.certCache.clear() }
}

export function createCertManager(dataPath: string): CertManager { return new CertManager(dataPath) }
