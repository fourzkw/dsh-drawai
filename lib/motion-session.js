/* 由 tools/build.mjs 生成 —— 请勿直接编辑；改 src/ 下的源文件。 */
export function motionSessionPrompt(job, input, scope) {
  return [input.settings.prompt, '', '[DrawAI 视频创作任务]',
    JSON.stringify({ path: scope.path, page: scope.page, nodeId: job.nodeId, taskId: job.id, settings: input.settings,
      references: input.refs.map((ref) => ({ id: ref.id, role: ref.role, labels: ref.nodes.map((node) => node.label).filter(Boolean) })) }),
    '这个任务将在消息接收后自动在后台执行。请向我说明正在制作的视频，使用 motion_task 查询状态；无需重复创建任务或不断轮询。',
    '分镜和成片完成时会收到 DrawAI 后台通知。之后我在本会话提出修改时，用 motion_task revise 关联此任务，保留未要求更改的内容。',
  ].join('\n')
}

export async function submitMotionSession({ controller, manager, scope, job, input }) {
  if (!controller?.prompt) throw new Error('当前 DSH 没有主会话提交服务')
  if (job.session?.accepted) return manager.accepted(scope, job.id)
  try {
    const receipt = await controller.prompt({ requestId: job.session.requestId, sessionId: scope.sessionId, mode: 'queue',
      content: [{ type: 'text', text: motionSessionPrompt(job, input, scope) }] }, new AbortController().signal)
    if (!receipt?.accepted) throw new Error('主会话未接收视频请求')
    return manager.accepted(scope, job.id)
  } catch (error) { await manager.cancel(scope, job.id); throw error }
}

export function motionSessionNotice(job, event) {
  const association = { path: job.scope.path, page: job.scope.page, nodeId: job.nodeId, taskId: job.id,
    ...(job.packDir ? { projectPath: job.packDir + '/project' } : {}) }
  const storyboard = job.storyboard || job.composition
  if (event === 'storyboard') return '[DrawAI 后台分镜通知]\n' + JSON.stringify({ ...association, production: storyboard.production,
    shots: storyboard.shots.map(({ id, startFrame, durationFrames, description, cardId }) => ({ id, startFrame, durationFrames, description, cardId })) })
    + '\n请向用户简要展示分镜方案。后台正在继续渲染，无需重新生成或反复轮询。'
  return '[DrawAI 后台结果通知]\n' + JSON.stringify({ ...association, status: job.status, error: job.error || '',
    clip: job.output?.data.mediaClip, output: job.output ? job.packDir + '/source.mp4' : undefined, qa: job.output?.qa?.visualReview })
    + '\n请据实际状态说明结果。done 表示已经回填；retained 表示成片保留但未回填，不要声称已更新画布。可以使用 motion_task 查询详情、取消、回填或继续修改。'
}
