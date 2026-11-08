import { existsSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from 'node:fs'
import { join, dirname, resolve, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { videoRuntimeRequire } from './motion/video-runtime.js'
import { validateMotionSources, sceneComponentPath } from './motion-source.js'
import { shotcraftModuleMap } from './motion-library.js'
import { enforceMotionCards } from './motion-library.js'
import { enforceMgStyle } from './motion-library.js'
import { validateMotionPlan } from './motion-core.js'
import { parseProjectJson } from './motion/json.js'

// Agent projects are edited on disk. Read their sources before validating or
// building; never restore a stale inline source over an agent's changes.
export function readMotionProject(directory, input) {
  const root=realpathSync(directory)
  const read=(name)=>{
    const file=realpathSync(join(root,name)),rel=relative(root,file)
    if(isAbsolute(rel)||rel==='..'||/^\.\.[\\/]/.test(rel))throw new Error('工程文件超出任务目录')
    return readFileSync(file,'utf8')
  }
  const raw=parseProjectJson(read('composition.json'))
  if(!Array.isArray(raw.shots))throw new Error('工程缺少 shots 分镜')
  raw.shots=raw.shots.map((shot,index)=>({...shot,sceneSource:read('scene-'+index+'.tsx'),
    ...(shot.sceneComponents?{sceneComponents:shot.sceneComponents.map(c=>({...c,source:read(sceneComponentPath('shot-'+(index+1),c.id))}))}:{})}))
  return enforceMgStyle(enforceMotionCards(validateMotionSources(validateMotionPlan(raw,input)),input),input)
}

// 入口与运行时 JSX 的源文件在插件里，但它们**必须被复制到工程目录**再引用：
// Remotion 的 webpack 只给 .tsx?/.ts 挂 esbuild-loader，配 .jsx? 的那条规则显式
// exclude /node_modules/ —— 插件装在 profile 的 node_modules 下时，入口 JSX 会被当成
// 普通文本解析，报 "Unexpected token (<AbsoluteFill>)"（issue #21、#22）。
const RUNTIME_ENTRY = fileURLToPath(new URL('./motion/entry.jsx', import.meta.url))
const RUNTIME_REFERENCE = fileURLToPath(new URL('./motion/reference-media.jsx', import.meta.url))
const GENERATED_HEADER = '// 由 dsh-drawai 生成，请勿手改；插件更新后会按源文件重新生成。\n'

// 只在内容变化时写盘：保持 mtime 稳定，bundle 缓存才不会每次重建。
function writeGenerated(file, source) {
  const desired = GENERATED_HEADER + source
  if (existsSync(file) && readFileSync(file, 'utf8') === desired) return
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, desired)
}

export function prepareMotionProject(composition, directory, options = {}) {
  validateMotionSources(composition)
  mkdirSync(directory, { recursive: true })
  const imports = [], entries = []
  composition.shots.forEach((shot, index) => {
    if (shot.recipeId !== 'scene') return
    const name = 'scene-' + index + '.tsx'
    if(!options.preserveSources)writeFileSync(join(directory, name), shot.sceneSource)
    for (const component of shot.sceneComponents || []) {
      const file = join(directory, sceneComponentPath(shot.id, component.id))
      mkdirSync(dirname(file), { recursive: true })
      if(!options.preserveSources)writeFileSync(file, component.source)
    }
    imports.push(`import Scene${index} from './${name}';`)
    entries.push(`${JSON.stringify(shot.id)}:Scene${index}`)
  })
  writeGenerated(join(directory, 'entry.gen.jsx'), readFileSync(RUNTIME_ENTRY, 'utf8'))
  writeGenerated(join(directory, 'reference-media.gen.jsx'), readFileSync(RUNTIME_REFERENCE, 'utf8'))
  const entryPoint = join(directory, 'index.jsx')
  const entrySource = `import {registerMotionRoot} from './entry.gen.jsx';\n${imports.join('\n')}\nregisterMotionRoot({${entries.join(',')}});\n`
  // 入口本身就是生成的：内容变了（换插件路径、增删镜头）就重写，不看 preserveSources。
  if(!existsSync(entryPoint) || readFileSync(entryPoint, 'utf8') !== entrySource)writeFileSync(entryPoint, entrySource)
  if(!options.preserveSources)writeFileSync(join(directory, 'composition.json'), JSON.stringify(composition, null, 2))
  if (composition.production && !options.preserveSources) {
    writeFileSync(join(directory, 'design.json'), JSON.stringify(composition.production, null, 2))
    writeFileSync(join(directory, 'storyboard.json'), JSON.stringify(composition.shots.map(({ sceneSource: _source, sceneComponents, ...shot }) => ({ ...shot,
      ...(sceneComponents ? { components: sceneComponents.map(({ source: _code, ...component }) => component) } : {}) })), null, 2))
  }
  const alias = Object.fromEntries(Object.entries(shotcraftModuleMap()).map(([name, url]) => [name + '$', fileURLToPath(url)]))
  // Demos use paths relative to the upstream repository. Generated components
  // live elsewhere: resolve known library paths without rewriting their source.
  const library = shotcraftModuleMap()
  const libraryImports = { apply(compiler) {
    compiler.hooks.normalModuleFactory.tap('DrawAiShotcraftImports', (factory) => {
      factory.hooks.beforeResolve.tap('DrawAiShotcraftImports', (request) => {
        if (!request?.request?.startsWith('.')) return
        const local = relative(resolve(directory), resolve(request.context))
        if (isAbsolute(local) || local === '..' || /^\.\.[\\/]/.test(local)) return
        const stem = resolve(request.context, request.request)
        if (['', '.tsx', '.ts', '.jsx', '.js', '/index.tsx', '/index.ts', '/index.js'].some((ext) => existsSync(stem + ext))) return
        const path = request.request.replaceAll('\\', '/').replace(/^(?:\.\.?\/)+/, '').replace(/\.(tsx?|jsx?)$/, '')
        const name = path.startsWith('demos/') ? '@shotcraft/' + path
          : path.startsWith('_fixtures/') ? '@shotcraft/demos/' + path
          : path.startsWith('assets/lib/') ? '@shotcraft/lib/' + path.slice('assets/lib/'.length)
          : path.startsWith('lib/') ? '@shotcraft/' + path : ''
        if (Object.hasOwn(library, name)) request.request = fileURLToPath(library[name])
      })
    })
  } }
  alias['@drawai/motion$'] = join(directory, 'reference-media.gen.jsx')
  // Resolve the runtime lazily: creating a project only writes its files, and
  // the video runtime may not be initialized yet (it is installed on first use).
  const runtimeModules = () => {
    const require = videoRuntimeRequire(options.runtimeDirectory)
    return [...new Set(['react', 'remotion', '@remotion/motion-blur'].map((name) => dirname(require.resolve(name + '/package.json')).replace(/[\\/]@remotion[\\/][^\\/]+$/, '').replace(/[\\/](?:react|remotion)$/, '')))]
  }
  return { entryPoint, webpackOverride: (config) => {
    const modules = runtimeModules()
    return { ...config, plugins: [...(config.plugins || []), libraryImports], resolve: { ...config.resolve,
      alias: { ...config.resolve?.alias, ...alias }, modules: [...modules, ...(config.resolve?.modules || ['node_modules'])] } }
  } }
}
