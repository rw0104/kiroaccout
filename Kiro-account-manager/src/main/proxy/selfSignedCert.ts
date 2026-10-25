import * as fs from 'node:fs'
import * as path from 'node:path'
import { isIP } from 'node:net'
import { certificateNames, createSelfSignedServerCertificate, normalizeCertificateHostname, validateCertificatePair, type CertificatePair } from '../certificates'

export interface ProxySelfSignedCert {
  cert: string
  key: string
  fingerprint: string
  notBefore: number
  notAfter: number
  subject: string
  altNames: string[]
}

const directoryJobs = new Map<string, Promise<ProxySelfSignedCert>>()
const matchingJobs = new Map<string, Promise<ProxySelfSignedCert>>()

function describe(pair: CertificatePair): ProxySelfSignedCert {
  const cert = validateCertificatePair(pair)
  return { ...pair, fingerprint: cert.fingerprint256, notBefore: Date.parse(cert.validFrom),
    notAfter: Date.parse(cert.validTo), ...certificateNames(pair.cert) }
}

async function loadOrCreate(dataPath: string, hostnames: string[], forceRegen: boolean): Promise<ProxySelfSignedCert> {
  const certDir = path.join(dataPath, 'proxy-tls')
  const certPath = path.join(certDir, 'proxy.crt'), keyPath = path.join(certDir, 'proxy.key')
  fs.mkdirSync(certDir, { recursive: true })
  if (!forceRegen && fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    try {
      const pair = { cert: fs.readFileSync(certPath, 'utf8'), key: fs.readFileSync(keyPath, 'utf8') }
      const cert = validateCertificatePair(pair)
      const now = Date.now()
      if (Date.parse(cert.validFrom) <= now && Date.parse(cert.validTo) - 30 * 86400_000 > now &&
        hostnames.every(host => isIP(host) ? cert.checkIP(host) : cert.checkHost(host))) return describe(pair)
    } catch { /* The standalone server certificate can be regenerated; CA trust is handled separately. */ }
  }
  const pair = await createSelfSignedServerCertificate(hostnames)
  fs.writeFileSync(keyPath, pair.key, { mode: 0o600 })
  fs.writeFileSync(certPath, pair.cert)
  return describe(pair)
}

/** Serialize writes per directory and coalesce identical concurrent requests. */
export function ensureProxySelfSignedCert(dataPath: string, hostnames: string[] = [], forceRegen = false): Promise<ProxySelfSignedCert> {
  const names = [...new Set(['localhost', '127.0.0.1', '::1', ...hostnames
    .filter(name => name?.trim() && !['0.0.0.0', '::', '[::]'].includes(name.trim()))]
    .map(normalizeCertificateHostname))].sort()
  const resolved = path.resolve(dataPath)
  const directoryKey = process.platform === 'win32' ? resolved.toLowerCase() : resolved
  const requestKey = JSON.stringify([directoryKey, names, forceRegen])
  const matching = matchingJobs.get(requestKey)
  if (matching) return matching
  const pending = (directoryJobs.get(directoryKey) || Promise.resolve()).catch(() => {}).then(() => loadOrCreate(resolved, names, forceRegen))
  matchingJobs.set(requestKey, pending)
  directoryJobs.set(directoryKey, pending)
  void pending.finally(() => {
    matchingJobs.delete(requestKey)
    if (directoryJobs.get(directoryKey) === pending) directoryJobs.delete(directoryKey)
  }).catch(() => {})
  return pending
}
