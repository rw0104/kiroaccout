import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import path from 'node:path'
import * as history from '../../src/shared/logHistory.ts'
import { redactString, redactValue } from '../../src/main/utils/redact.ts'

const ts = createRequire(import.meta.url)('typescript')
const source = readFileSync(new URL('../../src/main/proxy/logger.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
function fixture({ file = null, fileSize, hold = false, archiveFails = false, recentFile = null } = {}) {
  const timers = new Map(), writes = [], streams = []
  let timer = 0, reads = 0
  const archived = []
  const fs = {
    existsSync: filename => filename.endsWith('.recent') ? recentFile !== null : file !== null,
    statSync: filename => ({ size: filename.endsWith('.recent') ? Buffer.byteLength(recentFile ?? '') : fileSize ?? Buffer.byteLength(file ?? '') }),
    readFileSync: filename => { reads++; return filename.endsWith('.recent') ? recentFile : file },
    renameSync: (from, to) => { if (archiveFails) throw new Error('SYNTHETIC_READ_ONLY'); archived.push({ from, to }) }, mkdirSync() {}, readdirSync: () => [], unlinkSync() {},
    createWriteStream() { const stream = { lines: [], writableLength: 0, write(line) { this.lines.push(line); return true }, end() {} }; streams.push(stream); return stream },
    promises: { writeFile(_path, data) {
      let resolve
      const promise = hold ? new Promise(done => { resolve = done }) : Promise.resolve()
      writes.push({ path: _path, data, resolve }); return promise
    } }
  }
  const consoleOutput = []
  const console = Object.fromEntries(['log', 'warn', 'error'].map(level => [level, (...args) => consoleOutput.push({ level, args })]))
  const context = vm.createContext({ exports: {}, Buffer, console, queueMicrotask, crypto: globalThis.crypto,
    setTimeout(callback) { const id = ++timer; timers.set(id, callback); return id }, clearTimeout: id => timers.delete(id),
    require(name) {
      if (name === 'fs') return fs
      if (name === 'path') return path
      if (name === 'electron') return { app: { getPath: () => 'SYNTHETIC_ONLY' } }
      if (name.includes('utils/redact')) return { redactString, redactValue }
      if (name.includes('shared/logHistory')) return history
      throw new Error('Unexpected import ' + name)
    } })
  vm.runInContext(compiled, context)
  const store = context.exports.proxyLogStore
  store.initialize('SYNTHETIC_ONLY')
  return { store, logger: context.exports.proxyLogger, intercept: context.exports.interceptConsole, console, consoleOutput, timers, writes, streams, archived, get reads() { return reads } }
}
const entry = (data, index = 0) => ({ timestamp: '2026-10-23T00:00:00.000Z', level: 'INFO', category: 'Synthetic', message: `event ${index}`, data })

test('audit OTP and device-code examples are removed before the original console and historical log readers see them', async () => {
  const samples = ['验证码: 135790', '提取到验证码: 135790', 'Device code obtained, user_code: SYNTHETIC-CODE']
  const h = fixture({ file: JSON.stringify(samples.map(message => ({ ...entry({}), message }))) })
  h.intercept()
  for (const level of ['log', 'warn', 'error']) {
    for (const message of samples) h.console[level](message, { otp: '135790', deviceCode: 'SYNTHETIC-CODE', user_code: 'SYNTHETIC-CODE', email: 'synthetic@example.invalid' })
  }
  await h.store.flushSaveNow()
  for (const output of [h.consoleOutput, h.store.getAll(), h.writes]) {
    assert.equal(/135790|SYNTHETIC-CODE|synthetic@example\.invalid/.test(JSON.stringify(output)), false, 'sensitive values must not reach a log sink')
  }
  assert.equal(h.store.count(), 12, 'console interception must not recurse or duplicate entries')
})

test('redaction masks whole code fields and common code messages while preserving diagnostic counters', () => {
  const value = redactValue({ code: '123456', verificationCode: 123456, otp: '123456', userCode: 'ABCD-EFGH', device_code: 'DEVICE-VALUE', email: 'synthetic@example.invalid', status: 200, statusCode: 503, inputTokens: 42, attempts: 3 })
  assert.equal(/123456|ABCD-EFGH|DEVICE-VALUE|synthetic@example\.invalid/.test(JSON.stringify(value)), false, 'codes and email addresses are fully masked')
  assert.equal(value.status, 200); assert.equal(value.statusCode, 503); assert.equal(value.inputTokens, 42); assert.equal(value.attempts, 3)
  assert.equal(redactValue({ code: 200 }).code, 200)
  for (const message of ['OTP: 123456', 'verification code is 123456', '设备授权码：ABCD-EFGH', '验证码: 123456', 'email=synthetic@example.invalid', '{"code":123456}', 'code=123456']) {
    assert.equal(/123456|ABCD-EFGH|synthetic@example\.invalid/.test(redactString(message)), false, 'common message template must be redacted')
  }
  assert.equal(redactString('statusCode=503, code=200, attempts=3'), 'statusCode=503, code=200, attempts=3')
})

test('separate console format arguments and old structured history receive contextual code redaction', () => {
  const h = fixture({ file: JSON.stringify([{ ...entry('135790'), message: '验证码:' }]) }); h.intercept()
  h.console.log('[Synthetic] OTP: %s', '135790', { attempts: 3 })
  h.console.warn('[Synthetic] user_code:', 'SYNTHETIC-CODE')
  assert.equal(/135790|SYNTHETIC-CODE/.test(JSON.stringify([h.store.getAll(), h.consoleOutput])), false)
  assert.equal(h.store.getAll()[1].data[1].attempts, 3)
})

test('logger console forwarding and a logging observer cannot cause recursive interception', () => {
  const h = fixture(); h.intercept()
  h.store.onLog(() => h.console.log('[Observer] nested'))
  h.console.log('[Synthetic] single entry')
  assert.equal(h.store.count(), 1)
  h.logger.info('Synthetic', '验证码: 135790', { userCode: 'SYNTHETIC-CODE' })
  assert.equal(/135790|SYNTHETIC-CODE/.test(JSON.stringify(h.consoleOutput)), false)
  assert.ok(h.store.count() <= 3)
})

test('actual console capture snapshots and redacts data without retaining mutable original objects', () => {
  const h = fixture(); h.intercept()
  const data = { nested: { value: 'before' }, accessToken: 'SYNTHETIC_SECRET_DO_NOT_RETAIN', body: 'x'.repeat(100000) }
  h.console.log('[Synthetic] response', data)
  data.nested.value = 'after'
  const actual = h.store.getAll()[0]
  assert.notEqual(actual.data, data)
  assert.equal(actual.data.nested.value, 'before')
  assert.equal(actual.truncated, true)
  assert.doesNotMatch(JSON.stringify(actual), /SYNTHETIC_SECRET_DO_NOT_RETAIN/)
  assert.ok(Buffer.byteLength(JSON.stringify(actual)) <= history.LOG_ENTRY_MAX_BYTES)
})

test('actual memory history enforces both count and byte limits under unique 32 KiB payloads', () => {
  const h = fixture()
  for (let i = 0; i < 2000; i++) h.store.add(entry({ body: `${i}:` + 'q'.repeat(32768) }, i))
  assert.ok(Buffer.byteLength(JSON.stringify(h.store.getAll())) <= history.LOG_HISTORY_MAX_BYTES)
  assert.ok(h.store.count() <= history.LOG_HISTORY_MAX_COUNT)
  assert.ok(h.store.getDiagnostics().bytes <= history.LOG_HISTORY_MAX_BYTES)
  assert.equal(h.timers.size, 1)
  assert.equal(h.store.getLast(1)[0].message, 'event 1999')
})

test('bounded snapshots survive wide/deep/cyclic objects, getters and unstringifiable values', () => {
  const h = fixture()
  const data = { long: '\u0000'.repeat(100000), bigint: 1n, get forbidden() { throw new Error('must not run') }, nested: {} }
  data.self = data
  for (let i = 0; i < 1000; i++) data.nested['field' + i] = { rows: new Array(100).fill('y'.repeat(10000)) }
  assert.doesNotThrow(() => h.store.add(entry(data)))
  const actual = h.store.getAll()[0]
  assert.ok(Buffer.byteLength(JSON.stringify(actual)) <= history.LOG_ENTRY_MAX_BYTES)
  assert.equal(actual.truncated, true)
})

test('pages use epoch and sequence ids for repeated timestamps, clear and evicted cursors', () => {
  const h = fixture()
  for (let i = 0; i < 8; i++) h.store.add(entry({}, i))
  const first = h.store.getPage(undefined, 3)
  assert.equal(first.reset, true); assert.equal(first.entries.length, 3); assert.equal(first.hasMore, true)
  const next = h.store.getPage(first.nextCursor, 3)
  assert.equal(next.reset, false); assert.equal(next.entries[0].message, 'event 3')
  assert.equal(new Set([...first.entries, ...next.entries].map(log => log.id)).size, 6)
  const old = next.nextCursor
  h.store.clear()
  h.store.add(entry({}, 99))
  const reset = h.store.getPage(old, 10)
  assert.equal(reset.reset, true); assert.notEqual(reset.epoch, first.epoch); assert.equal(reset.entries[0].message, 'event 99')
  for (let i = 0; i < 2100; i++) h.store.add(entry({ body: 'x'.repeat(32768) }, i))
  assert.equal(h.store.getPage(reset.nextCursor, 10).reset, true)
})

test('pages and stored file log entries are bounded while recent and export APIs remain available', () => {
  const h = fixture(); h.logger.configure({ enabled: true, logToConsole: false, logDir: 'SYNTHETIC_LOGS' })
  for (let i = 0; i < 800; i++) h.logger.info('Synthetic', `message ${i}`, { body: 'z'.repeat(100000) })
  const page = h.store.getPage(undefined, 100000)
  assert.ok(page.entries.length <= 500)
  assert.ok(Buffer.byteLength(JSON.stringify(page)) <= history.LOG_PAGE_MAX_BYTES)
  assert.ok(h.streams.every(stream => stream.lines.every(line => Buffer.byteLength(line) <= history.LOG_ENTRY_MAX_BYTES + 1)))
  assert.equal(h.store.getLast(2).length, 2)
  assert.ok(h.store.getAll().length >= page.entries.length)
})

test('oversized legacy JSON is skipped before read and a visible truncation notice is retained', () => {
  const h = fixture({ file: 'MUST_NOT_READ', fileSize: 200 * 1024 * 1024 })
  assert.equal(h.reads, 0)
  assert.equal(h.archived.length, 1)
  assert.ok(h.store.getAll().some(log => log.truncated && /size|large|budget|过大|限制/i.test(log.message)))
})

test('when an oversized legacy history cannot be archived, recent history is loaded and saved beside it without overwriting it', async () => {
  const recent = JSON.stringify([entry({ retained: true }, 42)])
  const h = fixture({ file: 'DO_NOT_READ_OR_OVERWRITE', fileSize: 200 * 1024 * 1024, archiveFails: true, recentFile: recent })
  assert.equal(h.reads, 1, 'only the bounded recent file is read')
  assert.ok(h.store.getAll().some(log => log.message === 'event 42'))
  await h.store.flushSaveNow()
  assert.ok(h.writes.length > 0)
  assert.ok(h.writes.every(write => write.path.endsWith('proxy-logs.json.recent')))
})

test('successful oversized-history archiving preserves bounded sidecar entries without duplicate ids', async () => {
  const first = { ...entry({ retained: true }, 42), id: 'previous-epoch:1' }
  const last = { ...entry({ retained: true }, 43), id: 'previous-epoch:2' }
  const recent = JSON.stringify([first, { ...first }, last])
  const h = fixture({ file: 'DO_NOT_READ_ARCHIVED_PAYLOAD', fileSize: 200 * 1024 * 1024, recentFile: recent })
  assert.equal(h.archived.length, 1)
  assert.equal(h.reads, 1, 'only the bounded sidecar is read, never the old oversized history')
  assert.deepEqual(Array.from(h.store.getAll(), log => log.message), ['event 42', 'event 43', 'Previous log file exceeds the size budget; old history was skipped to protect memory.'])
  assert.equal(h.store.getLast(1)[0].truncated, true)
  await h.store.flushSaveNow()
  assert.ok(h.writes.every(write => write.path.endsWith('proxy-logs.json')))
  assert.equal(JSON.parse(h.writes.at(-1).data)[0].message, 'event 42')
})

test('console snapshots isolate array accessors and throwing Proxy descriptors without altering normal array order', () => {
  const h = fixture(); h.intercept()
  let invoked = 0
  const accessor = [1, 2, 3]
  Object.defineProperty(accessor, '1', { get() { invoked++; throw new Error('SYNTHETIC_GETTER_MUST_NOT_RUN') } })
  assert.doesNotThrow(() => h.console.log('[Synthetic] accessor array', accessor))
  const proxy = new Proxy([1, 2, 3], { getOwnPropertyDescriptor(_target, key) { if (key === '1') throw new Error('SYNTHETIC_DESCRIPTOR_FAILURE'); return Reflect.getOwnPropertyDescriptor(_target, key) } })
  assert.doesNotThrow(() => h.console.log('[Synthetic] descriptor array', proxy))
  assert.equal(invoked, 0)
  assert.deepEqual(Array.from(h.store.getAll()[0].data), [1, '[accessor]', 3])
  assert.deepEqual(Array.from(h.store.getAll()[1].data), [1, '[unavailable]', 3])
  assert.equal(h.store.getAll()[1].truncated, true)
  const throwingGet = new Proxy([4, 5, 6], { get() { invoked++; throw new Error('SYNTHETIC_GET_TRAP_MUST_NOT_RUN') } })
  assert.doesNotThrow(() => h.console.log('[Synthetic] descriptor-only array', throwingGet))
  assert.deepEqual(Array.from(h.store.getLast(1)[0].data), [4, 5, 6])
  assert.equal(invoked, 0, 'neither length nor element properties invoke Proxy.get')
  const throwingLengthDescriptor = new Proxy([1, 2], { getOwnPropertyDescriptor(_target, key) { if (key === 'length') throw new Error('SYNTHETIC_LENGTH_DESCRIPTOR_FAILURE'); return Reflect.getOwnPropertyDescriptor(_target, key) } })
  assert.doesNotThrow(() => h.console.log('[Synthetic] unavailable length', throwingLengthDescriptor))
  assert.deepEqual(Array.from(h.store.getLast(1)[0].data), ['[unavailable]'])
  assert.equal(h.store.getLast(1)[0].truncated, true)
  h.console.log('[Synthetic] ordinary array', Array.from({ length: 25 }, (_, index) => index))
  assert.deepEqual(Array.from(h.store.getLast(1)[0].data).slice(0, 20), Array.from({ length: 20 }, (_, index) => index))
  assert.match(h.store.getLast(1)[0].data[20], /truncated 5 items/)
})

test('a stalled file output cannot grow its write queue and reports skipped file entries after recovery', () => {
  const h = fixture()
  h.logger.configure({ enabled: true, logToConsole: false, logDir: 'SYNTHETIC_LOGS' })
  const stream = h.streams.at(-1)
  stream.writableLength = 256 * 1024
  const before = stream.lines.length
  for (let index = 0; index < 3; index++) h.logger.info('Synthetic', `while-stalled-${index}`)
  assert.equal(stream.lines.length, before)
  assert.ok(h.store.getAll().some(log => log.message === 'while-stalled-2'))
  stream.writableLength = 0
  h.logger.info('Synthetic', 'recovered')
  assert.ok(stream.lines.some(line => JSON.parse(line).data?.skippedEntries === 3))
  assert.equal(JSON.parse(stream.lines.at(-1)).message, 'recovered')
})

test('save single-flight callers and flush wait for the latest bounded snapshot including clear', async () => {
  const h = fixture({ hold: true })
  h.store.add(entry({ value: 'old' }))
  const first = h.store.save()
  h.store.add(entry({ value: 'new' }, 1))
  let finished = false
  const flush = h.store.flushSaveNow().then(() => { finished = true })
  assert.equal(h.writes.length, 1)
  await Promise.resolve(); assert.equal(finished, false)
  h.writes[0].resolve()
  await new Promise(done => setImmediate(done))
  assert.equal(h.writes.length, 2); assert.equal(finished, false)
  assert.equal(JSON.parse(h.writes[1].data).length, 2)
  h.writes[1].resolve()
  await Promise.all([first, flush]); assert.equal(finished, true)
  h.store.clear()
  const empty = h.store.flushSaveNow()
  h.writes[2].resolve()
  await new Promise(done => setImmediate(done))
  for (const write of h.writes.slice(3)) write.resolve()
  await empty
  assert.equal(JSON.parse(h.writes.at(-1).data).length, 0)
})
