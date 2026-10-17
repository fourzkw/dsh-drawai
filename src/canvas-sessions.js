/** UI remounts do not own canvas tabs or the lifetime of a video drawing task. */
function createCanvasSessionStore(options = {}) {
  const workspaces = new Map()
  const tasks = new Map()
  const keyOf = (sessionId, path, page) => JSON.stringify([sessionId || '', path, page])
  function workspace(sessionId) {
    const key = sessionId || ''
    if (!workspaces.has(key)) workspaces.set(key, { tabs: [], activeKey: '', bootstrapped: false, pages: Object.create(null) })
    return workspaces.get(key)
  }
  function task(sessionId, path, page) {
    const key = keyOf(sessionId, path, page)
    if (!tasks.has(key)) tasks.set(key, {
      sessionId: sessionId || '', path, page, current: null, source: null, job: null, result: null, listeners: new Set(),
    })
    return tasks.get(key)
  }
  function update(task, values) {
    Object.assign(task, values)
    task.listeners.forEach((notify) => notify())
  }
  return {
    workspace, task, update,
    publish(task, result) {
      if (task.result || task.pendingSave) throw new Error('原画布尚有等待接收或保存的绘制结果')
      update(task, { result })
    },
    subscribe(task, notify) {
      task.listeners.add(notify)
      notify()
      return () => task.listeners.delete(notify)
    },
    /** Claim synchronously: two mounted views must never insert the result twice. */
    consume(task, apply) {
      if (!task.result || task.pendingSave) return false
      const result = task.result
      task.result = null
      try { apply(result) }
      catch (error) { task.result = result; throw error }
      if (result.taskId) {
        task.pendingSave = result
        options.onApplied?.(result.taskId)
      }
      update(task, {})
      return true
    },
    acknowledge(task, savedDoc) {
      const result = task.pendingSave
      if (!result || !savedDoc.nodes?.some((node) => node.data?.drawaiTaskId === result.taskId)) return
      task.pendingSave = null
      options.onSaved?.(result.taskId)
      update(task, {})
    },
    restore(task, persistedDoc) {
      const result = task.pendingSave
      if (!result) return
      if (persistedDoc.nodes?.some((node) => node.data?.drawaiTaskId === result.taskId)) {
        this.acknowledge(task, persistedDoc)
      } else {
        task.pendingSave = null
        options.onRestore?.(result.taskId)
        update(task, { result })
      }
    },
    close(sessionId, path) {
      options.onClose?.(sessionId, path)
      for (const [key, task] of tasks) {
        if (task.sessionId === (sessionId || '') && task.path === path) {
          task.current?.abort()
          tasks.delete(key)
        }
      }
      delete workspace(sessionId).pages[path]
    },
    dispose() {
      options.onDispose?.()
      tasks.forEach((task) => task.current?.abort())
      tasks.clear()
      workspaces.clear()
    },
  }
}

export { createCanvasSessionStore }
