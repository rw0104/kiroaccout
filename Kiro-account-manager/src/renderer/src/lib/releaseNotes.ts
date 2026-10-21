const htmlTag = /<\/?(?:a|article|aside|b|blockquote|body|br|code|dd|del|details|div|dl|dt|em|embed|figcaption|figure|footer|h[1-6]|head|header|hr|html|i|iframe|img|li|link|main|mark|meta|nav|noscript|object|ol|p|pre|s|script|section|small|span|strong|style|sub|summary|sup|svg|table|tbody|td|template|th|thead|tr|u|ul)\b[^>]*>/i
const hiddenTags = new Set(['HEAD', 'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'MATH', 'IMG', 'LINK', 'META'])
const blockTags = new Set(['ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DETAILS', 'DIV', 'DL', 'DT', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'MAIN', 'NAV', 'P', 'PRE', 'SECTION', 'SUMMARY', 'TABLE', 'TR'])

function htmlToText(value: string): string {
  // DOMParser creates an inert, detached document. Only strings leave it; no release HTML is mounted.
  const document = new DOMParser().parseFromString(value, 'text/html')
  const render = (node: Node, listDepth = 0, preformatted = false): string => {
    if (node.nodeType === 3) return preformatted ? node.textContent || '' : (node.textContent || '').replace(/\s+/g, ' ')
    if (node.nodeType !== 1) return ''
    const element = node as Element
    const tag = element.tagName.toUpperCase()
    if (hiddenTags.has(tag)) return ''
    if (tag === 'BR') return '\n'
    if (tag === 'HR') return '\n\n'
    const children = () => Array.from(node.childNodes).map(child => render(child, listDepth, preformatted || tag === 'PRE')).join('')
    if (tag === 'UL' || tag === 'OL') {
      const start = Number.parseInt(element.getAttribute('start') || '1', 10)
      const items = Array.from(node.childNodes).filter(child => child.nodeType === 1 && (child as Element).tagName.toUpperCase() === 'LI')
      return `\n\n${items.map((item, index) => {
        const content = Array.from(item.childNodes).map(child => render(child, listDepth + 1, preformatted)).join('').trim()
        const marker = tag === 'OL' ? `${(Number.isFinite(start) ? start : 1) + index}.` : '•'
        return `${'  '.repeat(listDepth)}${marker} ${content}`
      }).join('\n')}\n\n`
    }
    if (tag === 'TD' || tag === 'TH') return `${children().trim()}\t`
    if (tag === 'LI') return `\n• ${children().trim()}\n`
    const text = children()
    return blockTags.has(tag) ? `\n\n${text.trim()}\n\n` : text
  }
  return render(document.body || document.documentElement)
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]*(?=\n)/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** electron-updater supplies HTML on GitHub feeds, but other feeds may provide plain text or versioned notes. */
export function formatReleaseNotes(value: unknown): string {
  if (typeof value === 'string') return htmlTag.test(value) ? htmlToText(value) : value
  if (!Array.isArray(value)) return ''
  return value.map(entry => {
    if (typeof entry === 'string') return formatReleaseNotes(entry)
    if (!entry || typeof entry !== 'object' || typeof entry.note !== 'string') return ''
    const note = formatReleaseNotes(entry.note)
    if (!note) return ''
    return typeof entry.version === 'string' && entry.version.trim() ? `${entry.version}\n${note}` : note
  }).filter(Boolean).join('\n\n')
}
