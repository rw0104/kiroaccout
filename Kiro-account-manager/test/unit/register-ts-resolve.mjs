// 让 Node 原生 TypeScript 类型剥离能解析源码中的无扩展名相对导入（如 './authIdentity'）。
// 仅用于离线单元测试，不影响 electron-vite 构建。
import { registerHooks } from 'node:module'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\.[cm]?[jt]sx?$/.test(specifier) && context.parentURL) {
      const candidate = new URL(`${specifier}.ts`, context.parentURL)
      if (existsSync(fileURLToPath(candidate))) {
        return nextResolve(candidate.href, context)
      }
    }
    return nextResolve(specifier, context)
  }
})
