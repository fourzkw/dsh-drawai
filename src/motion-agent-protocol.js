import { randomUUID } from 'node:crypto'

// DSH's stream contract: block-start/delta/block-end + finish.replayState.
// Keep opaque provider replay data and reasoning blocks for the next turn.
export function agentMessage(role, content, extra = {}) {
  return {id:randomUUID(),role,content,...extra}
}

export async function streamAgentTurn(options, messages, tools, system) {
  const blocks=new Map(),order=[]
  let finish,replay,bytes=0
  const ensure=(index,type)=>{
    if(!blocks.has(index)){blocks.set(index,{type,text:'',arguments:'',id:'',name:''});order.push(index)}
    return blocks.get(index)
  }
  if(options.signal?.aborted)throw new Error('已取消制作 Agent')
  for await(const chunk of options.llm.stream({provider:options.config.provider,model:options.config.model,
    ...(options.config.reasoningEffort?{reasoningEffort:options.config.reasoningEffort}:{}),
    sessionId:options.sessionId,system,messages,tools,signal:options.signal})){
    if(options.signal?.aborted)throw new Error('已取消制作 Agent')
    bytes+=JSON.stringify(chunk).length
    if(bytes>2000000)throw new Error('制作 Agent 单轮响应过大')
    const index=chunk.index??0
    if(chunk.type==='block-start')ensure(index,chunk.blockType)
    else if(chunk.type==='text-delta'||chunk.type==='reasoning-delta'){
      const block=ensure(index,chunk.type==='text-delta'?'text':'reasoning')
      if(!block.complete)block.text+=chunk.text||''
    }else if(chunk.type==='tool-call-delta'){
      const block=ensure(index,'tool-call')
      if(!block.complete){if(chunk.id)block.id=chunk.id;if(chunk.name)block.name=chunk.name;block.arguments+=chunk.argumentsDelta||''}
    }else if(chunk.type==='block-end')ensure(index,chunk.block.type).complete=chunk.block
    else if(chunk.type==='finish'){finish=chunk.reason;replay=chunk.replayState}
  }
  if(!finish||['max-tokens','error','aborted'].includes(finish.kind)){
    const error=new Error('制作 Agent 模型调用未完成：'+(finish?.failure?.message||finish?.kind||'missing-finish'))
    error.code='MOTION_AGENT_INCOMPLETE'
    // Incomplete tool calls are never executed or added to committed history.
    throw error
  }
  const content=order.map(index=>{
    const block=blocks.get(index)
    return block.complete||(block.type==='tool-call'?{type:'tool-call',id:block.id||randomUUID(),name:block.name,arguments:block.arguments}:{type:block.type,text:block.text})
  })
  const ids=new Set()
  for(const block of content.filter(block=>block.type==='tool-call')){
    if(!block.id||ids.has(block.id)||typeof block.name!=='string'||typeof block.arguments!=='string')throw new Error('制作 Agent 工具调用格式无效')
    ids.add(block.id)
  }
  return agentMessage('assistant',content,{source:{kind:'model',provider:options.config.provider,model:options.config.model,...(replay!==undefined?{replayState:replay}: {})}})
}

export function agentToolResult(call, value, isError=false) {
  return agentMessage('tool',[{type:'text',text:JSON.stringify(value)}],{toolCallId:call.id,isError,source:{kind:'tool',callId:call.id}})
}

// Trim only at assistant-turn boundaries, retaining complete tool-call/result
// groups. All original turns remain in the checkpoint on disk.
export function agentRequestHistory(state) {
  const messages=state.messages
  if(JSON.stringify(messages).length<320000)return messages
  const starts=messages.map((message,i)=>message.role==='assistant'?i:-1).filter(i=>i>0)
  let start=starts.at(-8)??1
  while(JSON.stringify(messages.slice(start)).length>280000&&starts.some(i=>i>start))start=starts.find(i=>i>start)
  return [messages[0],agentMessage('user',[{type:'text',text:'旧工具输出已从本轮上下文缩略；完整历史保存在 .agent/state.json。以实际工程文件为准，需要时重新读文件。最近操作：'+JSON.stringify(state.events.slice(-20))}]),...messages.slice(start)]
}
