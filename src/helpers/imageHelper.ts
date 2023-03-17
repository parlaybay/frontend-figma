/* eslint-disable no-return-await */
/* eslint-disable no-restricted-syntax */

import camelcase from 'camelcase'
import path from 'path'
import https from 'https'
import fs, { promises as fsAsync } from 'fs'
import { transform } from '@svgr/core'
import ora, { Ora } from 'ora'
import chalk from 'chalk'
import { GetImageResult } from 'figma-api/lib/api-types.js'
import sharp from 'sharp'
import * as prompts from './prompts'
import { createWarning, mergeTextkeys, stripDebugInfoFromTextKeys, writeWarningLog } from './textHelper'
import { getAllProjectFiles, NodeParserContext } from './generics'
import { ConfigFile, FigmaFile, ImageKey, IMAGEKEY_FILE_NAME, ImageVariant, IMAGE_DIR_NAME, Warning } from './constants'
import { Figma } from '../abtractions/figma'
import { ProgramFlags } from '../cli'

export const getImageOutputDir = (outDir?: string): string => {
  const endsWithFilename = outDir && path.extname(outDir).includes('.')
  const outDirName = endsWithFilename ? path.dirname(outDir) : outDir

  const outPath = path.join(process.cwd(), IMAGE_DIR_NAME)

  if (outDirName) {
    if (path.isAbsolute(outDirName)) {
      return path.join(outDirName)
    }

    return path.join(process.cwd(), outDirName)
  }

  return outPath
}

const parseImageName = (name: string) => camelcase(name.replaceAll('/', '-'))

export const parseImageNode = (node: any, prev: any, { variant, outDir, page, figmaFile, mergeWarnings }: NodeParserContext) => {
  const [exportSettings] = node?.exportSettings ?? []

  if (!exportSettings) return prev

  const name = parseImageName(path.basename(node.name))

  const format = exportSettings ? exportSettings.format.toString().toLowerCase() : 'png'
  const scale = exportSettings ? exportSettings.constraint.value : 1
  const filename = `${name}.${format}`
  const { width, height } = node.absoluteBoundingBox

  const absoluteFilePath = path.join(getImageOutputDir(outDir), filename)
  const relativeFilePath = path.relative(process.cwd(), absoluteFilePath)

  const prevVariants: Record<string, any> = prev[name]?.variants ?? {}

  const newNode = {
    debug: {
      id: node.id,
      page,
    },
    name,
    format,
    scale,
    id: node.id,
    url: relativeFilePath,
  }

  if (variant) {
    if (Object.keys(prevVariants).includes(variant)) {
      mergeWarnings?.([
        createWarning({
          node,
          figmaFile,
          description: `found duplicate image inside variant ${variant} frame`,
          page,
        }),
      ])
    }

    return {
      ...prev,
      [name]: {
        ...newNode,
        variants: {
          ...prevVariants,
          [variant]: {
            id: node.id,
            width,
            height,
          },
        },
      },
    }
  }

  return {
    ...prev,
    [name]: newNode,
  }
}

const svgr =
  (outputPath: string, native = false) =>
  (chunks: Buffer[]) => {
    const [filename] = path.basename(outputPath).split('.')
    const svg = Buffer.concat(chunks).toString()

    return transform(
      svg,
      {
        plugins: ['@svgr/plugin-jsx'],
        typescript: true,
        prettier: true,
        svgo: false,
        native,
      },
      {
        componentName: filename,
      },
    ).catch(error => {
      console.error(chalk.red('\nUnable to parse SVG'))
      console.error(error)
    })
  }

const optimizePNG =
  ({ quality, optimize }: { quality: number; optimize: boolean }) =>
  async (chunks: Buffer[]) => {
    const buffer = Buffer.concat(chunks)

    if (optimize === false) {
      return buffer
    }

    return sharp(buffer)
      .png({ quality: quality * 100 })
      .toBuffer()
  }

const download = (url: string, outputPath: string, parser?: (data: Buffer[]) => Promise<string | Buffer | void>, storeSource?: string) =>
  new Promise((resolve, reject) => {
    const stream = fs.createWriteStream(outputPath, { flags: 'w' })
    const source = storeSource ? fs.createWriteStream(storeSource, { flags: 'w' }) : undefined
    const chunks: Buffer[] = []

    stream.on('close', resolve).on('error', reject)

    https.get(url, res => {
      if (!parser) return res.pipe(stream)

      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => {
        if (chunks.length === 0) {
          console.warn(
            chalk.redBright(
              `\nDownloaded image with 0 chunks (${outputPath}), most likely an invalid or empty image/svg or its not exported in figma`,
            ),
          )

          stream.close()
          fsAsync.unlink(outputPath)

          if (source && storeSource) {
            source.close()
            fsAsync.unlink(storeSource)
          }

          return
        }

        if (source) {
          source.write(Buffer.concat(chunks).toString())
          source.close()
        }

        parser(chunks).then(data => {
          if (!data) {
            console.warn(chalk.redBright(`\nImage parser returned 0 chunks (${outputPath}), most likely an invalid or empty image/svg`))
            return stream.close()
          }

          stream.write(data)
          stream.close()
        })
      })
    })
  })

export type DownloadOptions = { quality: number; optimize: boolean; tsx: boolean; native: boolean }

const handleImageDownload = async (image: ImageKey, url: string, options: DownloadOptions) => {
  const isSVG = image.url.endsWith('svg')
  const isPDF = image.url.endsWith('pdf')
  const isPNG = image.url.endsWith('png')

  const [filename] = path.basename(image.url).split('.')
  const dirpath = path.dirname(image.url)

  const svgfilepath = path.join(dirpath, `${filename}.tsx`)

  if (isPNG) {
    return download(url, image.url, optimizePNG(options))
  }

  if (isPDF) {
    return download(url, image.url)
  }

  if (options.tsx && isSVG) {
    return download(url, svgfilepath, svgr(image.url, options.native))
  }

  if (isSVG) {
    return download(url, path.join(dirpath, `${filename}.svg`))
  }

  return download(url, image.url)
}

interface DownloadResult {
  downloadPromises: Promise<unknown>[]
  progress: Record<string, boolean>
}

export async function downloadImagesWithProgress(
  images: Record<string, ImageKey>,
  imageURLs: Record<string, string>,
  currentImagesDirPath: string,
  options: DownloadOptions,
): Promise<DownloadResult> {
  const downloadProgress: Record<string, boolean> = {}
  const imageArray = Object.values(images)

  let currentImagesObject: Record<string, ImageKey> | null = null

  try {
    const currentImagesFile = await fsAsync.readFile(path.join(currentImagesDirPath, '..', IMAGEKEY_FILE_NAME), { encoding: 'utf-8' })
    currentImagesObject = JSON.parse(currentImagesFile)
  } catch (error) {
    console.warn('No previous images found, downloading all images')
  }

  const downloadPromises = Object.entries(imageURLs).map(([id, url]) => {
    if (currentImagesObject?.[path.basename(url!).split('.')[0]]) {
      return Promise.resolve()
    }

    if (!url) {
      return Promise.resolve()
    }

    const image = imageArray.find(image => image.id === id)

    if (!image) {
      return Promise.resolve()
    }

    downloadProgress[id] = false

    const imageDownload = handleImageDownload(image, url, options)

    imageDownload.then(() => {
      downloadProgress[id] = true
    })

    return imageDownload
  })

  return { downloadPromises, progress: downloadProgress }
}

type HandleProgressProps<T> = {
  promise: Promise<T>[]
  progress: Record<string, boolean>
}

export const handleProgress = <T>(
  { promise, progress }: HandleProgressProps<T>,
  onUpdate?: (value: number, total: number, spinner: Ora) => void,
): Promise<T[]> => {
  const spinner = ora('').start()
  const total = Object.keys(progress).length
  const value = Object.values(progress).filter(v => v).length

  const updateSpinner = () => {
    onUpdate?.(value, total, spinner)
  }

  const interval = setInterval(updateSpinner, 50)

  const all = Promise.all(promise)

  all
    .then(() => {
      spinner.succeed()
      clearInterval(interval)
    })
    .finally(() => {
      updateSpinner()
    })

  return all
}

interface ImageMap {
  [id: string]: string
}

const mapImageURL = (images: GetImageResult[]) => images.reduce((prev, result) => ({ ...prev, ...result.images }), {})

export const getUrlsForImages = async (figma: Figma, figmaFile: FigmaFile, images: ImageKey[][]): Promise<ImageMap> => {
  const imageRequests = images
    .filter(imageSet => imageSet.length > 0)
    .map(imageSet => {
      const [firstImage] = imageSet
      const { format, scale } = firstImage

      const ids = imageSet.map(({ id }) => id).join(',')

      return figma.image(figmaFile.url, { ids, scale: scale > 4 ? 1 : scale, format })
    })

  const results = await Promise.all(imageRequests)

  return mapImageURL(results)
}

type GroupedImages = Record<string, ImageKey[]>

export const groupImagesByTypeAndScale = (images: Record<string, ImageKey>): GroupedImages => {
  const groupedImages: GroupedImages = {}

  for (const [, imageKey] of Object.entries(images)) {
    const { scale, format } = imageKey

    const key = `${format}_${scale}`
    const prevImages: ImageKey[] = groupedImages[key] || []

    groupedImages[key] = [...prevImages, imageKey]
  }

  return groupedImages
}

export const handleMissingProject = async <T extends Record<string, any>>(
  figma: Figma,
  config: ConfigFile,
  imageActionFunction: (file: string, flags?: T & ProgramFlags) => Promise<void>,
  flags?: T & ProgramFlags,
): Promise<void> => {
  const spinner = ora('Fetching project files...').start()
  const { files } = await getAllProjectFiles(figma, config.PROJECT_ID)

  spinner.succeed()

  const filteredFiles = files.filter(file => file.name !== 'Untitled')
  const choices = filteredFiles.map(file => ({ message: file.name, name: file.name }))

  const { file } = await prompts.projectSelect(choices)

  if (!file) {
    throw new Error('No project file selected')
  }

  return imageActionFunction(file, flags)
}

export const writeImageKeys = async (imageOutPath: string, keys: Record<string, any>, merge = false): Promise<string> => {
  const filepath = path.join(imageOutPath, '..', IMAGEKEY_FILE_NAME)
  const finalJSON = stripDebugInfoFromTextKeys(keys)

  const merged = merge ? await mergeTextkeys(filepath, finalJSON) : finalJSON

  await fsAsync.writeFile(filepath, JSON.stringify(merged, null, 2), 'utf-8')

  return filepath
}

function sortImagesBySize(images: ImageVariant[]): ImageVariant[] {
  if (!images.length) {
    return []
  }

  return images.sort((a, b) => {
    const widthA = a?.width || 1
    const heightA = a?.height || 1

    const widthB = b?.width || 1
    const heightB = b?.height || 1

    const valueA = widthA * heightA
    const valueB = widthB * heightB

    return valueB - valueA
  })
}

type ImageLoggingOptions = {
  log?: boolean
  warnings: Warning[]
  variantWarnings: [ImageKey, string[]][]
  project: string
  figmaFile: FigmaFile
}

export const handleImagesLogging = async ({
  log,
  warnings = [],
  variantWarnings = [],
  project,
  figmaFile,
}: ImageLoggingOptions): Promise<void> => {
  if (variantWarnings?.length) {
    console.log(chalk.yellow(`${variantWarnings.length} images are missing a variant`))
  }

  if (!warnings?.length) return

  const message = `${warnings.length} images are missing exports or have been overwritten${
    log ? ', pass the --log flag for more info' : ''
  }`

  console.log(chalk.yellow(message))

  if (!log) return

  const variantWarningsFormatted = variantWarnings.map(([image, missingVariants]) => ({
    node: { id: image.id, name: image.name },
    figmaFile,
    description: `${image.name} is missing the following variants: ${missingVariants.join(', ')}`,
  }))

  const allWarnings = [...warnings, ...variantWarningsFormatted].flat()

  if (!allWarnings.length) {
    console.log(chalk.yellow('Attempted to write a log file, but there are no warnings'))
    return
  }

  try {
    const logPaths = await Promise.allSettled(allWarnings.map(async warning => await writeWarningLog(warning, project)))

    logPaths.forEach(result => {
      if (result.status === 'fulfilled') {
        ora(chalk.yellow(`Written warnings log to '${result.value}'`)).succeed()
      } else {
        console.error(result.reason)
      }
    })
  } catch (error) {
    console.error(error)
  }
}

function findMissingVariants(image: ImageKey, variants: string[]): string[] {
  const missingVariants: string[] = []

  for (const variant of variants) {
    if (!image.variants?.[variant]) {
      missingVariants.push(variant)
    }
  }

  return missingVariants
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined
}

export function reduceDesktopVariants(
  images: Record<string, ImageKey>,
  variants: string[],
): [Record<string, ImageKey>, [ImageKey, string[]][]] {
  const warnings: [ImageKey, string[]][] = []

  if (variants.length === 0) {
    return [images, warnings]
  }

  const desktopVariants: Record<string, ImageKey> = {}

  for (const [key, value] of Object.entries(images)) {
    const missingVariants = findMissingVariants(value, variants)

    if (missingVariants.length > 0) {
      warnings.push([value, missingVariants])
    }

    const imageVariants = variants.map(variant => value?.variants?.[variant]).filter(isDefined) as ImageVariant[]
    const largestImage = sortImagesBySize(imageVariants)[0]

    desktopVariants[key] = {
      ...value,
      id: largestImage?.id ?? value.id,
    }
  }

  return [desktopVariants, warnings]
}
