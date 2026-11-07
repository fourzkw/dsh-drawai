// End-to-end check: actual bundled texture and instrument sample in a rendered film.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { listMediaLibrary, importMediaLibrary } from '../lib/motion/media-catalog.js'
import { createProject, readTimeline, writeTimeline } from '../lib/motion/project.js'
import { addCue } from '../lib/motion/audio.js'
import { renderProject } from '../lib/motion/render.js'
import { ffmpegBinary } from '../lib/video-export.js'

const dir = mkdtempSync(resolve('.tmp/media-render-'))
try {
  createProject(dir, { spec: { width:256, height:256, fps:12, duration:2 }, segments:1 })
  const list = listMediaLibrary()
  const image = await importMediaLibrary(dir, list.find(x => x.category === 'paper').id)
  const sound = await importMediaLibrary(dir, list.find(x => x.category === 'piano').id)
  writeFileSync(join(dir,'scene-0.tsx'), `import React from 'react';\nimport {AbsoluteFill,Img,staticFile,delayRender,continueRender,cancelRender} from 'remotion';\nexport default function Scene(){const [wait]=React.useState(()=>delayRender('test bundled fonts'));React.useEffect(()=>{Promise.all([document.fonts.load('400 16px "Noto Sans SC"'),document.fonts.load('400 16px "Noto Serif SC"'),document.fonts.load('400 16px "Caveat"'),document.fonts.load('400 16px "Long Cang"'),document.fonts.load('400 16px "LXGW Marker Gothic"'),document.fonts.load('600 16px "Chakra Petch"')]).then(r=>{if(r.some(x=>x.length===0))throw Error('bundled fonts unavailable');continueRender(wait)}).catch(cancelRender)},[wait]);return <AbsoluteFill style={{background:'#000'}}><Img src={staticFile(${JSON.stringify(image.file)})} style={{width:'100%',height:'100%',objectFit:'cover'}} /><div style={{position:'absolute',fontFamily:'"Noto Sans SC"',fontSize:24}}>字体测试</div></AbsoluteFill>}\n`)
  const timeline = addCue(readTimeline(dir), { file:sound.file, role:'sfx', from:0, durationInFrames:24, gainDb:0 })
  writeTimeline(dir, timeline)
  const output = join(dir,'film.mp4')
  await renderProject(dir, { operation:'full', output, timeoutMs:120000, mix:{normalize:false} }).promise
  assert.ok(readFileSync(output).length > 1024)
  const pixels = execFileSync(ffmpegBinary(), ['-v','error','-ss','0.5','-i',output,'-frames:v','1','-vf','scale=1:1','-f','rawvideo','-pix_fmt','rgb24','-'])
  assert.ok(pixels[0] > 80 && pixels[1] > 80 && pixels[2] > 80, '纹理画面不应全黑')
  const analysis = String(spawnSync(ffmpegBinary(), ['-hide_banner','-i',output,'-af','volumedetect','-f','null','-'], {encoding:'utf8'}).stderr || '')
  const peak = analysis.match(/max_volume:\s*(-?\d+(?:\.\d+)?) dB/)
  assert.ok(peak && Number(peak[1]) > -70, '成片应有可检测到的乐器采样声音')
  console.log('真实成片通过：纸纹、多套内置字体加载和乐器声音均已验证，声音峰值 ' + peak[1] + ' dB')
} finally { rmSync(dir,{recursive:true,force:true}) }
