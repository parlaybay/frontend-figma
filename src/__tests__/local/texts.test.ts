import { recursiveReduceChildren } from '../../helpers/generics'
import { formatFileName, parseTextNode, roundDecimals, stripDebugInfoFromTextKeys } from '../../helpers/textHelper'
import figmaTree, { textKeys } from './data/figmaTree'

describe('text action tests', () => {
  it('can round to the expected number of decimals', () => {
    const length = 4
    const float = 1.123456789
    const rounded = roundDecimals(float, length)

    const [, decimals] = rounded.toString().split('.')

    expect(decimals.length).toEqual(length)
    expect(rounded.toString().slice(0, length + 2)).toEqual(rounded.toString()) // +2 to account for the '1.'
  })

  it('can strip debug from a textkey', () => {
    const textkey = { debug: true, shouldExist: { data: 1 } }

    const noDebug: any = stripDebugInfoFromTextKeys(textkey)

    expect(noDebug.textkey).toBe(undefined)
    expect(noDebug.shouldExist).toStrictEqual({ data: 1 })
  })

  it('can parse file name format correctly', () => {
    expect(formatFileName('sv.json', 'gazelle.[name].json')).toEqual('gazelle.sv.json')
    expect(formatFileName('sv.js', 'gazelle.[name].json')).toEqual('gazelle.sv.js.json')
    expect(formatFileName('sv.json')).toEqual('sv.json')
  })

  it('can parse text nodes', () => {
    const tree = figmaTree

    const reducer = (prev: any, node: any) =>
      parseTextNode(node, prev, {
        outDir: '',
        page: '',
        contextData: {},
        mergeWarnings: () => {},
        figmaFile: { name: '', pages: [], url: '' },
      })

    const children = recursiveReduceChildren({ child: tree.document, reducer })

    const testResult = Object.keys(textKeys).every(key => {
      const chars = children[key]?.characters === textKeys[key]
      const style = typeof children[key]?.style === 'object'
      const name = children[key]?.name === key

      return Boolean(chars && style && name)
    })

    expect(testResult).toBe(true)
  })
})
