import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { gzipSync } from 'node:zlib'
import { createRemoteImageDownloader, isPublicImageAddress } from '../../src/main/proxy/remoteImage.ts'

const publicAnswers = async () => [{ address: '8.8.8.8', family: 4 }]
async function fixture(t, handler) {
  const sockets = new Set(), targets = [], requests = [], servers = []
  function track(socket) { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)) }
  async function listen(server) {
    servers.push(server); server.on('connection', track)
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    return server.address().port
  }
  const port = await listen(http.createServer((req, res) => { requests.push(req.url); handler(req, res) }))
  const proxy = http.createServer()
  proxy.on('connect', (req, client, head) => {
    targets.push(req.url)
    const remote = net.connect(port, '127.0.0.1'); track(remote)
    client.once('close', () => remote.destroy())
    remote.once('close', () => client.destroy())
    remote.once('connect', () => { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) remote.write(head); client.pipe(remote); remote.pipe(client) })
  })
  const proxyPort = await listen(proxy)
  t.after(async () => { for (const socket of sockets) socket.destroy(); await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve)))) })
  return { targets, requests, download: options => createRemoteImageDownloader({ lookup: publicAnswers, getProxyUrl: () => `http://127.0.0.1:${proxyPort}`, ...options }) }
}

test('image address policy rejects private, reserved and non-global IPv4/IPv6 and mapped variants', () => {
  for (const address of ['0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1',
    '192.0.0.1', '192.0.2.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255',
    '::', '::1', 'fe80::1', 'fc00::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '64:ff9b::a00:1',
    '2001:db8::1', '2001::1', '2002:a00:1::', '3fff::1', 'not-an-address']) {
    assert.equal(isPublicImageAddress(address), false, address)
  }
  for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8']) {
    assert.equal(isPublicImageAddress(address), true, address)
  }
})

test('reject invalid protocols, credentials, private literals and mixed DNS before any connection', async t => {
  const f = await fixture(t, (_req, res) => res.end())
  const download = f.download()
  for (const url of ['file:///etc/passwd', 'ftp://example.invalid/a', 'http://user:pass@example.invalid/a',
    'http://127.1/a', 'http://2130706433/a', 'http://[::ffff:127.0.0.1]/a', 'http://169.254.169.254/a']) {
    await assert.rejects(download(url))
  }
  await assert.rejects(f.download({ lookup: async () => [...await publicAnswers(), { address: '127.0.0.1', family: 4 }] })('http://mixed.invalid/a'), /public|address/i)
  await assert.rejects(f.download({ getProxyUrl: () => 'unsupported://localhost:42' })('http://public.invalid/a'), /proxy/i)
  assert.equal(f.targets.length, 0)
})

test('public image remains supported and DNS is resolved once then CONNECT binds the validated IP', async t => {
  const f = await fixture(t, (req, res) => { assert.equal(req.headers.host, 'public.invalid'); res.setHeader('content-type', 'image/png'); res.end('synthetic-image') })
  let lookups = 0
  const download = f.download({ lookup: async () => ++lookups === 1 ? publicAnswers() : [{ address: '127.0.0.1', family: 4 }] })
  assert.equal(await download('http://public.invalid/image'), 'data:image/png;base64,c3ludGhldGljLWltYWdl')
  assert.equal(lookups, 1)
  assert.deepEqual(f.targets, ['8.8.8.8:80'])
})

test('every redirect is checked, including same-host DNS changes and IPv6/private destinations', async t => {
  const f = await fixture(t, (_req, res) => { res.writeHead(302, { location: 'http://[::1]/secret' }); res.end() })
  await assert.rejects(f.download()('http://public.invalid/a'), /public|address/i)
  assert.deepEqual(f.requests, ['/a'])
  const rebound = await fixture(t, (_req, res) => { res.writeHead(302, { location: '/next' }); res.end() })
  let lookups = 0
  await assert.rejects(rebound.download({ lookup: async () => ++lookups === 1 ? publicAnswers() : [{ address: '10.0.0.1', family: 4 }] })('http://public.invalid/a'), /public|address/i)
  assert.equal(lookups, 2)
  assert.equal(rebound.targets.length, 1)
})

test('public redirects work, redirect loops stop at five, and response headers are bounded', async t => {
  const f = await fixture(t, (req, res) => {
    if (req.url === '/final') { res.writeHead(200, { 'content-type': 'image/webp' }); res.end('image') }
    else { res.writeHead(302, { location: '/final' }); res.end() }
  })
  assert.match(await f.download()('http://public.invalid/a'), /^data:image\/webp;base64,/)
  const loop = await fixture(t, (_req, res) => { res.writeHead(302, { location: '/loop' }); res.end() })
  await assert.rejects(loop.download()('http://public.invalid/a'), /redirect/i)
  assert.equal(loop.requests.length, 6)
  const hugeHeader = await fixture(t, (_req, res) => { res.writeHead(200, { 'content-type': 'image/png', 'x-test': 'a'.repeat(20000) }); res.end('x') })
  await assert.rejects(hugeHeader.download()('http://public.invalid/a'))
})

test('length headers, chunked streams and decompressed bodies enforce the 10MB limit', async t => {
  const hugeLength = await fixture(t, (_req, res) => { res.writeHead(200, { 'content-type': 'image/png', 'content-length': 11 * 1024 * 1024 }); res.flushHeaders() })
  await assert.rejects(hugeLength.download()('http://public.invalid/a'), /10MB/i)
  let closed = false
  const stream = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'image/png' })
    const timer = setInterval(() => res.write(Buffer.alloc(256 * 1024)), 1)
    res.on('close', () => { closed = true; clearInterval(timer) })
  })
  await assert.rejects(stream.download()('http://public.invalid/a'), /10MB/i)
  // Socket shutdown propagates asynchronously to the local fixture.
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(closed, true)
  const compressed = gzipSync(Buffer.alloc(11 * 1024 * 1024))
  const bomb = await fixture(t, (_req, res) => { res.writeHead(200, { 'content-type': 'image/png', 'content-encoding': 'gzip', 'content-length': compressed.length }); res.end(compressed) })
  await assert.rejects(bomb.download()('http://public.invalid/a'), /10MB/i)
  // Valid gzip containing many empty stored blocks: large on the wire, empty after decoding.
  const emptyBlocks = Buffer.alloc(Math.ceil(11 * 1024 * 1024 / 5) * 5, Buffer.from([0, 0, 0, 255, 255]))
  const wireOnly = Buffer.concat([Buffer.from('1f8b0800000000000003', 'hex'), emptyBlocks,
    Buffer.from([1, 0, 0, 255, 255]), Buffer.alloc(8)])
  const wireLimit = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'image/png', 'content-encoding': 'gzip' })
    res.flushHeaders(); res.end(wireOnly)
  })
  await assert.rejects(wireLimit.download()('http://public.invalid/a'), /10MB/i)
})

test('caller cancellation and total timeout also cover stalled bodies and DNS', async t => {
  const f = await fixture(t, (_req, res) => { res.writeHead(200, { 'content-type': 'image/png' }); res.flushHeaders() })
  const controller = new AbortController()
  const pending = f.download()('http://public.invalid/a', controller.signal)
  setTimeout(() => controller.abort(new Error('synthetic cancel')), 25)
  await assert.rejects(pending, /synthetic cancel|abort/i)
  await assert.rejects(f.download({ timeoutMs: 30 })('http://public.invalid/a'), /timeout|timed out/i)
  await assert.rejects(f.download({ timeoutMs: 30, lookup: async () => new Promise(() => {}) })('http://public.invalid/a'), /timeout|timed out/i)
  const aborted = AbortSignal.abort(new Error('already canceled'))
  const before = f.targets.length
  await assert.rejects(f.download()('http://public.invalid/a', aborted), /already canceled/)
  assert.equal(f.targets.length, before)
})

test('SOCKS uses the verified IP instead of remote DNS and cancellation interrupts negotiation', async t => {
  const sockets = new Set(), destinations = [], servers = []
  let stall = false
  async function listen(server) {
    servers.push(server)
    server.on('connection', socket => { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)) })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    return server.address().port
  }
  const socksPort = await listen(net.createServer(client => {
    if (stall) return
    let stage = 0, data = Buffer.alloc(0)
    client.on('data', chunk => {
      data = Buffer.concat([data, chunk])
      if (stage === 0) {
        if (data.length < 2 || data.length < data[1] + 2) return
        data = data.subarray(data[1] + 2); stage = 1; client.write(Buffer.from([5, 0]))
      }
      if (stage === 1) {
        if (data.length < 10) return
        assert.equal(data[3], 1, 'must send IPv4 address, never a remotely resolved hostname')
        destinations.push([...data.subarray(4, 8)].join('.'))
        data = data.subarray(10); stage = 2
        client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 80]))
      }
      if (stage === 2 && data.includes('\r\n\r\n')) {
        stage = 3; client.end('HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: 5\r\nConnection: close\r\n\r\nimage')
      }
    })
  }))
  t.after(async () => { for (const socket of sockets) socket.destroy(); await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve)))) })
  const options = { lookup: publicAnswers, getProxyUrl: () => `socks5h://127.0.0.1:${socksPort}` }
  assert.equal(await createRemoteImageDownloader(options)('http://public.invalid/a'), 'data:image/png;base64,aW1hZ2U=')
  assert.deepEqual(destinations, ['8.8.8.8'])
  stall = true
  const start = Date.now()
  await assert.rejects(createRemoteImageDownloader({ ...options, timeoutMs: 40 })('http://public.invalid/a'), /timed out|abort/i)
  assert.ok(Date.now() - start < 1000, 'abort must not wait for the 5s SOCKS handshake deadline')
})
