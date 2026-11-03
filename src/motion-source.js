import { parse } from '@babel/parser'
import traverseModule from '@babel/traverse'
const traverse = traverseModule.default || traverseModule

// Check the TSX module contract only. Remotion handles module resolution and
// compilation; generated scenes use normal JavaScript/TypeScript semantics.
export function validateSceneSource(source) {
  if (typeof source !== 'string' || !source.trim()) throw new Error('场景源码不能为空')
  const ast = parse(source, { sourceType: 'module', plugins: ['jsx', 'typescript'] })
  let hasDefault = false
  const imports = new Set()
  traverse(ast, {
    ImportDeclaration(path) { imports.add(path.node.source.value) },
    ExportDefaultDeclaration() { hasDefault = true },
    ExportNamedDeclaration(path) {
      if (path.node.exportKind === 'type') return
      for (const specifier of path.node.specifiers) {
        if (specifier.exportKind !== 'type' && (specifier.exported?.name || specifier.exported?.value) === 'default') hasDefault = true
      }
    },
  })
  if (!hasDefault) throw new Error('场景必须 default export React 组件')
  return { source, imports: [...imports] }
}
export function validateMotionSources(composition) {
  for (const shot of composition.shots) if (shot.recipeId === 'scene') {
    for (const component of shot.sceneComponents || []) {
      try { validateSceneSource(component.source) }
      catch (error) { throw new Error(sceneComponentPath(shot.id, component.id) + ': ' + error.message) }
    }
    try { validateSceneSource(shot.sceneSource) }
    catch (error) { throw new Error(shot.id + ' Scene.tsx: ' + error.message) }
  }
  return composition
}

export function sceneComponentPath(shotId, componentId) {
  if (!/^shot-[1-9]\d*$/.test(shotId) || !/^[A-Z][A-Za-z0-9]{0,47}$/.test(componentId)) throw new Error('场景组件路径无效')
  return 'components/' + shotId + '/' + componentId + '.tsx'
}

export function composeSceneSource(shot) {
  return "import React from 'react';\nimport {AbsoluteFill} from 'remotion';\n"
    + shot.sceneComponents.map((component, i) => `import Layer${i} from './${sceneComponentPath(shot.id, component.id)}';`).join('\n')
    + '\nexport default function Scene({shot,assets}) { return <AbsoluteFill>'
    + shot.sceneComponents.map((_component, i) => `<Layer${i} shot={shot} assets={assets}/>`).join('')
    + '</AbsoluteFill>; }\n'
}
