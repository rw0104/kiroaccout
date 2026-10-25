import 'reflect-metadata'
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { X509Certificate, createPrivateKey } from 'node:crypto'
import { createSecureContext } from 'node:tls'
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { resolve, relative, isAbsolute, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { X509Certificate as ParsedCertificate, BasicConstraintsExtension, KeyUsagesExtension, KeyUsageFlags } from '@peculiar/x509'
import { createCertificateAuthority, issueServerCertificate, createSelfSignedServerCertificate } from '../../src/main/certificates.ts'
import { CertManager } from '../../src/main/kproxy/certManager.ts'
import { ensureProxySelfSignedCert } from '../../src/main/proxy/selfSignedCert.ts'

// Only generated fixtures below the repository's ignored isolation directory.
// These tests never inspect the installed application's CA or account data.
const isolatedRoot = resolve(fileURLToPath(new URL('../../../.local/isolated/', import.meta.url)))
await mkdir(isolatedRoot, { recursive: true })
const fixtureRoot = await mkdtemp(join(isolatedRoot, 'certificate-tests-'))
after(async () => {
  const within = relative(isolatedRoot, resolve(fixtureRoot))
  assert.ok(within && !isAbsolute(within) && within !== '..' && !within.startsWith(`..${sep}`))
  await rm(fixtureRoot, { recursive: true, force: true })
})
const fixture = async name => {
  const directory = join(fixtureRoot, name)
  await mkdir(directory, { recursive: true })
  return directory
}
const x509 = value => new X509Certificate(value.cert || value.certPem)
const keyMatches = value => x509(value).checkPrivateKey(createPrivateKey(value.key || value.keyPem))
const serverAuthOid = '1.3.6.1.5.5.7.3.1'
const clientAuthOid = '1.3.6.1.5.5.7.3.2'
const assertServerPurpose = certificate => {
  assert.equal(certificate.ca, false)
  assert.ok(certificate.keyUsage?.includes(serverAuthOid), 'server authentication EKU is required')
  assert.ok(!certificate.keyUsage?.includes(clientAuthOid), 'server certificates must not grant client authentication')
  const parsed = new ParsedCertificate(certificate.raw)
  assert.equal(parsed.getExtension(KeyUsagesExtension)?.usages, KeyUsageFlags.digitalSignature | KeyUsageFlags.keyEncipherment)
  assert.equal(parsed.getExtension(BasicConstraintsExtension)?.ca, false)
}

let authorityPromise
const authority = () => authorityPromise ||= createCertificateAuthority()

test('generated CA is a valid self-signed CA with a matching private key and bounded validity', async () => {
  const generated = await authority()
  const certificate = x509(generated)
  assert.equal(certificate.ca, true)
  assert.equal(certificate.subject, certificate.issuer)
  assert.equal(certificate.verify(certificate.publicKey), true)
  assert.equal(keyMatches(generated), true)
  const parsed = new ParsedCertificate(certificate.raw)
  assert.equal(parsed.getExtension(KeyUsagesExtension)?.usages, KeyUsageFlags.keyCertSign | KeyUsageFlags.cRLSign)
  assert.equal(parsed.getExtension(BasicConstraintsExtension)?.critical, true)
  assert.ok(Date.parse(certificate.validFrom) <= Date.now() + 5000)
  const validDays = (Date.parse(certificate.validTo) - Date.now()) / 86400000
  assert.ok(validDays > 3600 && validDays < 3665, `unexpected CA validity: ${validDays}`)
  assert.doesNotThrow(() => createSecureContext({ cert: generated.cert, key: generated.key }))
})

test('issued server certificate verifies against its CA with DNS/IPv4/IPv6 SANs and server-only purpose', async () => {
  const ca = await authority()
  const generated = await issueServerCertificate(['synthetic.example.invalid', '127.0.0.1', '::1'], ca)
  const certificate = x509(generated)
  assert.equal(certificate.verify(x509(ca).publicKey), true)
  assert.equal(certificate.checkHost('synthetic.example.invalid'), 'synthetic.example.invalid')
  assert.equal(certificate.checkHost('unrelated.example.invalid'), undefined)
  assert.equal(certificate.checkIP('127.0.0.1'), '127.0.0.1')
  assert.equal(certificate.checkIP('::1'), '::1')
  assert.equal(certificate.checkIP('127.0.0.2'), undefined)
  assert.equal(keyMatches(generated), true)
  assertServerPurpose(certificate)
  assert.ok(Date.parse(certificate.validFrom) <= Date.now() + 5000)
  const validDays = (Date.parse(certificate.validTo) - Date.now()) / 86400000
  assert.ok(validDays > 360 && validDays < 367)
  assert.ok(Date.parse(certificate.validTo) <= Date.parse(x509(ca).validTo))
  assert.doesNotThrow(() => createSecureContext({ cert: generated.cert, key: generated.key, ca: ca.cert }))
})

test('explicit server expiry is honored without issuing beyond the authority expiry', async () => {
  const ca = await authority()
  const requested = new Date(Date.now() + 7 * 86400000)
  const leaf = x509(await issueServerCertificate(['short-lived.example.invalid'], ca, { notAfter: requested }))
  assert.ok(Math.abs(Date.parse(leaf.validTo) - requested.getTime()) < 1000)
  const tooLong = new Date(Date.parse(x509(ca).validTo) + 365 * 86400000)
  const capped = x509(await issueServerCertificate(['capped.example.invalid'], ca, { notAfter: tooLong }))
  assert.ok(Date.parse(capped.validTo) <= Date.parse(x509(ca).validTo))
})

test('server certificate expiry stays in UTC during the repeated daylight-saving hour', async () => {
  const helperUrl = new URL('../../src/main/certificates.ts', import.meta.url).href
  const loader = new URL('./register-ts-resolve.mjs', import.meta.url).href
  const script = `
    import { createCertificateAuthority, issueServerCertificate } from ${JSON.stringify(helperUrl)};
    import { X509Certificate } from 'node:crypto';
    const year = new Date().getUTCFullYear() + 1;
    const expiry = new Date(Date.UTC(year, 10, 1, 9, 30, 0, 123));
    expiry.setUTCDate(1 + (7 - expiry.getUTCDay()) % 7);
    const pair = await issueServerCertificate(['dst.example.invalid'], await createCertificateAuthority(), { notAfter: expiry });
    console.log(JSON.stringify({ requested: expiry.getTime(), actual: Date.parse(new X509Certificate(pair.cert).validTo) }));
  `
  const { stdout } = await promisify(execFile)(process.execPath,
    ['--disable-warning=ExperimentalWarning', '--import', loader, '--input-type=module', '-e', script],
    { env: { ...process.env, TZ: 'America/Los_Angeles' }, timeout: 30000 })
  const result = JSON.parse(stdout.trim())
  assert.ok(Math.abs(result.actual - result.requested) < 1000, 'ASN.1 second rounding must not select the other DST hour')
})

test('self-signed server helper has matching keys, correct SAN types and server-only purpose', async () => {
  const generated = await createSelfSignedServerCertificate(['self.example.invalid', '127.0.0.1', '::1'])
  const certificate = x509(generated)
  assert.equal(certificate.verify(certificate.publicKey), true)
  assert.equal(keyMatches(generated), true)
  assert.equal(certificate.checkHost('self.example.invalid'), 'self.example.invalid')
  assert.equal(certificate.checkIP('127.0.0.1'), '127.0.0.1')
  assert.equal(certificate.checkIP('::1'), '::1')
  assertServerPurpose(certificate)
  const validDays = (Date.parse(certificate.validTo) - Date.now()) / 86400000
  assert.ok(validDays > 725 && validDays < 733)
})

test('existing CA reload preserves certificate and PKCS1/PKCS8 key bytes without changing trust', async () => {
  const ca = await authority()
  for (const type of ['pkcs1', 'pkcs8']) {
    const directory = await fixture(`reload-${type}`)
    const storedKey = createPrivateKey(ca.key).export({ format: 'pem', type })
    const certPath = join(directory, 'kproxy-ca.crt')
    const keyPath = join(directory, 'kproxy-ca.key')
    await writeFile(certPath, ca.cert)
    await writeFile(keyPath, storedKey)
    const beforeCert = await readFile(certPath)
    const beforeKey = await readFile(keyPath)
    const first = await new CertManager(directory).initialize()
    const second = await new CertManager(directory).initialize()
    assert.equal(first.fingerprint, x509(ca).fingerprint256)
    assert.equal(second.fingerprint, first.fingerprint)
    assert.ok((await readFile(certPath)).equals(beforeCert), `${type}: certificate bytes changed`)
    assert.ok((await readFile(keyPath)).equals(beforeKey), `${type}: key bytes changed`)
    assert.equal(keyMatches(first), true)
  }
})

test('CA mismatch is rejected while leaving the existing trust files untouched', async () => {
  const ca = await authority()
  const other = await createCertificateAuthority()
  const directory = await fixture('mismatched-authority')
  const certPath = join(directory, 'kproxy-ca.crt')
  const keyPath = join(directory, 'kproxy-ca.key')
  await writeFile(certPath, ca.cert)
  await writeFile(keyPath, other.key)
  const beforeCert = await readFile(certPath)
  const beforeKey = await readFile(keyPath)
  await assert.rejects(new CertManager(directory).initialize())
  assert.ok((await readFile(certPath)).equals(beforeCert))
  assert.ok((await readFile(keyPath)).equals(beforeKey))
})

test('distinct CA managers never share a cached leaf for the same hostname', async () => {
  const firstManager = new CertManager(await fixture('first-ca'))
  const secondManager = new CertManager(await fixture('second-ca'))
  const [firstCa, secondCa] = await Promise.all([firstManager.initialize(), secondManager.initialize()])
  const [firstLeaf, secondLeaf] = await Promise.all([
    firstManager.generateCertForHost('same.example.invalid'),
    secondManager.generateCertForHost('same.example.invalid')
  ])
  assert.notEqual(x509(firstLeaf).fingerprint256, x509(secondLeaf).fingerprint256)
  assert.equal(x509(firstLeaf).verify(x509(firstCa).publicKey), true)
  assert.equal(x509(secondLeaf).verify(x509(secondCa).publicKey), true)
  assert.equal(x509(firstLeaf).verify(x509(secondCa).publicKey), false)
  assert.equal(x509(secondLeaf).verify(x509(firstCa).publicKey), false)
})

test('same manager deduplicates concurrent CA initialization and concurrent host certificate generation', async () => {
  const manager = new CertManager(await fixture('manager-concurrent'))
  const authorities = await Promise.all(Array.from({ length: 8 }, () => manager.initialize()))
  assert.equal(new Set(authorities.map(value => value.fingerprint)).size, 1)
  const leaves = await Promise.all(Array.from({ length: 12 }, () => manager.generateCertForHost('concurrent.example.invalid')))
  assert.equal(new Set(leaves.map(value => x509(value).fingerprint256)).size, 1)
  assert.ok(leaves.every(keyMatches))
  assert.equal(x509(leaves[0]).verify(x509(authorities[0]).publicKey), true)
  const cached = await manager.generateCertForHost('concurrent.example.invalid')
  assert.equal(x509(cached).fingerprint256, x509(leaves[0]).fingerprint256)
})

test('proxy self-signed concurrent initialization persists one usable certificate with default loopback SANs', async () => {
  const directory = await fixture('self-signed-concurrent')
  const values = await Promise.all(Array.from({ length: 10 }, () => ensureProxySelfSignedCert(directory, ['proxy.example.invalid'])))
  assert.equal(new Set(values.map(value => value.fingerprint)).size, 1)
  const current = values[0]
  const certificate = x509(current)
  assert.equal(certificate.fingerprint256, current.fingerprint)
  assert.ok(values.every(keyMatches))
  assert.equal(certificate.checkHost('localhost'), 'localhost')
  assert.equal(certificate.checkHost('proxy.example.invalid'), 'proxy.example.invalid')
  assert.equal(certificate.checkIP('127.0.0.1'), '127.0.0.1')
  assert.equal(certificate.checkIP('::1'), '::1')
  assertServerPurpose(certificate)
  assert.equal(new X509Certificate(await readFile(join(directory, 'proxy-tls', 'proxy.crt'))).fingerprint256, current.fingerprint)
  const reloaded = await ensureProxySelfSignedCert(directory, ['proxy.example.invalid'])
  assert.equal(reloaded.fingerprint, current.fingerprint)
})

test('proxy self-signed loader repairs a mismatched private key instead of serving an invalid TLS pair', async () => {
  const directory = await fixture('self-signed-mismatch')
  const current = await ensureProxySelfSignedCert(directory, ['proxy.example.invalid'])
  const unrelatedKey = (await authority()).key
  await writeFile(join(directory, 'proxy-tls', 'proxy.key'), unrelatedKey)
  const repaired = await ensureProxySelfSignedCert(directory, ['proxy.example.invalid'])
  assert.equal(keyMatches(repaired), true)
  assert.notEqual(repaired.fingerprint, current.fingerprint)
  assert.doesNotThrow(() => createSecureContext({ cert: repaired.cert, key: repaired.key }))
})
