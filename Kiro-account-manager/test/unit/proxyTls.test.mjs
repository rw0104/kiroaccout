import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { createCertificateAuthority, issueServerCertificate } from '../../src/main/certificates.ts'
import { fetch } from 'undici'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const source = readFileSync(new URL('../../src/main/proxy/systemProxy.ts', import.meta.url), 'utf8')
const context = { exports: {}, require, URL, console, Buffer }
vm.runInNewContext(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText, context)
const make = context.exports.safeCreateProxyAgent

async function certificates() {
  const ca = await createCertificateAuthority()
  const [valid, wrong] = await Promise.all([
    issueServerCertificate(['tls-test.invalid'], ca), issueServerCertificate(['wrong-name.invalid'], ca)
  ])
  return { ca: ca.cert, valid, wrong }
}

test('real HTTP CONNECT and SOCKS reject untrusted/wrong-host TLS before sending credentials; scoped CA succeeds', async () => {
  const certs = await certificates(), sockets = new Set(), servers = [], agents = []
  let delivered = 0, activePort = 0
  const track = socket => { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)) }
  async function listen(server) {
    servers.push(server); server.on('connection', track)
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    return server.address().port
  }
  const handler = (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer SYNTHETIC_TEST_ONLY')
    delivered++; res.end('synthetic')
  }
  const validPort = await listen(https.createServer(certs.valid, handler))
  const wrongPort = await listen(https.createServer(certs.wrong, handler))
  const bridge = (client, reply, extra) => {
    const remote = net.connect(activePort, '127.0.0.1'); track(remote)
    remote.once('connect', () => { client.write(reply); if (extra?.length) remote.write(extra); client.pipe(remote); remote.pipe(client) })
  }
  const proxy = http.createServer()
  proxy.on('connect', (_req, socket, head) => bridge(socket, 'HTTP/1.1 200 Connection Established\r\n\r\n', head))
  const httpPort = await listen(proxy)
  const socksPort = await listen(net.createServer(client => {
    let buffer = Buffer.alloc(0), stage = 0
    function read(chunk) {
      buffer = Buffer.concat([buffer, chunk])
      if (stage === 0) {
        if (buffer.length < 2 || buffer.length < 2 + buffer[1]) return
        buffer = buffer.subarray(2 + buffer[1]); stage = 1; client.write(Buffer.from([5, 0]))
      }
      if (stage === 1) {
        if (buffer.length < 5) return
        assert.equal(buffer[3], 3)
        const size = 7 + buffer[4]
        if (buffer.length < size) return
        stage = 2; client.removeListener('data', read)
        bridge(client, Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, activePort >> 8, activePort & 255]), buffer.subarray(size))
      }
    }
    client.on('data', read)
  }))
  async function run(proxyUrl, options, expected, expectedCode) {
    const before = delivered, agent = make(proxyUrl, options); agents.push(agent)
    const action = async () => {
      const response = await fetch(`https://tls-test.invalid:${activePort}/`, {
        dispatcher: agent, headers: { authorization: 'Bearer SYNTHETIC_TEST_ONLY' }, signal: AbortSignal.timeout(3000)
      })
      return response.text()
    }
    if (expected) { assert.equal(await action(), 'synthetic'); assert.equal(delivered, before + 1) }
    else {
      await assert.rejects(action, error => {
        const codes = []
        for (let cause = error; cause; cause = cause.cause) codes.push(cause.code)
        assert.ok(codes.some(code => expectedCode ? code === expectedCode :
          ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT'].includes(code)),
        `must fail certificate verification, received ${codes}`)
        return true
      })
      assert.equal(delivered, before, 'rejected TLS must never deliver HTTP credentials')
    }
  }
  try {
    for (const proxyUrl of [`http://127.0.0.1:${httpPort}`, `socks5://127.0.0.1:${socksPort}`]) {
      activePort = validPort
      await run(proxyUrl, undefined, false)
      await run(proxyUrl, { rejectUnauthorized: false }, false)
      await run(proxyUrl, { targetCa: certs.ca }, true)
      activePort = wrongPort
      await run(proxyUrl, { targetCa: certs.ca }, false, 'ERR_TLS_CERT_ALTNAME_INVALID')
      activePort = validPort
      await run(proxyUrl, undefined, false) // the previous CA must not leak to another dispatcher
    }
    const secureProxyPort = await listen(https.createServer(certs.valid))
    await run(`https://127.0.0.1:${secureProxyPort}`, undefined, false)
  } finally {
    await Promise.allSettled(agents.map(agent => agent.destroy()))
    for (const socket of sockets) socket.destroy()
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))))
  }
})
