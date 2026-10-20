interface Version {
  core: string[]
  prerelease: string[]
}

// Strict SemVer with an optional Git tag prefix. Compare numeric identifiers as
// strings so even large version numbers never lose integer precision.
function parseVersion(value: unknown): Version | null {
  if (typeof value !== 'string') return null
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value)
  if (!match || match[0] !== value) return null
  const prerelease = match[4]?.split('.') ?? []
  if (prerelease.some((part) => /^\d+$/.test(part) && part.length > 1 && part[0] === '0')) {
    return null
  }
  return { core: [match[1], match[2], match[3]], prerelease }
}

function compareNumber(left: string, right: string): number {
  if (left.length !== right.length) return left.length > right.length ? 1 : -1
  return left === right ? 0 : left > right ? 1 : -1
}

/** Malformed versions never offer an update. Build metadata does not affect precedence. */
export function isNewerVersion(latest: unknown, current: unknown): boolean {
  const candidate = parseVersion(latest)
  const installed = parseVersion(current)
  if (!candidate || !installed) return false

  for (let index = 0; index < candidate.core.length; index++) {
    const comparison = compareNumber(candidate.core[index], installed.core[index])
    if (comparison !== 0) return comparison > 0
  }

  if (!candidate.prerelease.length) return installed.prerelease.length > 0
  if (!installed.prerelease.length) return false

  const sharedLength = Math.min(candidate.prerelease.length, installed.prerelease.length)
  for (let index = 0; index < sharedLength; index++) {
    const left = candidate.prerelease[index]
    const right = installed.prerelease[index]
    if (left === right) continue
    const leftNumeric = /^\d+$/.test(left)
    const rightNumeric = /^\d+$/.test(right)
    if (leftNumeric && rightNumeric) return compareNumber(left, right) > 0
    if (leftNumeric !== rightNumeric) return !leftNumeric
    return left > right
  }
  return candidate.prerelease.length > installed.prerelease.length
}
