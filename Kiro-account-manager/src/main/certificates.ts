import 'reflect-metadata'
import { createPrivateKey, randomBytes, webcrypto, X509Certificate } from 'node:crypto'
import { isIP } from 'node:net'
import { domainToASCII } from 'node:url'
import { Time } from '@peculiar/asn1-x509'
import {
  AuthorityKeyIdentifierExtension, BasicConstraintsExtension, ExtendedKeyUsageExtension,
  KeyUsageFlags, KeyUsagesExtension, SubjectAlternativeNameExtension, SubjectKeyIdentifierExtension,
  X509Certificate as ParsedCertificate, X509CertificateGenerator, type Extension
} from '@peculiar/x509'

export interface CertificatePair { cert: string; key: string }
const provider = webcrypto as unknown as Crypto
const RSA = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) }
const SERVER_AUTH = '1.3.6.1.5.5.7.3.1'

export function normalizeCertificateHostname(input: string): string {
  const host = input.trim().replace(/^\[|\]$/g, '')
  if (isIP(host) && !host.includes('%')) return host.toLowerCase()
  const ascii = domainToASCII(host.replace(/\.$/, '')).toLowerCase()
  if (!ascii || ascii.length > 253 || !ascii.split('.').every(label =>
    label.length > 0 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) {
    throw new Error('Invalid certificate hostname')
  }
  return ascii
}

function serialNumber(): string {
  const bytes = randomBytes(16)
  bytes[0] = (bytes[0] & 0x7f) || 1
  return bytes.toString('hex')
}

function expiresInYears(years: number): Date {
  const date = new Date()
  date.setFullYear(date.getFullYear() + years)
  return date
}

// asn1-x509 2.11's Time(Date) uses local setMilliseconds(0), which changes the
// second occurrence of a DST-overlap hour. Its supported Time schema constructor
// preserves UTC exactly. x509 2.2's generator type only declares Date although it
// forwards this value to Time, so keep this compatibility cast at one boundary.
function certificateTime(date: Date): Date {
  const utc = new Date(Math.floor(date.getTime() / 1000) * 1000)
  return new Time(utc.getUTCFullYear() >= 2050 || utc.getUTCFullYear() < 1950
    ? { generalTime: utc } : { utcTime: utc }) as unknown as Date
}

async function generateKeys(): Promise<CryptoKeyPair> {
  return provider.subtle.generateKey(RSA, true, ['sign', 'verify']) as Promise<CryptoKeyPair>
}

async function privateKeyPem(key: CryptoKey): Promise<string> {
  const der = await provider.subtle.exportKey('pkcs8', key)
  return createPrivateKey({ key: Buffer.from(der), format: 'der', type: 'pkcs8' })
    .export({ format: 'pem', type: 'pkcs8' }).toString()
}

/** Node's native X509/key parser accepts both legacy PKCS#1 and current PKCS#8 PEM. */
export function validateCertificatePair(pair: CertificatePair, requireCa = false): X509Certificate {
  const cert = new X509Certificate(pair.cert)
  const key = createPrivateKey(pair.key)
  if (!cert.checkPrivateKey(key)) throw new Error('Certificate and private key do not match')
  if (requireCa && (!cert.ca || !cert.verify(cert.publicKey))) throw new Error('Invalid self-signed certificate authority')
  return cert
}

function serverExtensions(hostnames: string[]): Extension[] {
  const names = [...new Set(hostnames.map(normalizeCertificateHostname))]
  if (!names.length) throw new Error('A server certificate requires a hostname')
  return [
    new BasicConstraintsExtension(false, undefined, true),
    new KeyUsagesExtension(KeyUsageFlags.digitalSignature | KeyUsageFlags.keyEncipherment, true),
    new ExtendedKeyUsageExtension([SERVER_AUTH]),
    new SubjectAlternativeNameExtension(names.map(value => ({ type: isIP(value) ? 'ip' as const : 'dns' as const, value })))
  ]
}

export async function createCertificateAuthority(): Promise<CertificatePair> {
  const keys = await generateKeys()
  const cert = await X509CertificateGenerator.createSelfSigned({
    serialNumber: serialNumber(), name: 'CN=K-Proxy CA,O=Kiro Account Manager,C=CN',
    notBefore: certificateTime(new Date(Date.now() - 60000)), notAfter: certificateTime(expiresInYears(10)), keys, signingAlgorithm: RSA,
    extensions: [new BasicConstraintsExtension(true, undefined, true),
      new KeyUsagesExtension(KeyUsageFlags.keyCertSign | KeyUsageFlags.cRLSign, true),
      await SubjectKeyIdentifierExtension.create(keys.publicKey, false, provider)]
  }, provider)
  return { cert: cert.toString('pem'), key: await privateKeyPem(keys.privateKey) }
}

export async function issueServerCertificate(
  hostnames: string[], authority: CertificatePair, options: { notAfter?: Date } = {}
): Promise<CertificatePair> {
  const ca = validateCertificatePair(authority, true)
  const now = Date.now()
  const notBefore = new Date(Math.max(now - 60000, Date.parse(ca.validFrom)))
  const notAfter = new Date(Math.min((options.notAfter || expiresInYears(1)).getTime(), Date.parse(ca.validTo)))
  if (notBefore.getTime() > now || notAfter.getTime() <= now) throw new Error('Certificate authority is not currently valid')
  const key = createPrivateKey(authority.key)
  if (key.asymmetricKeyType !== 'rsa') throw new Error('Unsupported certificate authority key type')
  const signingKey = await provider.subtle.importKey('pkcs8',
    new Uint8Array(key.export({ format: 'der', type: 'pkcs8' })), RSA, false, ['sign'])
  const extensions = serverExtensions(hostnames)
  const keys = await generateKeys()
  const issuer = new ParsedCertificate(authority.cert)
  const cert = await X509CertificateGenerator.create({
    serialNumber: serialNumber(), subject: [{ CN: [normalizeCertificateHostname(hostnames[0])] }, { O: ['K-Proxy'] }],
    issuer: issuer.subjectName, notBefore: certificateTime(notBefore), notAfter: certificateTime(notAfter),
    publicKey: keys.publicKey, signingKey, signingAlgorithm: RSA,
    extensions: [...extensions, await SubjectKeyIdentifierExtension.create(keys.publicKey, false, provider),
      await AuthorityKeyIdentifierExtension.create(issuer.publicKey, false, provider)]
  }, provider)
  return { cert: cert.toString('pem'), key: await privateKeyPem(keys.privateKey) }
}

export async function createSelfSignedServerCertificate(hostnames: string[]): Promise<CertificatePair> {
  const extensions = serverExtensions(hostnames)
  const keys = await generateKeys()
  const cert = await X509CertificateGenerator.createSelfSigned({
    serialNumber: serialNumber(), name: 'CN=Kiro Reverse Proxy,O=Kiro Account Manager,C=CN',
    notBefore: certificateTime(new Date(Date.now() - 60000)), notAfter: certificateTime(expiresInYears(2)), keys, signingAlgorithm: RSA,
    extensions: [...extensions, await SubjectKeyIdentifierExtension.create(keys.publicKey, false, provider)]
  }, provider)
  return { cert: cert.toString('pem'), key: await privateKeyPem(keys.privateKey) }
}

export function certificateNames(certPem: string): { subject: string; altNames: string[] } {
  const parsed = new ParsedCertificate(certPem)
  return {
    subject: parsed.subjectName.getField('CN')[0] || '',
    altNames: parsed.getExtension(SubjectAlternativeNameExtension)?.names.items
      .filter(name => name.type === 'dns' || name.type === 'ip').map(name => name.value) || []
  }
}
