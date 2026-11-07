import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'

let route
const disposers = []
apply({
  tools: { register() { return () => {} } },
  webServer: { register(value) { route = value; return () => {} } },
  fs: {}, sessions: {}, sandboxPolicy: {},
  effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); return dispose },
})
const originalFetch = globalThis.fetch
let networkCalls = 0
globalThis.fetch = async () => { networkCalls++; throw new Error('Disabled image generation must not contact providers') }
try {
  for (const action of ['imagegen-generate', 'imagegen-status', 'imagegen-default-workflow']) {
    const listeners = {}
    const req = { method: 'POST', headers: { 'x-drawai-save': '1' },
      on(event, fn) { listeners[event] = fn; return this } }
    let status, payload
    const res = { writeHead(code) { status = code }, end(text) { payload = JSON.parse(text) } }
    queueMicrotask(() => { listeners.data?.(Buffer.from(JSON.stringify({action}))); listeners.end?.() })
    await route.handler(req, res)
    assert.equal(status, 503, action)
    assert.equal(payload.ok, false, action)
    assert.match(payload.error, /文生图功能暂未开放/)
  }
  assert.equal(networkCalls, 0)
  console.log('Disabled image generation: all legacy routes reject requests without contacting providers')
} finally {
  globalThis.fetch = originalFetch
  await Promise.allSettled(disposers.map(dispose => Promise.resolve().then(dispose)))
}
