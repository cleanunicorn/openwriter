import { describe, expect, it } from 'vitest'
import { isSvgName, type SvgVerdict, sanitiseSvg } from './svg.ts'

const NS = 'xmlns="http://www.w3.org/2000/svg"'
const XLINK = 'xmlns:xlink="http://www.w3.org/1999/xlink"'
const bytes = (text: string) => new TextEncoder().encode(text)

function clean(text: string): { svg: string; removed: string[] } {
  const verdict = sanitiseSvg(bytes(text))
  if (!verdict.ok) throw new Error(`refused: ${verdict.reason}`)
  return verdict
}

function refused(text: string | Uint8Array): string {
  const verdict: SvgVerdict = sanitiseSvg(typeof text === 'string' ? bytes(text) : text)
  if (verdict.ok) throw new Error(`accepted: ${verdict.svg}`)
  return verdict.reason
}

/** Nothing that can run, load or link survives, however it was spelled. */
function expectInert(output: string) {
  // The namespace URIs are the one place a URL may appear.
  const svg = output.replaceAll(NS, '').replaceAll(XLINK, '')
  expect(svg).not.toMatch(/<script|<foreignObject|<iframe|<embed|<object|<animate|<set\b|<a\b/i)
  expect(svg).not.toMatch(/\son[a-z]+=/i)
  expect(svg).not.toMatch(/javascript:|https?:|@import|<!|<\?/i)
  expect(svg).not.toMatch(/href="(?!#|data:image\/(png|jpeg|gif|webp|avif);base64,)/)
}

describe('sanitiseSvg keeps legitimate images', () => {
  it('writes a plain drawing back unchanged apart from the prolog', () => {
    const body = `<svg ${NS} viewBox="0 0 10 10" width="10" height="10">
  <title>A &amp; B</title>
  <rect x="1" y="1" width="8" height="8" fill="#3b6ea5" stroke="black" stroke-width="0.5"/>
  <path d="M0 0 L10 10" style="stroke:red;stroke-width:2"/>
</svg>`
    const { svg, removed } = clean(`<?xml version="1.0" encoding="UTF-8"?>\n${body}\n`)
    expect(svg).toBe(`${body}\n`)
    expect(removed).toEqual([])
  })

  it('keeps gradients, fragment references, filters, text and embedded raster images', () => {
    const input = `<svg ${NS} ${XLINK}>
<defs>
<linearGradient id="g" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fff"/></linearGradient>
<filter id="f"><feGaussianBlur in="SourceGraphic" stdDeviation="2"/></filter>
<symbol id="s"><circle r="3"/></symbol>
</defs>
<use xlink:href="#s" x="2"/><use href="#s"/>
<rect fill="url(#g)" filter="url('#f')" width="5" height="5"/>
<text x="0" y="9" font-family="'Segoe UI', sans-serif"><tspan dy="1">Hi</tspan></text>
<image width="1" height="1" href="data:image/png;base64,iVBORw0KGgo="/>
</svg>`
    const { svg, removed } = clean(input)
    expect(svg).toBe(`${input}\n`)
    expect(removed).toEqual([])
  })

  it('keeps a style sheet, in CDATA or as text, and escapes it for XML', () => {
    const { svg } = clean(
      `<svg ${NS}><style type="text/css"><![CDATA[.a > .b { fill: #000; } .c{clip-path:url(#c)}]]></style></svg>`,
    )
    expect(svg).toContain(
      '<style type="text/css">.a &gt; .b { fill: #000; } .c{clip-path:url(#c)}</style>',
    )
  })

  it('removes editor metadata from an Inkscape file but keeps the drawing', () => {
    const { svg, removed } = clean(`<?xml version="1.0"?>
<!-- Created with Inkscape -->
<svg ${NS} xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"
  xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd" inkscape:version="1.3" width="4">
<sodipodi:namedview id="n" pagecolor="#fff"/>
<metadata><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"/></metadata>
<g inkscape:label="Layer 1" inkscape:groupmode="layer"><rect width="4" height="4"/></g>
</svg>`)
    expect(svg).toBe(`<svg ${NS} width="4">\n\n\n<g><rect width="4" height="4"/></g>\n</svg>\n`)
    expect(removed).toEqual(
      expect.arrayContaining(['<sodipodi:namedview>', '<metadata>', 'inkscape:label attribute']),
    )
  })

  it('drops a DOCTYPE without an internal subset (Illustrator, SVG 1.1)', () => {
    const { svg } = clean(`<?xml version="1.0"?>
<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">
<svg version="1.1" ${NS} xml:space="preserve"><circle r="1"/></svg>`)
    expect(svg).toBe(`<svg version="1.1" ${NS} xml:space="preserve"><circle r="1"/></svg>\n`)
  })

  it('adds the SVG namespace a hand-written file left out', () => {
    expect(clean('<svg width="1"><rect/></svg>').svg).toBe(`<svg ${NS} width="1"><rect/></svg>\n`)
  })

  it('keeps the text of a mermaid-style diagram when its foreignObject labels go', () => {
    const { svg } = clean(`<svg ${NS} id="m" viewBox="0 0 100 50" style="max-width: 100px;">
<style>#m{font-family:"trebuchet ms",verdana,arial,sans-serif;font-size:16px;fill:#333;}#m .node rect{fill:#ECECFF;stroke:#9370DB;}</style>
<g class="node"><rect width="50" height="20"/>
<switch><foreignObject width="50" height="20"><div xmlns="http://www.w3.org/1999/xhtml">A</div></foreignObject><text>A</text></switch></g>
</svg>`)
    expect(svg).toContain('#m .node rect{fill:#ECECFF;stroke:#9370DB;}')
    expect(svg).toContain('<switch><text>A</text></switch>')
    expectInert(svg)
  })

  it('is idempotent: a sanitised image sanitises to itself', () => {
    const once = clean(
      `<svg ${NS} onload="x()"><a href="https://e.test"><text>&lt;hi&gt; "q"</text></a><rect style="fill:url(http://e.test/x);stroke:red" x="1&#10;"/></svg>`,
    ).svg
    const twice = clean(once)
    expect(twice.svg).toBe(once)
    expect(twice.removed).toEqual([])
  })
})

describe('sanitiseSvg removes active content', () => {
  it('removes script elements with everything inside them, however they are written', () => {
    const { svg, removed } = clean(
      `<svg ${NS}><script>alert(1)</script><script type="text/ecmascript"><![CDATA[alert(2)]]></script><g><script href="data:,alert(3)"/></g><rect/></svg>`,
    )
    expect(svg).toBe(`<svg ${NS}><g></g><rect/></svg>\n`)
    expect(removed).toContain('<script>')
  })

  it('removes a script disguised by a namespace prefix bound to SVG', () => {
    const { svg } = clean(
      `<svg ${NS} xmlns:s="http://www.w3.org/2000/svg"><s:script>alert(1)</s:script><rect/></svg>`,
    )
    expect(svg).toBe(`<svg ${NS}><rect/></svg>\n`)
  })

  it('removes a script inside an element that rebinds the default namespace to XHTML', () => {
    const { svg } = clean(
      `<svg ${NS}><g xmlns="http://www.w3.org/1999/xhtml"><script>alert(1)</script><rect/></g></svg>`,
    )
    expect(svg).toBe(`<svg ${NS}><g><rect/></g></svg>\n`)
  })

  it('removes every event handler attribute', () => {
    const { svg, removed } = clean(
      `<svg ${NS} onload="alert(1)"><rect onclick="alert(2)" ONMOUSEOVER='x' onfocusin="y" width="1"/><image onerror="z"/></svg>`,
    )
    expect(svg).toBe(`<svg ${NS}><rect width="1"/><image/></svg>\n`)
    expect(removed).toEqual(
      expect.arrayContaining(['onload attribute', 'onclick attribute', 'onerror attribute']),
    )
    expectInert(svg)
  })

  it('removes foreignObject with the HTML inside it', () => {
    const { svg, removed } = clean(
      `<svg ${NS}><foreignObject width="10" height="10"><body xmlns="http://www.w3.org/1999/xhtml"><img src="x" onerror="alert(1)"/><iframe src="javascript:alert(2)"></iframe></body></foreignObject></svg>`,
    )
    expect(svg).toBe(`<svg ${NS}></svg>\n`)
    expect(removed).toEqual(['<foreignObject>'])
  })

  it('removes embedding elements and animations', () => {
    const { svg } = clean(
      `<svg ${NS}><iframe src="https://e.test"/><embed src="x.swf"/><object data="x.html"/><a href="#x"><animate attributeName="href" to="javascript:alert(1)"/><set attributeName="href" to="javascript:alert(1)"/><text>kept</text></a><animateTransform/><animateMotion/></svg>`,
    )
    expect(svg).toBe(`<svg ${NS}><text>kept</text></svg>\n`)
    expectInert(svg)
  })

  it('removes processing instructions such as an external style sheet', () => {
    const { svg, removed } = clean(
      `<?xml version="1.0"?><?xml-stylesheet href="https://e.test/x.css"?><svg ${NS}/>`,
    )
    expect(svg).toBe(`<svg ${NS}/>\n`)
    expect(removed).toEqual(['processing instruction'])
  })
})

describe('sanitiseSvg removes external references', () => {
  it('keeps only fragment hrefs, and on <image> only base64 raster data', () => {
    const { svg, removed } = clean(`<svg ${NS} ${XLINK}>
<use href="https://e.test/sprite.svg#icon"/><use xlink:href="other.svg#a"/><use href="data:image/svg+xml,&lt;svg/&gt;"/>
<image href="https://e.test/tracker.png"/><image xlink:href="file:///etc/passwd"/>
<image href="data:image/svg+xml;base64,PHN2Zy8+"/><image href="data:text/html;base64,PHNjcmlwdD4="/>
<linearGradient id="a" href="javascript:alert(1)"/><use href=" #ok"/>
</svg>`)
    expect(svg).toBe(`<svg ${NS} ${XLINK}>
<use/><use/><use/>
<image/><image/>
<image/><image/>
<linearGradient id="a"/><use href=" #ok"/>
</svg>\n`)
    expect(removed).toEqual(['external reference'])
  })

  it('finds a javascript: URL hidden behind character references', () => {
    const { svg } = clean(
      `<svg ${NS}><use href="&#106;avascript&#x3a;alert(1)"/><rect fill="u&#114;l(https://e.test)"/></svg>`,
    )
    expect(svg).toBe(`<svg ${NS}><use/><rect/></svg>\n`)
  })

  it('removes non-fragment url() from presentation attributes', () => {
    const { svg, removed } = clean(
      `<svg ${NS}><rect fill="url(https://e.test/p.svg#g)" filter="URL( 'x.svg#f' )" mask="url(#ok)" clip-path="url(&quot;#c&quot;)"/></svg>`,
    )
    expect(svg).toBe(`<svg ${NS}><rect mask="url(#ok)" clip-path="url(&quot;#c&quot;)"/></svg>\n`)
    expect(removed).toEqual(['fill value', 'filter value'])
  })

  it('drops unsafe declarations from a style attribute and keeps the rest', () => {
    const { svg } = clean(
      `<svg ${NS}><rect style="fill:red; background:url(https://e.test/x.png); stroke:blue; behavior: url(x.htc); width:expression(alert(1)); fill:\\75rl(x)"/></svg>`,
    )
    expect(svg).toBe(`<svg ${NS}><rect style="fill:red; stroke:blue"/></svg>\n`)
  })

  it('takes @import and external url() out of a style sheet and keeps the rest', () => {
    const { svg, removed } = clean(
      `<svg ${NS}><style>@import url(https://e.test/a.css);@IMPORT "b.css"; @font-face{font-family:x;src:url(https://e.test/f.woff)} .a{fill:url(#g);background:url( "http://e.test/t.png" )}</style></svg>`,
    )
    expect(svg).toBe(
      `<svg ${NS}><style> @font-face{font-family:x;src:none} .a{fill:url(#g);background:none}</style></svg>\n`,
    )
    expect(removed).toEqual(expect.arrayContaining(['@import', 'external url()']))
  })

  it('drops a style sheet it cannot clean', () => {
    for (const css of [
      '.a{background:\\75rl(https://e.test)}',
      '.a{width:expression(alert(1))}',
      '.a{-moz-binding:none}',
      '.a{background:image-set("https://e.test/x.png" 1x)}',
      '.a{background:url(https://e.test/x.png}',
    ]) {
      const { svg, removed } = clean(`<svg ${NS}><style>${css}</style><rect/></svg>`)
      expect(svg).toBe(`<svg ${NS}><rect/></svg>\n`)
      expect(removed).toContain('<style>')
    }
  })

  it('removes an element nested inside a style sheet', () => {
    const { svg } = clean(`<svg ${NS}><style>.a{fill:red}<script>alert(1)</script></style></svg>`)
    expect(svg).toBe(`<svg ${NS}><style>.a{fill:red}</style></svg>\n`)
  })

  it('removes xml:base and namespace declarations for other vocabularies', () => {
    const { svg } = clean(
      `<svg ${NS} xmlns:xlink="https://e.test/not-xlink" xml:base="https://e.test/" xmlns:x="urn:x"><rect/></svg>`,
    )
    expect(svg).toBe(`<svg ${NS}><rect/></svg>\n`)
  })
})

describe('sanitiseSvg refuses what it cannot read safely', () => {
  it.each([
    ['a DOCTYPE with entities', `<!DOCTYPE svg [<!ENTITY x "y">]><svg ${NS}>&x;</svg>`, 'entities'],
    [
      'a billion-laughs DOCTYPE',
      `<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;">]><svg ${NS}>&lol2;</svg>`,
      'entities',
    ],
    [
      'an external entity',
      `<!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><svg ${NS}>&xxe;</svg>`,
      'entities',
    ],
    ['an undeclared entity', `<svg ${NS}><text>&nbsp;</text></svg>`, 'unknown entity'],
    ['a bare ampersand', `<svg ${NS}><text>a & b</text></svg>`, 'bare "&"'],
    ['a markup declaration in the body', `<svg ${NS}><!ENTITY x "y"></svg>`, 'markup declaration'],
    ['an HTML page', '<html><body><script>alert(1)</script></body></html>', 'not an SVG image'],
    ['a root in another namespace', '<svg xmlns="http://www.w3.org/1999/xhtml"/>', 'namespace'],
    ['mismatched tags', `<svg ${NS}><g></svg>`, 'do not match'],
    ['an unclosed element', `<svg ${NS}><g>`, 'never closed'],
    ['two root elements', `<svg ${NS}/><svg ${NS}/>`, 'more than one root'],
    ['text before the root', `hello<svg ${NS}/>`, 'outside the <svg>'],
    ['a duplicate attribute', `<svg ${NS}><rect x="1" x="2"/></svg>`, 'twice'],
    ['an unquoted attribute', `<svg ${NS}><rect x=1/></svg>`, 'not quoted'],
    ['an unclosed comment', `<svg ${NS}><!-- </svg>`, 'unclosed comment'],
    ['nothing at all', '   ', 'no <svg>'],
    ['an invalid character reference', `<svg ${NS}><text>&#0;</text></svg>`, 'invalid character'],
    ['absurd nesting', `<svg ${NS}>${'<g>'.repeat(300)}${'</g>'.repeat(300)}</svg>`, 'deep'],
  ])('refuses %s', (_label, input, reason) => {
    expect(refused(input)).toContain(reason)
  })

  it('refuses bytes that are not UTF-8', () => {
    expect(refused(new Uint8Array([0x3c, 0x73, 0x76, 0x67, 0xff, 0x3e]))).toBe(
      'it is not UTF-8 text',
    )
  })

  it('handles a large file in linear time', () => {
    const big = `<svg ${NS}>${'<rect x="1" y="2" width="3" height="4" fill="#abc"/>'.repeat(100_000)}</svg>`
    const started = performance.now()
    expect(clean(big).svg.length).toBe(big.length + 1)
    expect(performance.now() - started).toBeLessThan(5000)
  })
})

describe('isSvgName', () => {
  it('matches the extension case-insensitively', () => {
    expect(isSvgName('a.svg')).toBe(true)
    expect(isSvgName('assets/A.SVG')).toBe(true)
    expect(isSvgName('a.svg.png')).toBe(false)
    expect(isSvgName('svg')).toBe(false)
  })
})
