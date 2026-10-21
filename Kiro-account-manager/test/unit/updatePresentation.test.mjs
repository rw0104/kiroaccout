import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { formatReleaseNotes } from '../../src/renderer/src/lib/releaseNotes.ts'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const jsx = require('react/jsx-runtime')
const { renderToStaticMarkup } = require('react-dom/server')
const { DOMParser: XMLDOMParser } = require('@xmldom/xmldom')

// Reuse the build toolchain's offline DOM implementation; no browser or remote resources are loaded.
globalThis.DOMParser = class {
  parseFromString(source, mimeType) {
    return new XMLDOMParser().parseFromString(`<html><body>${source}</body></html>`, mimeType)
  }
}

// Exercise the real renderer components without launching Electron or accessing user data.
async function componentHarness(file, states) {
  let stateIndex = 0
  const opened = []
  const componentExports = {}
  const source = readFileSync(new URL(`../../src/renderer/src/components/${file}`, import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX
  } }).outputText
  const useStore = Object.assign(() => ({ darkMode: false }), { getState: () => ({}) })
  const button = props => jsx.jsx('button', props)
  vm.runInNewContext(compiled, {
    exports: componentExports,
    document: { body: {} },
    window: { api: { openExternal(url) { opened.push(url) } } },
    require(name) {
      if (name === 'react') return {
        useState() { return [states[stateIndex++], () => {}] }, useRef(value) { return { current: value } },
        useMemo(create) { return create() }, useEffect() {}
      }
      if (name === 'react/jsx-runtime') return jsx
      if (name === 'react-dom') return { createPortal: value => value }
      if (name === 'lucide-react') return new Proxy({}, { get: () => props => jsx.jsx('svg', props) })
      if (name === '@/store/accounts') return { useAccountsStore: useStore }
      if (name === '@/hooks/useTranslation') return { useTranslation: () => ({ t: () => '未知' }) }
      if (name === '@/lib/utils') return { cn: (...values) => values.filter(Boolean).join(' ') }
      if (name.endsWith('/releaseNotes')) return { formatReleaseNotes }
      if (name.endsWith('/updateClient')) return {}
      if (name.endsWith('.png')) return 'synthetic-logo.png'
      if (name.endsWith('/button')) return { Button: button }
      if (name.endsWith('/progress')) return { Progress: () => null }
      if (name.endsWith('/ui')) return new Proxy({}, { get: (_, key) => key === 'Button' ? button : props => jsx.jsx('div', props) })
      throw new Error(`Unexpected renderer dependency: ${name}`)
    }
  })
  const Component = Object.values(componentExports)[0]
  const tree = Component()
  return { tree, opened, html: renderToStaticMarkup(tree) }
}

function buttonsIn(tree) {
  const buttons = []
  function visit(node) {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach(visit); return }
    if (node.props?.onClick) buttons.push(node)
    visit(node.props?.children)
  }
  visit(tree)
  return buttons
}

function hasLabel(button, label) {
  const children = button.props.children
  return children === label || Array.isArray(children) && children.includes(label)
}

test('update dialog shows release prose instead of literal HTML tags', async () => {
  const update = await componentHarness('UpdateDialog.tsx', [true, {
    status: 'downloaded', currentVersion: '1.8.1', version: '1.8.2',
    releaseNotes: '<h1>Windows 更新</h1><p>恢复账户 &amp; 安装修复</p><ul><li>保护原账户</li></ul>'
  }, null])
  assert.ok(update.html.includes('Windows 更新'))
  assert.ok(update.html.includes('恢复账户 &amp; 安装修复'))
  assert.ok(!update.html.includes('&lt;h1&gt;'), 'HTML must be formatted before being rendered as React text')
  assert.ok(!update.html.includes('&lt;li&gt;'))
})

test('About inventory monitor button uses the exact requested URL through openExternal', async () => {
  const about = await componentHarness('pages/AboutPage.tsx', ['1.8.2'])
  const monitor = buttonsIn(about.tree).find(button => hasLabel(button, '库存监控'))
  assert.ok(monitor, 'About should offer the inventory monitor link')
  monitor.props.onClick()
  assert.deepEqual(about.opened, ['https://12312356.xyz/'])
})

test('installation failure offers manual downloads alongside controlled retry', async () => {
  const update = await componentHarness('UpdateDialog.tsx', [true, {
    status: 'error', errorStage: 'install', currentVersion: '1.8.1', version: '1.8.2', error: '保存失败'
  }, null])
  const buttons = buttonsIn(update.tree)
  const manual = buttons.find(button => hasLabel(button, '手动下载安装包'))
  assert.ok(manual)
  assert.ok(buttons.find(button => hasLabel(button, '确认重启并安装')), 'The save/install retry remains available')
  manual.props.onClick()
  assert.deepEqual(update.opened, ['https://github.com/rw0104/kiroaccout/releases/latest'])
})

test('HTML notes decode entities and preserve headings, paragraphs, line breaks and lists', () => {
  assert.equal(formatReleaseNotes('<h1>1.8.2 &amp; 修复 &#x1F680;</h1><p>第一行&nbsp;内容<br/>第二行</p><h2>修复</h2><ul><li>账户 <strong>保存</strong></li><li>更新</li></ul>'),
    '1.8.2 & 修复 🚀\n\n第一行 内容\n第二行\n\n修复\n\n• 账户 保存\n• 更新')
  assert.equal(formatReleaseNotes('<ol start="3"><li>下载</li><li>安装</li></ol>'), '3. 下载\n4. 安装')
  assert.equal(formatReleaseNotes('<ul><li>父项<ul><li>子项</li></ul></li></ul>'), '• 父项\n\n  • 子项')
})

test('HTML notes exclude scripts, CSS and embedded active content without executing them', () => {
  globalThis.__releaseNotesExecuted = false
  const html = '<p onclick="globalThis.__releaseNotesExecuted=true">正常文本</p><script>globalThis.__releaseNotesExecuted=true</script><style>body {display:none}</style><iframe src="https://example.invalid">隐藏</iframe><img src="https://example.invalid/image" onerror="globalThis.__releaseNotesExecuted=true"/><a href="javascript:globalThis.__releaseNotesExecuted=true">链接文本</a>'
  assert.equal(formatReleaseNotes(html), '正常文本\n\n链接文本')
  assert.equal(globalThis.__releaseNotesExecuted, false)
  delete globalThis.__releaseNotesExecuted
})

test('plain text and Markdown remain unchanged, including comparisons, blank lines and literal entities', () => {
  for (const note of ['修复更新\n\n账户保存成功', '# 修复\n\n- 第一项\n- [下载](https://example.invalid)', 'x < y && y > z\n<https://example.invalid>\n&amp; <accountId>']) {
    assert.equal(formatReleaseNotes(note), note)
  }
  for (const value of [null, undefined, 42, {}, [{ version: '1.0' }]]) assert.equal(formatReleaseNotes(value), '')
})

test('versioned release note arrays retain each version and independently format HTML or Markdown', () => {
  assert.equal(formatReleaseNotes([
    { version: '1.8.3', note: '<h2>更新</h2><p>修复保存</p>' },
    { version: '1.8.2', note: '## 维护\n- 修复账户' },
    { note: '<p>更多 &lt;文本&gt;</p>' },
    { version: 'ignored', note: null }
  ]), '1.8.3\n更新\n\n修复保存\n\n1.8.2\n## 维护\n- 修复账户\n\n更多 <文本>')
})
