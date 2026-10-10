/**
 * 位图解码 —— 把图片文件解成原始 RGBA 像素，供「逐像素矢量化」使用。
 *
 * 两条路：
 *   1. **纯 Node 的 PNG 解码器**（零依赖，只用 node:zlib）：PNG 是矢量化最常见的输入
 *      （截图、导出的角色图），自己解能保证"宿主装了什么依赖都能用"。
 *   2. **可选 sharp**：非 PNG（JPEG / WebP / GIF…）自己没有解码器，装了 sharp 就用它。
 *      sharp 是可选依赖：没装时只报"这个格式解不开"，不影响 PNG 那条主路。
 *
 * 解码结果是 `{ width, height, data }`，data 是 **RGBA8**（`width*height*4` 字节），
 * 也就是矢量化的**唯一真相**：后面所有轮廓都从它算，中间不再碰文件。
 */

import { inflateSync } from 'node:zlib'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

/** PNG 的 8 字节签名。 */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** Adam7 隔行扫描的 7 遍起始坐标与步长（[x0, y0, dx, dy]）。 */
const ADAM7 = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
]

/** PNG 里每个像素占几个样本（按颜色类型）。 */
function samplesPerPixel(colorType) {
  if (colorType === 0) return 1 // 灰度
  if (colorType === 2) return 3 // RGB
  if (colorType === 3) return 1 // 调色板索引
  if (colorType === 4) return 2 // 灰度 + alpha
  if (colorType === 6) return 4 // RGBA
  throw new Error('PNG colorType ' + colorType + ' 不支持')
}

function isPng(bytes) {
  if (bytes.length < 8) return false
  for (let i = 0; i < 8; i += 1) if (bytes[i] !== PNG_SIGNATURE[i]) return false
  return true
}

/**
 * 解一条扫描线的过滤（PNG 规范 9.2）。
 *
 * bpp = 一个像素占的字节数（不是样本数 —— 过滤器按字节做，16 位样本也是 2 字节一组）。
 * filters 是这条扫描线自己的类型字节（0..4），prev 是**已经解过滤**的上一条扫描线。
 */
function unfilterLine(line, prev, filterType, bpp) {
  const n = line.length
  if (filterType === 0) return
  if (filterType === 1) {
    for (let i = bpp; i < n; i += 1) line[i] = (line[i] + line[i - bpp]) & 0xff
    return
  }
  if (filterType === 2) {
    if (prev === null) return
    for (let i = 0; i < n; i += 1) line[i] = (line[i] + prev[i]) & 0xff
    return
  }
  if (filterType === 3) {
    for (let i = 0; i < n; i += 1) {
      const left = i >= bpp ? line[i - bpp] : 0
      const up = prev === null ? 0 : prev[i]
      line[i] = (line[i] + ((left + up) >> 1)) & 0xff
    }
    return
  }
  if (filterType === 4) {
    for (let i = 0; i < n; i += 1) {
      const a = i >= bpp ? line[i - bpp] : 0
      const b = prev === null ? 0 : prev[i]
      const c = i >= bpp && prev !== null ? prev[i - bpp] : 0
      // Paeth 预测器：取 a/b/c 里与 p=a+b-c 最接近的那个
      const p = a + b - c
      const pa = p > a ? p - a : a - p
      const pb = p > b ? p - b : b - p
      const pc = p > c ? p - c : c - p
      const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      line[i] = (line[i] + pred) & 0xff
    }
    return
  }
  throw new Error('PNG 过滤器类型 ' + filterType + ' 不支持')
}

/**
 * 解一份 PNG 成 RGBA8。
 *
 * 支持：颜色类型 0/2/3/4/6、位深 1/2/4/8/16、Adam7 隔行、tRNS 透明。
 * 不支持（会明确报错）：颜色类型 1（已废弃）。
 */
export function decodePng(bytes) {
  if (!isPng(bytes)) throw new Error('不是 PNG（签名不对）')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  let width = 0
  let height = 0
  let bitDepth = 8
  let colorType = 6
  let interlace = 0
  let palette = null // Buffer（RGB 三元组）
  let paletteAlpha = null // Buffer（每索引一个 alpha）
  let trnsGray = null // 灰度/RGB 的单色透明键（这里只用于灰度）
  const idat = []

  let offset = 8
  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset)
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7])
    const dataStart = offset + 8
    const dataEnd = dataStart + length
    if (dataEnd + 4 > bytes.length) throw new Error('PNG 数据块 "' + type + '" 越界（文件截断？）')
    const chunk = bytes.subarray(dataStart, dataEnd)

    if (type === 'IHDR') {
      width = view.getUint32(dataStart)
      height = view.getUint32(dataStart + 4)
      bitDepth = bytes[dataStart + 8]
      colorType = bytes[dataStart + 9]
      interlace = bytes[dataStart + 12]
      if (width <= 0 || height <= 0) throw new Error('PNG 尺寸非法：' + width + '×' + height)
    } else if (type === 'PLTE') {
      palette = Buffer.from(chunk)
    } else if (type === 'tRNS') {
      if (colorType === 3) paletteAlpha = Buffer.from(chunk)
      else if (colorType === 0 && chunk.length >= 2) trnsGray = (chunk[0] << 8) | chunk[1]
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(chunk))
    } else if (type === 'IEND') {
      break
    }
    offset = dataEnd + 4 // 跳过 CRC
  }
  if (width === 0 || height === 0) throw new Error('PNG 缺 IHDR')
  if (idat.length === 0) throw new Error('PNG 缺 IDAT')
  if (colorType === 3 && palette === null) throw new Error('调色板 PNG 缺 PLTE')

  const spp = samplesPerPixel(colorType)
  const raw = inflateSync(Buffer.concat(idat))
  const out = Buffer.alloc(width * height * 4)

  // 一个像素在扫描线里的字节数（16 位样本是 2 字节）
  const pixelBytes = Math.ceil((spp * bitDepth) / 8)

  /** 把一行已解过滤的样本写进 RGBA 输出。samples 是该行的原始字节。 */
  function writeLine(samples, y, x0, dx, columns) {
    for (let col = 0; col < columns; col += 1) {
      const x = x0 + col * dx
      let r = 255
      let g = 255
      let b = 255
      let a = 255
      if (colorType === 3) {
        // 索引：位深 1/2/4/8
        let index
        if (bitDepth === 8) index = samples[col]
        else {
          const perByte = 8 / bitDepth
          const byte = samples[Math.floor(col / perByte)]
          const shift = 8 - bitDepth * ((col % perByte) + 1)
          index = (byte >> shift) & ((1 << bitDepth) - 1)
        }
        const p = index * 3
        r = palette[p]
        g = palette[p + 1]
        b = palette[p + 2]
        if (paletteAlpha !== null && index < paletteAlpha.length) a = paletteAlpha[index]
      } else if (colorType === 0 || colorType === 4) {
        // 灰度：位深 1/2/4/8/16，可带 alpha
        let v
        if (bitDepth === 8) v = samples[col * spp]
        else if (bitDepth === 16) v = samples[col * spp * 2] // 取高字节（8 位精度足够）
        else {
          const perByte = 8 / bitDepth
          const byte = samples[Math.floor(col / perByte)]
          const shift = 8 - bitDepth * ((col % perByte) + 1)
          const raw0 = (byte >> shift) & ((1 << bitDepth) - 1)
          v = Math.round((raw0 * 255) / ((1 << bitDepth) - 1)) // 1/2/4 位要拉伸到 0..255
        }
        if (trnsGray !== null && bitDepth === 8 && v === (trnsGray & 0xff)) a = 0
        r = v
        g = v
        b = v
        if (colorType === 4) a = bitDepth === 16 ? samples[col * spp * 2 + 2] : samples[col * spp + 1]
      } else {
        // RGB / RGBA
        if (bitDepth === 16) {
          r = samples[col * pixelBytes]
          g = samples[col * pixelBytes + 2]
          b = samples[col * pixelBytes + 4]
          if (colorType === 6) a = samples[col * pixelBytes + 6]
        } else {
          r = samples[col * spp]
          g = samples[col * spp + 1]
          b = samples[col * spp + 2]
          if (colorType === 6) a = samples[col * spp + 3]
        }
      }
      const o = (y * width + x) * 4
      out[o] = r
      out[o + 1] = g
      out[o + 2] = b
      out[o + 3] = a
    }
  }

  /** 解一条扫描线的过滤并回写。bytesPerLine 是"含过滤器字节前"的字节数。 */
  function readLine(samples, prev, cursor) {
    const filterType = raw[cursor]
    const line = raw.subarray(cursor + 1, cursor + 1 + samples.length)
    line.copy(samples)
    unfilterLine(samples, prev, filterType, pixelBytes)
    return cursor + 1 + samples.length
  }

  if (interlace === 0) {
    const bytesPerLine = Math.ceil((width * spp * bitDepth) / 8)
    let prev = null
    let cursor = 0
    for (let y = 0; y < height; y += 1) {
      const samples = Buffer.alloc(bytesPerLine)
      cursor = readLine(samples, prev, cursor)
      writeLine(samples, y, 0, 1, width)
      prev = samples
    }
  } else if (interlace === 1) {
    let cursor = 0
    for (let pass = 0; pass < ADAM7.length; pass += 1) {
      const [x0, y0, dx, dy] = ADAM7[pass]
      const columns = Math.ceil((width - x0) / dx)
      const rows = Math.ceil((height - y0) / dy)
      if (columns <= 0 || rows <= 0) continue
      const bytesPerLine = Math.ceil((columns * spp * bitDepth) / 8)
      let prev = null
      for (let row = 0; row < rows; row += 1) {
        const samples = Buffer.alloc(bytesPerLine)
        cursor = readLine(samples, prev, cursor)
        writeLine(samples, y0 + row * dy, x0, dx, columns)
        prev = samples
      }
    }
  } else {
    throw new Error('PNG interlace=' + interlace + ' 不支持')
  }

  return { width: width, height: height, data: out }
}

/** 是不是能被本模块解开的图片（按文件头判，不看后缀）。 */
export function looksLikeRaster(bytes) {
  if (bytes.length < 12) return false
  if (isPng(bytes)) return true
  // JPEG（SOI）
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return true
  // GIF
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return true
  // WebP（RIFF....WEBP）
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) return true
  return false
}

/**
 * sharp 可能装在哪：包名 + DSH profile 里那份（本机是这么装的）。
 *
 * 为什么本机路径写死：sharp 是可选依赖，没装它的部署不该因为我们 import 不到就崩；
 * 而宿主进程的 cwd 是**用户的工作区**、不在插件的 node_modules 链上，所以裸包名
 * 在这种部署里注定解析不到（package.json 里 sharp 也不是依赖）。
 */
const SHARP_CANDIDATES = [
  'sharp',
  'C:/Users/86476/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/sharp',
]

/**
 * 把候选解成**可 import 的入口文件 URL**。
 *
 * 这里踩过两个坑，都只能在真机上才发现：
 *   · 动态 import 的说明符必须是 URL 或裸包名，**给文件系统路径会抛
 *     ERR_UNSUPPORTED_ESM_URL_SCHEME**（`C:/…/sharp` 和 `C:/…/sharp/dist/index.cjs` 都是）；
 *   · 给**目录**还会抛 ERR_UNSUPPORTED_DIR_IMPORT —— ESM 不认目录，哪怕那个目录里有 package.json
 *     （sharp 0.35 是 CJS，main 指向 ./dist/index.cjs）。
 * 所以：先用 createRequire 的 require.resolve 解出**入口文件**，再用 pathToFileURL 转成
 * file:// URL。require.resolve 只用来"定位"、不用来加载任何东西；也正因为它认 package.json 的
 * exports/main，这条不依赖 sharp 内部目录布局（比写死 /dist/index.cjs 耐升级）。
 */
function resolveSharpImport() {
  const urls = []
  const req = createRequire(import.meta.url)
  const add = (candidate) => {
    try {
      const entry = req.resolve(candidate)
      const url = pathToFileURL(entry).href
      if (urls.indexOf(url) < 0) urls.push(url)
    } catch (error) {
      /* 这个候选不在（没装 / 解析不到），换下一个 */
    }
  }
  for (const candidate of SHARP_CANDIDATES) add(candidate)
  // 兜底：require.resolve 那条也可能失败（例如导出图把它藏了），此时按目录试常见入口。
  // pathToFileURL 会把目录路径照常编成 file:// URL，import 再按 package.json 的 main 解析。
  for (const candidate of SHARP_CANDIDATES) {
    if (candidate === 'sharp') continue
    add(candidate)
    add(candidate + '/dist/index.cjs')
  }
  // 去重：兜底可能补出与前一条相同的 URL（entry 与 /dist/index.cjs 同址时）
  const unique = urls.filter((value, index) => urls.indexOf(value) === index)
  return unique
}

/**
 * 非 PNG 的解码回退：**可选** sharp（宿主没装就返回 null，由调用方给一句人话报错）。
 *
 * 用动态 import 而不是顶层 import：没装 sharp 的部署不该连模块都加载不了。
 */
async function decodeWithSharp(bytes) {
  for (const spec of resolveSharpImport()) {
    let sharp
    try {
      const mod = await import(spec)
      sharp = mod.default !== undefined && mod.default !== null ? mod.default : mod
    } catch (error) {
      continue
    }
    if (typeof sharp !== 'function') continue
    try {
      const got = await sharp(Buffer.from(bytes)).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
      return { width: got.info.width, height: got.info.height, data: got.data }
    } catch (error) {
      throw new Error('sharp 解不开这份图片：' + (error && error.message ? error.message : String(error)))
    }
  }
  return null
}

/**
 * 解一份图片文件成 RGBA8。
 *
 * PNG 走自带解码器（零依赖、结果确定）；其余格式试 sharp，没有就给可执行的建议。
 */
export async function decodeRaster(bytes) {
  if (isPng(bytes)) return decodePng(bytes)
  if (!looksLikeRaster(bytes)) {
    throw new Error('这个文件不是能认的位图（PNG / JPEG / GIF / WebP）。要么换一张图，要么先把图转成 PNG。')
  }
  const viaSharp = await decodeWithSharp(bytes)
  if (viaSharp === null) {
    throw new Error('这种格式（非 PNG）需要 sharp 才能解；当前环境没装。把图转成 PNG（无损、体积也够小）再试。')
  }
  return viaSharp
}
