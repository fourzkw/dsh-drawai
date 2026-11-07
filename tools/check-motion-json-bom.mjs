import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createProject, readTimeline, buildComposition } from '../lib/motion/project.js'
import { readAssets } from '../lib/motion/assets.js'
import { writeBuiltinAssets } from '../lib/motion/builtin-assets.js'
import { readTheme } from '../lib/motion/theme.js'
import { readManifest as readSfx } from '../lib/motion/sfx.js'
import { RenderJobs } from '../lib/motion/jobs.js'
import { readQaReport } from '../lib/motion/qa.js'

mkdirSync('.tmp', { recursive: true })
const dir = mkdtempSync(resolve('.tmp/motion-json-bom-'))
const save = (file, value) => { mkdirSync(resolve(file, '..'), { recursive: true }); writeFileSync(file, '\ufeff' + JSON.stringify(value), 'utf8') }
try {
  createProject(dir, { spec: { width: 960, height: 540, fps: 25, duration: 4 }, segments: 1 })
  const timelineFile = join(dir, 'timeline.json'), original = JSON.parse(readFileSync(timelineFile, 'utf8'))
  save(timelineFile, original)
  assert.equal(readTimeline(dir).width, 960)
  assert.equal(buildComposition(dir).durationFrames, 100, 'render input reads a BOM-prefixed timeline')
  assert.equal(readFileSync(timelineFile, 'utf8').charCodeAt(0), 0xfeff, 'reading does not rewrite the user file')

  const index = join(dir, 'assets', 'manifest.json'), items = readAssets(dir).items
  items.push({ id: 'user', file: 'user.png', sha256: 'custom' })
  save(index, { version: 1, items })
  assert.ok(readAssets(dir).items.some(item => item.id === 'user'))
  writeBuiltinAssets(dir)
  assert.ok(readAssets(dir).items.some(item => item.id === 'user'), 'builtin assets preserve BOM-prefixed user manifest')
  save(join(dir, 'theme.json'), { name: 'custom', tokens: { paper: '#fff' } })
  assert.equal(readTheme(dir).name, 'custom')
  save(join(dir, 'assets', 'audio-manifest.json'), { version: 1, assets: [{ id: 'sound' }] })
  assert.equal(readSfx(dir).assets[0].id, 'sound')
  save(join(dir, '.out', 'jobs.json'), [{ id: 'job-test', dir, kind: 'pilot', status: 'done' }])
  assert.equal(new RenderJobs().list(dir)[0].id, 'job-test')
  save(join(dir, '.out', 'qa', 'framecq', 'report.json'), { status: 'pass' })
  assert.equal(readQaReport(dir).status, 'pass')

  writeFileSync(timelineFile, '\ufeff{ invalid json', 'utf8')
  assert.throws(() => readTimeline(dir), SyntaxError, 'invalid JSON must still fail')
  console.log('Motion project JSON: BOM-prefixed timeline, composition, assets, theme, audio index, jobs and QA passed; malformed JSON still fails.')
} finally { rmSync(dir, { recursive: true, force: true }) }
