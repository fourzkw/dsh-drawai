import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {assetsHash,fetchAsset} from '../lib/motion/assets.js'
import {createProject,buildComposition} from '../lib/motion/project.js'
import {bundleKey} from '../lib/motion/render.js'

const dir=mkdtempSync(resolve('.tmp/motion-cache-')),originalFetch=globalThis.fetch
try {
  createProject(dir,{theme:'vintage-kraft'})
  const file=join(dir,'assets','sample.txt');writeFileSync(file,'AAAA')
  const key=()=>bundleKey(buildComposition(dir),dir)
  const first=key(),firstAssets=assetsHash(dir)
  writeFileSync(file,'BBBB')
  assert.notEqual(assetsHash(dir),firstAssets,'同大小素材变动必须重建')
  const second=key();assert.notEqual(second,first)
  writeFileSync(join(dir,'theme.ts'),'export const test = 1')
  const third=key();assert.notEqual(third,second,'主题变动必须重建')
  mkdirSync(join(dir,'components'),{recursive:true});writeFileSync(join(dir,'components','shared.tsx'),'export const test = 2')
  const fourth=key();assert.notEqual(fourth,third,'共享组件变动必须重建')
  mkdirSync(join(dir,'.out'),{recursive:true});writeFileSync(join(dir,'.out','unrelated.js'),'test')
  assert.equal(key(),fourth,'渲染输出不能导致永久失效')
  const svg='<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/>'
  globalThis.fetch=async()=>new Response(svg,{headers:{'content-type':'image/svg+xml'}})
  const saved=await fetchAsset(dir,'https://example.test/logo.svg')
  assert.equal(readFileSync(join(dir,'assets',saved.file),'utf8'),svg)
  let chunks=0,cancelled=false
  globalThis.fetch=async()=>new Response(new ReadableStream({pull(c){chunks++; c.enqueue(new Uint8Array(8*1024*1024))},cancel(){cancelled=true}}),{headers:{'content-type':'image/png'}})
  await assert.rejects(fetchAsset(dir,'https://example.test/large.png'),/超过 24MB/)
  assert.ok(chunks<=5,'超限后停止继续读取')
  assert.ok(cancelled,'超限时取消响应流')
  console.log('素材内容/主题/共享组件缓存失效和下载流上限通过')
} finally {globalThis.fetch=originalFetch;rmSync(dir,{recursive:true,force:true})}
