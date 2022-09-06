import camelcase from 'camelcase'
import { Effect, EffectType, FRAME, Node, StyleType, TEXT } from 'figma-api'
import path from 'path'
import { promises as fsAsync } from 'fs'
import chalk from 'chalk'
import { GetFileResult } from 'figma-api/lib/api-types.js'
import { getRGBStringAlphaMerged, parseStyle, roundDecimals } from './textHelper'
import { EMU_TOKEN_TYPE_LAYER_NAME, TOKENS_DIR_NAME } from './constants'
import { recursiveReduceChildren } from './generics'

type NodeStyle = {
  key: string
  name: string
  description: string
  styleType: StyleType
  nodeId: string
}

// The child is either frame or text
type TokenChild = FRAME & TEXT & Node
type TokenParser = (node: TokenChild, nodeStyles: NodeStyle[]) => [string, string | number | Record<string, any>] | void
type CurriedTokenParser = (keyParser: (name: string, noPrefix?: boolean) => string, noPrefix?: boolean) => TokenParser

type StyleKeys = 'fill' | 'text' | 'effect' | 'grid'
type StyleMap = Record<StyleKeys, string | undefined>

export const parseStyleNodes = (file: GetFileResult): NodeStyle[] =>
  Object.keys(file.styles).map(nodeId => ({ nodeId, ...file.styles[nodeId] }))

export const parseKeyName = (name: string, noPrefix?: boolean) => {
  const prefixedName = noPrefix ? name.split('/').slice(-1).join('') : name

  return camelcase(prefixedName.replaceAll('/', '-'))
}

const parseStyleKeyName = (name: string, noPrefix?: boolean) => {
  const prefixedName = noPrefix ? name.split('/').slice(-1).join('') : name

  return camelcase(prefixedName.replaceAll(/\W/g, '-'))
}

const parseColorTokens: CurriedTokenParser = (keyParser, noPrefix) => (child, nodeStyles) => {
  const fillStyles = nodeStyles.filter(node => node.styleType === 'FILL')

  // The official TS says the keys are in full caps, but theyre not
  const styleNode = fillStyles.find(node => node.nodeId === (child?.styles as unknown as StyleMap)?.fill)

  if (!styleNode) return

  // child.background is deprecated, its now stored in child.fills
  const [{ color, opacity, gradientStops }] = [...child.fills, ...child.strokes]
  const key = keyParser(styleNode.name, noPrefix)

  if (gradientStops) {
    const [{ color: startColor }, { color: endColor }] = gradientStops

    return [key, `linear-gradient(135deg, ${getRGBStringAlphaMerged(startColor)} 0%, ${getRGBStringAlphaMerged(endColor)} 100%)`]
  }

  if (color) {
    return [key, getRGBStringAlphaMerged({ ...color, a: opacity ?? color?.a })]
  }
}

const parseShadowTokens: CurriedTokenParser = (keyParser, noPrefix) => (child, nodeStyles) => {
  // The official TS says the keys are in full caps, but theyre not
  const styleNode = nodeStyles.find(node => node.nodeId === (child?.styles as unknown as StyleMap)?.effect)
  const effect = child.effects.find(effect => effect.type === EffectType.DROP_SHADOW)

  if (!styleNode || !effect) return

  const key = keyParser(styleNode.name, noPrefix)
  const { offset, radius, color } = effect as Required<Effect>

  return [key, `${offset.x.toFixed()}px ${offset.y.toFixed()}px ${radius.toFixed()}px ${getRGBStringAlphaMerged(color)}`]
}

const parseStyleTokens: CurriedTokenParser = keyParser => child => {
  if (child.type !== 'TEXT') return

  return [keyParser(child.name), parseStyle(child.style)]
}

const defaultNumberTokenParser: CurriedTokenParser = keyParser => child => {
  if (child.type !== 'TEXT') return

  const parsedFloat = parseFloat(child.characters)
  const data = Number.isNaN(parsedFloat) ? child.characters : roundDecimals(parsedFloat, 2)

  return [keyParser(child.name), data]
}

const defaultTokenParser: CurriedTokenParser = keyParser => child => {
  if (child.type !== 'TEXT') return

  return [keyParser(child.name), child.characters]
}

const findTokensRoot = (file: GetFileResult, name: string) => {
  const { children } = (file.document.children.find(node => node.name === name) as any) ?? {}
  return children?.find((node: any) => node.name === name)
}

// eslint-disable-next-line arrow-body-style
const createTokensTypescriptFile = (json: Record<string, string>) => {
  return `/* eslint-disable */
// prettier-ignore
// THIS FILE IS AUTO-GENERATED BY EMU. DO NOT MAKE EDITS IN THIS FILE! CHANGES WILL GET OVER-WRITTEN BY ANY FURTHER PROCESSING.
export default ${JSON.stringify(json, null, 2)}`
}

export const getTokensOutputDir = (outDir?: string, config?: any): string => {
  const endsWithFilename = outDir && path.extname(outDir).includes('.')
  const outDirName = endsWithFilename ? path.dirname(outDir) : outDir

  const outPath = path.join(process.cwd(), TOKENS_DIR_NAME)

  if (outDirName) {
    if (path.isAbsolute(outDirName)) {
      return path.join(outDirName)
    }

    return path.join(process.cwd(), outDirName)
  }

  if (config?.defaults?.tokensOutputDirectory) {
    return getTokensOutputDir(config.defaults.tokensOutputDirectory)
  }

  return outPath
}

export const convertTokensToFiles = (tokens: Record<string, Record<string, string>>) =>
  Object.entries(tokens).reduce<Record<string, string>>(
    (files, [filename, json]) => ({ ...files, [filename]: createTokensTypescriptFile(json) }),
    {},
  )

export const writeTokenFiles = (tokens: Record<string, string>, dirPath: string) =>
  Object.entries(tokens).map(([filename, data]) => fsAsync.writeFile(path.join(dirPath, `${filename}.ts`), data))

const getTokenType = (page: any) => page.children?.find((child: Node) => child.name === EMU_TOKEN_TYPE_LAYER_NAME)?.characters

const getTokenParser = (type: string, noPrefix?: boolean): TokenParser => {
  if (type === 'colors') {
    return parseColorTokens(parseStyleKeyName, noPrefix)
  }

  if (type === 'shadows') {
    return parseShadowTokens(parseStyleKeyName, noPrefix)
  }

  if (type === 'numbers') {
    return defaultNumberTokenParser(parseKeyName)
  }

  if (type === 'styles') {
    return parseStyleTokens(parseKeyName)
  }

  return defaultTokenParser(parseKeyName)
}

type ParseTokensOptions = {
  noPrefix?: boolean
}

export const parseTokens = (file: GetFileResult, options?: ParseTokensOptions) => {
  const nodeStyles = parseStyleNodes(file)
  const tokens = file.document.children.map(child => child.name)

  return tokens.reduce<Record<string, Record<string, string>>>((allTokens, token) => {
    const rootPage = file.document.children.find(node => node.name === token) as any
    const rootFrame = findTokensRoot(file, token)

    const tokensType = getTokenType(rootPage)

    if (typeof rootFrame === 'undefined') {
      const pages = file.document.children.map(child => child.name)
      const rootLayers = rootPage?.children?.map((child: Node) => child.name)

      console.error(chalk.red(`Unable to find frame '${token}' in page '${token}'. Could it the wrong file?`))
      console.error(chalk.red(`Found these pages at the top: ${pages.join(', ')}`))
      console.error(chalk.red(`Found these layers at the top (a frame named '${token}' should be here): ${rootLayers.join(', ')}`))

      return allTokens
    }

    const reducer = (prev: any, node: any) => {
      const [key, value] = getTokenParser(tokensType, options?.noPrefix)(node, nodeStyles) ?? []

      return key ? { ...prev, [key]: value } : prev
    }

    const parsedTokens = recursiveReduceChildren({
      child: rootFrame,
      reducer,
      test: node => node.name !== 'hidden',
      initial: {},
    })

    return { ...allTokens, [token]: parsedTokens }
  }, {})
}
