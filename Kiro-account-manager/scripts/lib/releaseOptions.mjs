import assert from 'node:assert/strict'
import { parseArgs } from 'node:util'
import { resolve } from 'node:path'
import { releaseTarget } from './releaseArtifacts.mjs'

export function releaseOptions(argv, appRoot, { aggregate = false } = {}) {
  const { values } = parseArgs({ args: argv, options: {
    platform: { type: 'string', default: process.platform },
    arch: { type: 'string', default: process.arch },
    dist: { type: 'string', default: resolve(appRoot, 'dist') },
    verify: { type: 'boolean', default: false },
    all: { type: 'boolean', default: false }
  } })
  assert.ok(aggregate || !values.all, '--all is only supported by release:checksums')
  releaseTarget(values.platform, values.arch)
  return { ...values, dist: resolve(values.dist) }
}
