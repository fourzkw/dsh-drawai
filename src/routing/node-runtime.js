// The upstream scripts publish only into this private VM context, never the host globals.
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
let runtime
export function getRoutingRuntime() {
  if (!runtime) {
    runtime = { console, performance, setTimeout, clearTimeout }
    for (const file of ['libavoid.min.js', 'libavoid-routing.js']) {
      runInNewContext(readFileSync(new URL('./vendor/' + file, import.meta.url), 'utf8'), runtime, { filename: file })
    }
    if (!runtime.Avoid?.Router) throw new Error('libavoid initialization failed')
  }
  return runtime
}
