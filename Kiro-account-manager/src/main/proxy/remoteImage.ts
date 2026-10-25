import { lookup as dnsLookup } from 'node:dns/promises'
import type { LookupAddress } from 'node:dns'
import { isIP, connect as connectTcp, type Socket } from 'node:net'
import { connect as connectTls, checkServerIdentity } from 'node:tls'
import { Agent, Client, fetch as fetchImage, type Dispatcher } from 'undici'
import { SocksClient } from 'socks'
import { getSystemProxy } from './systemProxy'

const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const MAX_HEADERS_BYTES = 16 * 1024
const MAX_REDIRECTS = 5
const CONNECT_TIMEOUT_MS = 5000
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])

function ipv4Number(address: string): number {
  return address.split('.').reduce((value, part) => value * 256 + Number(part), 0)
}

function inV4Range(value: number, base: string, bits: number): boolean {
  const block = 2 ** (32 - bits)
  return Math.floor(value / block) === Math.floor(ipv4Number(base) / block)
}

function ipv6Number(address: string): bigint {
  const normalized = address.replace(/\d+\.\d+\.\d+\.\d+$/, match => {
    const value = ipv4Number(match)
    return `${Math.floor(value / 65536).toString(16)}:${(value % 65536).toString(16)}`
  })
  const [left, right] = normalized.split('::')
  const a = left ? left.split(':') : []
  const b = right ? right.split(':') : []
  const words = right === undefined ? a : [...a, ...Array(8 - a.length - b.length).fill('0'), ...b]
  return words.reduce((value, word) => (value << 16n) | BigInt(`0x${word}`), 0n)
}

/** Conservative global-unicast allowlist; transition ranges cannot embed a private destination. */
export function isPublicImageAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) {
    const value = ipv4Number(address)
    const excluded: [string, number][] = [
      ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
      ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
      ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
      ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
    ]
    return !excluded.some(([base, bits]) => inV4Range(value, base, bits))
  }
  if (family !== 6 || address.includes('%')) return false
  const value = ipv6Number(address)
  if (value >> 32n === 0xffffn) {
    const v4 = Number(value & 0xffffffffn)
    return isPublicImageAddress([24, 16, 8, 0].map(shift => (v4 >>> shift) & 255).join('.'))
  }
  const inRange = (base: string, bits: number): boolean => value >> BigInt(128 - bits) === ipv6Number(base) >> BigInt(128 - bits)
  return inRange('2000::', 3) && !inRange('2001::', 23) && !inRange('2001:db8::', 32) &&
    !inRange('2002::', 16) && !inRange('3fff::', 20)
}

interface ImageTarget {
  url: URL
  hostname: string
  address: string
  port: number
}

interface ImageDependencies {
  lookup?: (hostname: string) => Promise<LookupAddress[]>
  getProxyUrl?: () => string | null | undefined
  timeoutMs?: number
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = (): void => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

async function resolveTarget(rawUrl: string, lookup: NonNullable<ImageDependencies['lookup']>, signal: AbortSignal): Promise<ImageTarget> {
  const url = new URL(rawUrl)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Remote image URL must use HTTP(S) without credentials')
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  const records = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await abortable(lookup(hostname), signal)
  if (!records.length || records.some(record => !isPublicImageAddress(record.address))) {
    throw new Error('Remote image URL must resolve only to public IP addresses')
  }
  // The connector receives this literal address, never the hostname for a second DNS lookup.
  return { url, hostname, address: records[0].address, port: Number(url.port) || (url.protocol === 'https:' ? 443 : 80) }
}

function parseProxy(raw: string | null | undefined): URL | undefined {
  if (!raw) return undefined
  let proxy: URL
  try { proxy = new URL(raw) } catch { throw new Error('Invalid remote image proxy URL') }
  if (!['http:', 'https:', 'socks5:', 'socks5h:', 'socks4:', 'socks4a:'].includes(proxy.protocol)) {
    throw new Error('Unsupported remote image proxy: cannot bind a validated destination address')
  }
  return proxy
}

function createImageDispatcher(target: ImageTarget, proxy: URL | undefined, signal: AbortSignal): { dispatcher: Dispatcher; destroy: () => Promise<void> } {
  const sockets = new Set<Socket>()
  const proxyClient = proxy && ['http:', 'https:'].includes(proxy.protocol)
    ? new Client(proxy.origin, { connect: { rejectUnauthorized: true, timeout: CONNECT_TIMEOUT_MS }, maxHeaderSize: MAX_HEADERS_BYTES })
    : undefined
  const destroySockets = (): void => { for (const socket of sockets) socket.destroy() }
  signal.addEventListener('abort', destroySockets, { once: true })
  const track = (socket: Socket): Socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    if (signal.aborted) socket.destroy()
    return socket
  }
  const waitSocket = (socket: Socket, event: 'connect' | 'secureConnect'): Promise<Socket> => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => socket.destroy(new Error('Image connection timed out')), CONNECT_TIMEOUT_MS)
    const cleanup = (): void => { clearTimeout(timeout); socket.removeListener('error', fail); socket.removeListener('close', closed); socket.removeListener(event, ready) }
    const fail = (error: Error): void => { cleanup(); reject(error) }
    const closed = (): void => fail(new Error('Image connection closed before it was ready'))
    const ready = (): void => { cleanup(); resolve(socket) }
    socket.once('error', fail)
    socket.once('close', closed)
    socket.once(event, ready)
  })
  const dispatcher = new Agent({
    maxHeaderSize: MAX_HEADERS_BYTES,
    maxResponseSize: MAX_IMAGE_BYTES, // cap wire bytes before fetch decompresses them
    connect: (_options, callback): void => {
      void (async () => {
        signal.throwIfAborted()
        let socket: Socket
        if (proxyClient && proxy) {
          const authority = `${target.address.includes(':') ? `[${target.address}]` : target.address}:${target.port}`
          const headers: Record<string, string> = { host: authority }
          if (proxy.username || proxy.password) {
            headers['proxy-authorization'] = `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}`
          }
          const result = await proxyClient.connect({ path: authority, headers, signal })
          // HTTP/1 CONNECT from Client yields a TCP/TLS socket (typed as Duplex upstream).
          socket = track(result.socket as Socket)
          if (result.statusCode !== 200) { socket.destroy(); throw new Error(`Image proxy CONNECT failed: HTTP ${result.statusCode}`) }
        } else if (proxy) {
          if (target.address.includes(':') && (proxy.protocol === 'socks4:' || proxy.protocol === 'socks4a:')) {
            throw new Error('SOCKS4 image proxy cannot bind an IPv6 destination')
          }
          // Own the proxy socket before negotiation so abort also interrupts a stalled SOCKS handshake.
          const proxySocket = await waitSocket(track(connectTcp({
            host: proxy.hostname.replace(/^\[|\]$/g, ''), port: Number(proxy.port) || 1080
          })), 'connect')
          const result = await SocksClient.createConnection({
            proxy: { host: proxy.hostname.replace(/^\[|\]$/g, ''), port: Number(proxy.port) || 1080,
              type: proxy.protocol.startsWith('socks5') ? 5 : 4,
              userId: decodeURIComponent(proxy.username), password: decodeURIComponent(proxy.password) },
            command: 'connect', destination: { host: target.address, port: target.port },
            existing_socket: proxySocket, timeout: CONNECT_TIMEOUT_MS
          })
          socket = track(result.socket)
        } else {
          socket = await waitSocket(track(connectTcp({ host: target.address, port: target.port })), 'connect')
        }
        signal.throwIfAborted()
        if (target.url.protocol === 'https:') {
          socket = await waitSocket(track(connectTls({
            socket, servername: isIP(target.hostname) ? undefined : target.hostname,
            rejectUnauthorized: true, ALPNProtocols: ['http/1.1'],
            checkServerIdentity: (_host, cert) => checkServerIdentity(target.hostname, cert)
          })), 'secureConnect')
        }
        signal.throwIfAborted()
        callback(null, socket)
      })().catch(error => callback(error instanceof Error ? error : new Error('Image connection aborted'), null))
    }
  })
  return {
    dispatcher,
    async destroy(): Promise<void> {
      signal.removeEventListener('abort', destroySockets)
      destroySockets()
      await Promise.allSettled([dispatcher.destroy(), proxyClient?.destroy()])
    }
  }
}

/** Test dependencies supply synthetic DNS/proxies; production always validates and pins every hop. */
export function createRemoteImageDownloader(dependencies: ImageDependencies = {}): (url: string, signal?: AbortSignal) => Promise<string> {
  const lookup = dependencies.lookup || (hostname => dnsLookup(hostname, { all: true, verbatim: true }))
  const getProxyUrl = dependencies.getProxyUrl || (() => process.env.HTTPS_PROXY || process.env.https_proxy ||
    process.env.HTTP_PROXY || process.env.http_proxy || getSystemProxy())
  return async (rawUrl, callerSignal) => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(new Error('Remote image download timed out')), dependencies.timeoutMs ?? 15000)
    const signal = callerSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal
    try {
      signal.throwIfAborted()
      const proxy = parseProxy(getProxyUrl())
      let current = rawUrl
      for (let redirects = 0; ; redirects++) {
        const target = await resolveTarget(current, lookup, signal)
        const connection = createImageDispatcher(target, proxy, signal)
        let response: Awaited<ReturnType<typeof fetchImage>> | undefined
        try {
          response = await fetchImage(target.url, { dispatcher: connection.dispatcher, signal, redirect: 'manual',
            headers: { accept: 'image/jpeg,image/png,image/gif,image/webp' } })
          if ([301, 302, 303, 307, 308].includes(response.status)) {
            if (redirects >= MAX_REDIRECTS) throw new Error('Remote image exceeded five redirects')
            const location = response.headers.get('location')
            if (!location) throw new Error('Remote image redirect has no location')
            current = new URL(location, target.url).href
            continue
          }
          if (!response.ok) throw new Error(`Failed to download image: HTTP ${response.status}`)
          const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
          if (!contentType || !IMAGE_TYPES.has(contentType)) throw new Error('Unsupported image content-type')
          const length = response.headers.get('content-length')
          if (length && Number(length) > MAX_IMAGE_BYTES) throw new Error('Image exceeds 10MB limit')
          if (!response.body) throw new Error('Remote image has no body')
          const reader = response.body.getReader()
          const chunks: Buffer[] = []
          let size = 0
          try {
            while (true) {
              const { done, value } = await reader.read()
              if (done) break
              size += value.byteLength // undici fetch exposes decompressed bytes
              if (size > MAX_IMAGE_BYTES) throw new Error('Image exceeds 10MB limit')
              chunks.push(Buffer.from(value))
            }
          } finally {
            await reader.cancel().catch(() => {})
            reader.releaseLock()
          }
          return `data:${contentType};base64,${Buffer.concat(chunks, size).toString('base64')}`
        } catch (error) {
          const failure = error as { code?: string; cause?: { code?: string } }
          if ([failure?.code, failure?.cause?.code].includes('UND_ERR_RES_EXCEEDED_MAX_SIZE')) {
            throw new Error('Image exceeds 10MB limit')
          }
          throw error
        } finally {
          await response?.body?.cancel().catch(() => {})
          await connection.destroy()
        }
      }
    } finally {
      clearTimeout(timeout)
    }
  }
}

export const downloadRemoteImageDataUrl = createRemoteImageDownloader()
