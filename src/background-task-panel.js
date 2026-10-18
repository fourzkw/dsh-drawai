// Browser-only task presentation. Execution and persistence belong to the host.
function BackgroundTaskPanel(props) {
  const [collapsed, setCollapsed] = React.useState(false)
  const [filter, setFilter] = React.useState('active')
  const [busy, setBusy] = React.useState('')
  const [error, setError] = React.useState('')
  const jobs = props.jobs.concat(props.exports.map((job) => ({ ...job, id: job.token, export: true, label: job.clip + ' · ' + job.format.toUpperCase() })))
  const attention = (job) => ['failed', 'error', 'interrupted'].includes(job.status) || job.delivery === 'conflict'
  const ended = (job) => ['succeeded', 'done', 'cancelled', 'failed', 'error'].includes(job.status)
  const live = jobs.filter((job) => !ended(job)).length, needs = jobs.filter(attention).length
  const visible = jobs.filter((job) => filter === 'all' || (filter === 'active' ? !ended(job) || attention(job) : filter === 'attention' ? attention(job) : ended(job) && !attention(job)))
  const labels = { queued: '等待中', running: '绘制中', paused: '已暂停', cancelling: '正在取消', interrupted: '等待恢复', failed: '绘制失败', cancelled: '已取消', succeeded: '已完成', rendering: '渲染中', encoding: '编码中', done: '已保存文件', error: '导出失败' }
  const phases = { preparing: '检查素材', probing: '探测视频', decoding: '解码抽帧', tracing: '绘制色块' }
  const invoke = async (job, action, value) => {
    setBusy(job.id || 'queue'); setError('')
    try { await props.onCommand(job, action, value) }
    catch (err) { setError(String(err.message || err)) }
    finally { setBusy('') }
  }
  const button = (text, action, disabled = false) => React.createElement('button', { key: text, type: 'button', className: 'drawai-trace-pin', disabled: !!busy || disabled, onClick: action }, text)
  if (props.hidden) return null
  return React.createElement('section', { className: 'drawai-video-task-card drawai-background-tasks', role: 'region', 'aria-label': '后台任务队列',
    style: { width: 'min(380px, calc(100% - 24px))', maxHeight: '60%', overflow: 'auto', left: 12, right: 'auto' },
    onPointerDown: (event) => event.stopPropagation(), onDoubleClick: (event) => event.stopPropagation(), onKeyDown: (event) => event.stopPropagation(),
  }, React.createElement('div', { className: 'drawai-trace-card-heading' },
    React.createElement('strong', null, '后台任务 · ' + live + ' 项进行中' + (needs ? ' · ' + needs + ' 项需处理' : '')),
    React.createElement('div', { className: 'drawai-trace-card-actions' },
      button(collapsed ? '展开' : '收起', () => setCollapsed(!collapsed)),
      React.createElement('button', { type: 'button', className: 'drawai-trace-pin', 'aria-label': '隐藏任务列表', onClick: props.onHide }, '隐藏'))),
  collapsed ? null : React.createElement('div', null,
    React.createElement('div', { className: 'drawai-trace-card-actions', style: { flexWrap: 'wrap' }, role: 'group', 'aria-label': '筛选任务' },
      [['active', '进行中'], ['attention', '需处理'], ['complete', '已结束'], ['all', '全部']].map(([key, label]) =>
        React.createElement('button', { key, type: 'button', className: 'drawai-trace-pin', 'aria-pressed': filter === key, style: { fontWeight: filter === key ? 700 : 400 }, onClick: () => setFilter(key) }, label)),
      props.jobs.length ? button(props.jobs.some((job) => job.queuePaused) ? '继续绘制队列' : '暂停后续绘制', () => invoke({}, 'pause-queue', !props.jobs.some((job) => job.queuePaused))) : null),
    React.createElement('small', null, '切换页面或关闭网页后继续；宿主重启后可恢复绘制。'),
    error || props.error ? React.createElement('div', { role: 'alert', className: 'drawai-err', style: { userSelect: 'text' } }, error || props.error) : null,
    !visible.length ? React.createElement('p', { className: 'drawai-note' }, jobs.length ? '此分类暂无任务，可切换到“全部”查看记录。' : '暂无后台任务') : null,
    visible.map((job) => {
      const running = ['running', 'rendering', 'encoding'].includes(job.status)
      const done = job.export ? job.status === 'rendering' ? job.received : job.encoded : job.done
      const total = job.export ? job.count : job.total
      const percent = total ? Math.min(100, Math.round((done || 0) / total * 100)) : 0
      const state = job.delivery === 'conflict' ? '产物已保存 · 等待加入画布' : job.delivery === 'undone' ? '生成节点已撤销' : job.delivery === 'applied' && job.status === 'succeeded' ? '已写入画布' : labels[job.status] || job.status
      const here = !job.export && job.scope.path === props.path && job.scope.page === props.page
      const queued = props.jobs.filter((item) => item.status === 'queued')
      return React.createElement('article', { key: job.id, className: 'drawai-video-task-detail', style: { borderTop: '1px solid #8883', paddingTop: 10, marginTop: 8, userSelect: 'text' } },
        React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 8 } },
          React.createElement('strong', { style: { overflowWrap: 'anywhere' } }, job.label), React.createElement('small', { role: 'status' }, state)),
        !job.export ? React.createElement('small', null, ({ image: '图片绘制', video: '视频绘制', extract: '视频抽帧' }[job.kind]) + ' · ' + String(job.scope.path).split(/[\\/]/).pop() + ' · ' + (job.scope.pageName || '第 ' + (job.scope.page + 1) + ' 页') + (job.kind !== 'extract' ? ' · ' + job.options.colors + ' 色' : '')) : null,
        running ? React.createElement('div', null,
          React.createElement('progress', { value: percent, max: 100, style: { width: '100%' }, 'aria-label': job.label + '进度' }),
          React.createElement('small', null, (phases[job.phase] || labels[job.status]) + (total > 1 ? ' · ' + (done || 0) + '/' + total + ' 帧 · ' + percent + '%' : '') + (job.startedAt ? ' · ' + Math.floor((Date.now() - job.startedAt) / 1000) + ' 秒' : ''))) : null,
        job.pauseRequested ? React.createElement('small', null, '正在等待完整帧保存后暂停…') : null,
        job.reducedFrames ? React.createElement('small', null, job.reducedFrames + ' 帧因 SVG 字符预算进行了细节简化') : null,
        job.path ? React.createElement('small', { style: { overflowWrap: 'anywhere' } }, '文件：' + job.path) : null,
        job.error ? React.createElement('div', { className: 'drawai-err', style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, job.error) : null,
        React.createElement('div', { className: 'drawai-trace-card-actions', style: { flexWrap: 'wrap' } },
          job.export ? [job.status === 'done' ? button('下载文件', () => invoke(job, 'download')) : null,
            ['error', 'interrupted'].includes(job.status) ? button('重新导出', () => invoke(job, 'retry-export')) : null,
            button(ended(job) || job.status === 'interrupted' ? '移除记录' : '取消导出', () => invoke(job, 'discard'))] : [
            job.status === 'queued' ? button('上移', () => invoke(job, 'move', -1), queued[0]?.id === job.id) : null,
            job.status === 'queued' ? button('下移', () => invoke(job, 'move', 1), queued.at(-1)?.id === job.id) : null,
            job.status === 'queued' || job.status === 'running' && job.kind === 'video' ? button('暂停', () => invoke(job, 'pause'), job.pauseRequested) : null,
            ['paused', 'interrupted'].includes(job.status) ? button('继续', () => invoke(job, 'resume')) : null,
            ['failed', 'cancelled'].includes(job.status) ? button('重试', () => invoke(job, 'retry')) : null,
            ['failed', 'cancelled', 'interrupted', 'paused'].includes(job.status) ? button('重新开始', () => invoke(job, 'restart')) : null,
            ['queued', 'running', 'paused', 'interrupted'].includes(job.status) ? button('取消', () => invoke(job, 'cancel')) : null,
            job.delivery === 'conflict' || job.delivery === 'undone' ? button('加入原画布', () => invoke(job, 'apply')) : null,
            job.delivery === 'applied' && job.kind !== 'extract' ? button('撤销生成', () => invoke(job, 'undo')) : null,
            job.nodeId && here ? button(job.kind === 'image' ? '查看 / 回放绘制' : '定位结果', () => invoke(job, 'locate')) : null,
            !here ? button('打开原页面', () => props.onOpen(job)) : null,
            ended(job) ? button('移除记录', () => invoke(job, 'remove')) : null,
          ],
          job.error ? button('复制错误', () => writeClipboardText(job.error).catch(() => {})) : null))
    })))
}
