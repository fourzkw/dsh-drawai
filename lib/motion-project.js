/* 由 tools/build.mjs 生成 —— 请勿直接编辑；改 src/ 下的源文件。 */
import { existsSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from 'node:fs'
import { join, dirname, resolve, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { validateMotionSources, sceneComponentPath } from './motion-source.js'
import { shotcraftModuleMap } from './motion-library.js'
import { enforceMotionCards } from './motion-library.js'
import { enforceMgStyle } from './motion-library.js'
import { validateMotionPlan } from './motion-core.js'
import { parseProjectJson } from './motion/json.js'
const require = createRequire(import.meta.url)

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
  const runtime = fileURLToPath(new URL('./motion/entry.jsx', import.meta.url)).replaceAll('\\', '/')
  const entryPoint = join(directory, 'index.jsx')
  if(!options.preserveSources||options.refreshEntry||!existsSync(entryPoint))writeFileSync(entryPoint, `import {registerMotionRoot} from ${JSON.stringify(runtime)};\n${imports.join('\n')}\nregisterMotionRoot({${entries.join(',')}});\n`)
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
  alias['@drawai/motion$'] = fileURLToPath(new URL('./motion/reference-media.jsx', import.meta.url))
  const modules = [...new Set(['react', 'remotion', '@remotion/motion-blur'].map((name) => dirname(require.resolve(name + '/package.json')).replace(/[\\/]@remotion[\\/][^\\/]+$/, '').replace(/[\\/](?:react|remotion)$/, '')))]
  return { entryPoint, webpackOverride: (config) => ({ ...config, plugins: [...(config.plugins || []), libraryImports], resolve: { ...config.resolve,
    alias: { ...config.resolve?.alias, ...alias }, modules: [...modules, ...(config.resolve?.modules || ['node_modules'])] } }) }
}
