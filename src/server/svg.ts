/**
 * A strict allow-list sanitiser for SVG images, with no DOM and no dependency.
 *
 * An SVG is XML that a browser may run, so every SVG that enters the workspace (a paste, a drop,
 * an accepted agent asset) and every SVG the server answers with is passed through here. The
 * image is parsed as well-formed XML and written back out keeping only elements and attributes
 * on the lists below; everything else is removed. What cannot be read safely — not UTF-8, not
 * well-formed, not rooted in `<svg>`, a DOCTYPE with an internal subset, an unknown entity, or
 * absurd nesting — is refused instead, with a reason the writer can read.
 *
 * Removed: `<script>`, `<foreignObject>`, `<iframe>`/`<embed>`/`<object>` and any other element
 * not on the list (with everything inside it), animation elements (they can rewrite `href`),
 * every attribute not on the list (so every `on*` handler), prefixed elements and attributes
 * other than `xlink:href` and `xml:space`/`xml:lang`, comments, processing instructions
 * (`<?xml-stylesheet?>`), the DOCTYPE, `href`s other than `#fragment` (and, on `<image>`, a
 * base64 raster `data:` URL), CSS `url()`s other than `url(#fragment)`, and `@import`.
 * `<a>` is unwrapped: its content stays, the link goes.
 */

const SVG_NS = 'http://www.w3.org/2000/svg'
const XLINK_NS = 'http://www.w3.org/1999/xlink'
const MAX_DEPTH = 256

export type SvgVerdict =
  | { ok: true; svg: string; removed: string[] }
  | { ok: false; reason: string }

const ELEMENTS = new Set([
  'svg',
  'g',
  'defs',
  'symbol',
  'use',
  'switch',
  'title',
  'desc',
  'style',
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'text',
  'tspan',
  'textPath',
  'image',
  'linearGradient',
  'radialGradient',
  'stop',
  'pattern',
  'clipPath',
  'mask',
  'marker',
  'filter',
  'feBlend',
  'feColorMatrix',
  'feComponentTransfer',
  'feComposite',
  'feConvolveMatrix',
  'feDiffuseLighting',
  'feDisplacementMap',
  'feDistantLight',
  'feDropShadow',
  'feFlood',
  'feFuncA',
  'feFuncB',
  'feFuncG',
  'feFuncR',
  'feGaussianBlur',
  'feMerge',
  'feMergeNode',
  'feMorphology',
  'feOffset',
  'fePointLight',
  'feSpecularLighting',
  'feSpotLight',
  'feTile',
  'feTurbulence',
])

/** Dropped as a tag only: the content is kept. */
const UNWRAPPED = new Set(['a'])

const ATTRIBUTES = new Set([
  // core
  'id',
  'class',
  'style',
  'lang',
  'xml:space',
  'xml:lang',
  'role',
  'aria-label',
  'aria-labelledby',
  'aria-describedby',
  'aria-hidden',
  // svg, use, image, pattern, filter boxes
  'width',
  'height',
  'x',
  'y',
  'viewBox',
  'preserveAspectRatio',
  'version',
  'baseProfile',
  'href',
  'xlink:href',
  // shapes
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'x1',
  'y1',
  'x2',
  'y2',
  'points',
  'd',
  'pathLength',
  'transform',
  // text
  'dx',
  'dy',
  'rotate',
  'textLength',
  'lengthAdjust',
  'startOffset',
  'method',
  'spacing',
  'side',
  // paint servers, clipping, masking, markers
  'gradientUnits',
  'gradientTransform',
  'spreadMethod',
  'fx',
  'fy',
  'fr',
  'offset',
  'patternUnits',
  'patternContentUnits',
  'patternTransform',
  'clipPathUnits',
  'maskUnits',
  'maskContentUnits',
  'markerWidth',
  'markerHeight',
  'markerUnits',
  'refX',
  'refY',
  'orient',
  // filters
  'filterUnits',
  'primitiveUnits',
  'in',
  'in2',
  'result',
  'stdDeviation',
  'mode',
  'operator',
  'k1',
  'k2',
  'k3',
  'k4',
  'values',
  'type',
  'tableValues',
  'slope',
  'intercept',
  'amplitude',
  'exponent',
  'kernelMatrix',
  'order',
  'divisor',
  'bias',
  'targetX',
  'targetY',
  'edgeMode',
  'preserveAlpha',
  'kernelUnitLength',
  'surfaceScale',
  'diffuseConstant',
  'specularConstant',
  'specularExponent',
  'scale',
  'xChannelSelector',
  'yChannelSelector',
  'radius',
  'baseFrequency',
  'numOctaves',
  'seed',
  'stitchTiles',
  'azimuth',
  'elevation',
  'z',
  'pointsAtX',
  'pointsAtY',
  'pointsAtZ',
  'limitingConeAngle',
  // presentation attributes
  'alignment-baseline',
  'baseline-shift',
  'clip',
  'clip-path',
  'clip-rule',
  'color',
  'color-interpolation',
  'color-interpolation-filters',
  'color-rendering',
  'direction',
  'display',
  'dominant-baseline',
  'enable-background',
  'fill',
  'fill-opacity',
  'fill-rule',
  'filter',
  'flood-color',
  'flood-opacity',
  'font',
  'font-family',
  'font-kerning',
  'font-size',
  'font-size-adjust',
  'font-stretch',
  'font-style',
  'font-variant',
  'font-weight',
  'image-rendering',
  'isolation',
  'kerning',
  'letter-spacing',
  'lighting-color',
  'marker',
  'marker-start',
  'marker-mid',
  'marker-end',
  'mask',
  'mix-blend-mode',
  'opacity',
  'overflow',
  'paint-order',
  'shape-rendering',
  'stop-color',
  'stop-opacity',
  'stroke',
  'stroke-dasharray',
  'stroke-dashoffset',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-miterlimit',
  'stroke-opacity',
  'stroke-width',
  'text-anchor',
  'text-decoration',
  'text-rendering',
  'transform-origin',
  'unicode-bidi',
  'vector-effect',
  'visibility',
  'white-space',
  'word-spacing',
  'writing-mode',
])

/** A raster picture embedded in the file itself: the only non-fragment reference kept. */
const RASTER_DATA_URL = /^data:image\/(?:png|jpeg|gif|webp|avif);base64,[A-Za-z0-9+/=\s]*$/
const FRAGMENT = /^#[^\s]*$/

class Refused extends Error {}

const refuse = (reason: string): never => {
  throw new Refused(reason)
}

const PREDEFINED: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }

/** Resolve character and predefined entity references; any other `&` refuses the file. */
function decodeEntities(raw: string): string {
  if (!raw.includes('&')) return raw
  return raw.replace(/&([^;&\s<]*);?/g, (match, body: string) => {
    if (!match.endsWith(';')) refuse('it has a bare "&" that is not an entity reference')
    const named = PREDEFINED[body]
    if (named !== undefined) return named
    const numeric = /^#(?:x([0-9a-fA-F]{1,6})|([0-9]{1,7}))$/.exec(body)
    if (numeric === null) refuse(`it uses an unknown entity (&${body.slice(0, 40)};)`)
    const code = Number.parseInt(numeric?.[1] ?? numeric?.[2] ?? '', numeric?.[1] ? 16 : 10)
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff))
      refuse(`it has an invalid character reference (&${body};)`)
    return String.fromCodePoint(code)
  })
}

const escapeText = (text: string) =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

const escapeAttribute = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('"', '&quot;')
    .replaceAll('\t', '&#9;')
    .replaceAll('\n', '&#10;')
    .replaceAll('\r', '&#13;')

/** Anything in CSS that can run code, load something, or hide a name behind an escape. */
const CSS_FORBIDDEN =
  /\\|<|expression\s*\(|javascript:|vbscript:|-moz-binding|behavior\s*:|image-set\s*\(|cross-fade\s*\(|element\s*\(|(?:^|[^-\w])(?:image|src)\s*\(|@import/i

/** Safe CSS: nothing forbidden, and every `url(` points at a fragment of this image. */
function cssIsSafe(css: string): boolean {
  if (CSS_FORBIDDEN.test(css)) return false
  for (const match of css.matchAll(/url\s*\(/gi)) {
    const rest = css.slice((match.index ?? 0) + match[0].length)
    if (!/^\s*['"]?\s*#/.test(rest)) return false
  }
  return true
}

/** A `<style>` sheet with `@import` rules and non-fragment `url()`s taken out, or null if still unsafe. */
function cleanStyleSheet(css: string, removed: Set<string>): string | null {
  let cleaned = css.replace(/@import[^;]*;?/gi, () => {
    removed.add('@import')
    return ''
  })
  cleaned = cleaned.replace(/url\s*\(([^)]*)\)/gi, (match, target: string) => {
    if (/^\s*['"]?\s*#/.test(target)) return match
    removed.add('external url()')
    return 'none'
  })
  return cssIsSafe(cleaned) ? cleaned : null
}

/** A `style` attribute with its unsafe declarations dropped. */
function cleanStyleAttribute(style: string, removed: Set<string>): string {
  return style
    .split(';')
    .filter((declaration) => {
      if (cssIsSafe(declaration)) return true
      removed.add('style declaration')
      return false
    })
    .join(';')
}

type Mode = 'keep' | 'unwrap' | 'drop'
interface Frame {
  name: string
  mode: Mode
  /** For a kept `<style>`: where its start tag begins in the output, and its collected text. */
  style?: { at: number; css: string }
}

const NAME = /^[A-Za-z_:À-￿][-A-Za-z0-9_:.·-￿]*/

/** Parse `data` as SVG and write back only what the allow-list keeps. Never throws. */
export function sanitiseSvg(data: Uint8Array): SvgVerdict {
  let source: string
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(data)
  } catch {
    return { ok: false, reason: 'it is not UTF-8 text' }
  }
  try {
    return sanitise(source)
  } catch (error) {
    if (error instanceof Refused) return { ok: false, reason: error.message }
    throw error
  }
}

function sanitise(source: string): SvgVerdict {
  const out: string[] = []
  const removed = new Set<string>()
  const stack: Frame[] = []
  let rootSeen = false
  let rootClosed = false
  let i = 0

  const top = () => stack[stack.length - 1]
  const dropping = () => stack.some((frame) => frame.mode === 'drop')
  const outsideRoot = () => stack.length === 0

  const text = (decoded: string) => {
    if (outsideRoot()) {
      if (decoded.trim() !== '') refuse('it has text outside the <svg> element')
      return
    }
    if (dropping()) return
    const frame = top()
    if (frame?.style !== undefined) frame.style.css += decoded
    else out.push(escapeText(decoded))
  }

  while (i < source.length) {
    if (source[i] !== '<') {
      const end = source.indexOf('<', i)
      const stop = end === -1 ? source.length : end
      text(decodeEntities(source.slice(i, stop)))
      i = stop
      continue
    }
    if (source.startsWith('<!--', i)) {
      const end = source.indexOf('-->', i + 4)
      if (end === -1) refuse('it has an unclosed comment')
      i = end + 3
      continue
    }
    if (source.startsWith('<![CDATA[', i)) {
      const end = source.indexOf(']]>', i + 9)
      if (end === -1) refuse('it has an unclosed CDATA section')
      text(source.slice(i + 9, end))
      i = end + 3
      continue
    }
    if (source.startsWith('<!', i)) {
      if (!/^<!DOCTYPE\s/i.test(source.slice(i, i + 10)) || rootSeen)
        refuse('it has a markup declaration outside a DOCTYPE')
      i = skipDoctype(source, i + 9)
      continue
    }
    if (source.startsWith('<?', i)) {
      const end = source.indexOf('?>', i + 2)
      if (end === -1) refuse('it has an unclosed processing instruction')
      const target = /^[^\s?]*/.exec(source.slice(i + 2, end))?.[0] ?? ''
      if (target !== 'xml') removed.add('processing instruction')
      i = end + 2
      continue
    }
    if (source.startsWith('</', i)) {
      const end = source.indexOf('>', i)
      if (end === -1) refuse('it has an unclosed end tag')
      const name = source.slice(i + 2, end).trim()
      const frame = stack.pop()
      if (frame === undefined || frame.name !== name)
        refuse(`its tags do not match (</${name.slice(0, 40)}>)`)
      closeElement(frame as Frame, out, removed)
      if (stack.length === 0) rootClosed = true
      i = end + 1
      continue
    }
    i = startTag(source, i)
  }
  if (stack.length > 0) refuse(`the <${top()?.name}> element is never closed`)
  if (!rootSeen) refuse('it has no <svg> element')
  return { ok: true, svg: `${out.join('')}\n`, removed: [...removed] }

  function startTag(src: string, at: number): number {
    const name = NAME.exec(src.slice(at + 1, at + 256))?.[0]
    if (name === undefined) return refuse('it has a "<" that does not start a tag')
    let pos = at + 1 + name.length
    const attributes: [string, string][] = []
    let selfClosing = false
    for (;;) {
      const space = /^\s*/.exec(src.slice(pos, pos + 4096))?.[0].length ?? 0
      pos += space
      if (src.startsWith('/>', pos)) {
        selfClosing = true
        pos += 2
        break
      }
      if (src[pos] === '>') {
        pos += 1
        break
      }
      if (pos >= src.length) refuse(`the <${name}> tag is never closed`)
      if (space === 0 && attributes.length > 0) refuse(`the <${name}> tag is malformed`)
      const attribute = NAME.exec(src.slice(pos, pos + 256))?.[0]
      if (attribute === undefined) return refuse(`the <${name}> tag is malformed`)
      pos += attribute.length
      pos += /^\s*/.exec(src.slice(pos, pos + 4096))?.[0].length ?? 0
      if (src[pos] !== '=') refuse(`the ${attribute} attribute of <${name}> has no value`)
      pos += 1
      pos += /^\s*/.exec(src.slice(pos, pos + 4096))?.[0].length ?? 0
      const quote = src[pos]
      if (quote !== '"' && quote !== "'")
        refuse(`the ${attribute} attribute of <${name}> is not quoted`)
      const close = src.indexOf(quote as string, pos + 1)
      if (close === -1) refuse(`the ${attribute} attribute of <${name}> is never closed`)
      const raw = src.slice(pos + 1, close)
      if (raw.includes('<')) refuse(`the ${attribute} attribute of <${name}> contains "<"`)
      if (attributes.some(([seen]) => seen === attribute))
        refuse(`<${name}> has the ${attribute} attribute twice`)
      // XML attribute-value normalisation: literal whitespace becomes a space, then references.
      attributes.push([attribute, decodeEntities(raw.replace(/[\t\n\r]/g, ' '))])
      pos = close + 1
    }

    if (outsideRoot()) {
      if (rootClosed) refuse('it has more than one root element')
      if (name !== 'svg') refuse(`it is not an SVG image (its root is <${name.slice(0, 40)}>)`)
      const xmlns = attributes.find(([key]) => key === 'xmlns')?.[1]
      if (xmlns !== undefined && xmlns !== SVG_NS) refuse('its root is not in the SVG namespace')
      rootSeen = true
    }
    if (stack.length >= MAX_DEPTH) refuse(`it nests elements more than ${MAX_DEPTH} deep`)

    const parent = top()
    let mode: Mode
    if (dropping()) mode = 'drop'
    else if (parent?.style !== undefined) {
      removed.add(`<${name}>`)
      mode = 'drop'
    } else if (UNWRAPPED.has(name)) {
      removed.add(`<${name}> link`)
      mode = 'unwrap'
    } else if (ELEMENTS.has(name)) mode = 'keep'
    else {
      removed.add(`<${name}>`)
      mode = 'drop'
    }
    const frame: Frame = { name, mode }
    if (mode === 'keep') {
      const at = out.length
      out.push(`<${name}${keptAttributes(name, attributes, stack.length === 0)}`)
      if (selfClosing) out.push('/>')
      else {
        out.push('>')
        if (name === 'style') frame.style = { at, css: '' }
      }
    }
    if (!selfClosing) stack.push(frame)
    else if (stack.length === 0) rootClosed = true
    return pos
  }

  function keptAttributes(element: string, attributes: [string, string][], root: boolean) {
    let kept = ''
    let hasXmlns = false
    for (const [key, value] of attributes) {
      if (key === 'xmlns') {
        if (value === SVG_NS) {
          kept += ` xmlns="${SVG_NS}"`
          hasXmlns = true
        }
        continue
      }
      if (key === 'xmlns:xlink') {
        if (value === XLINK_NS) kept += ` xmlns:xlink="${XLINK_NS}"`
        continue
      }
      // Other namespace declarations only serve prefixed names, which are all removed.
      if (key.startsWith('xmlns:')) continue
      if (!ATTRIBUTES.has(key)) {
        removed.add(`${key} attribute`)
        continue
      }
      let safe: string | null = value
      if (key === 'href' || key === 'xlink:href') {
        const allowed = element === 'image' ? RASTER_DATA_URL : FRAGMENT
        if (!allowed.test(value.trim())) safe = null
      } else if (key === 'style') {
        safe = cleanStyleAttribute(value, removed)
      } else if (!cssIsSafe(value)) {
        safe = null
      }
      if (safe === null) {
        removed.add(key === 'href' || key === 'xlink:href' ? 'external reference' : `${key} value`)
        continue
      }
      kept += ` ${key}="${escapeAttribute(safe)}"`
    }
    // An image is only drawn as SVG in its namespace; a hand-written file may leave it out.
    if (root && !hasXmlns) kept = ` xmlns="${SVG_NS}"${kept}`
    return kept
  }
}

function closeElement(frame: Frame, out: string[], removed: Set<string>) {
  if (frame.mode !== 'keep') return
  if (frame.style !== undefined) {
    const css = cleanStyleSheet(frame.style.css, removed)
    if (css === null) {
      removed.add('<style>')
      out.length = frame.style.at
      return
    }
    out.push(escapeText(css))
  }
  out.push(`</${frame.name}>`)
}

/** Skip a DOCTYPE without an internal subset; one with a subset (entities) refuses the file. */
function skipDoctype(source: string, from: number): number {
  let quote: string | null = null
  for (let i = from; i < source.length; i++) {
    const char = source[i]
    if (quote !== null) {
      if (char === quote) quote = null
    } else if (char === '"' || char === "'") quote = char
    else if (char === '[') refuse('it declares entities in a DOCTYPE')
    else if (char === '>') return i + 1
  }
  return refuse('it has an unclosed DOCTYPE')
}

/** An SVG by its name, as the server serves it (`http.ts` maps `.svg` to `image/svg+xml`). */
export const isSvgName = (name: string): boolean => name.toLowerCase().endsWith('.svg')
