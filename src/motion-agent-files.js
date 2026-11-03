import {existsSync,mkdirSync,readFileSync,writeFileSync,renameSync,realpathSync,readdirSync,statSync,lstatSync} from 'node:fs'
import {join,dirname,resolve,relative,isAbsolute} from 'node:path'
import {createHash,randomUUID} from 'node:crypto'

export const agentHash=bytes=>createHash('sha256').update(bytes).digest('hex')
export function agentAtomicJson(file,value) {
  mkdirSync(dirname(file),{recursive:true})
  const temp=file+'.'+randomUUID()+'.tmp'
  writeFileSync(temp,JSON.stringify(value,null,2))
  // Windows scanners can briefly hold the replaced checkpoint open. Retain
  // atomic replacement and retry that transient sharing violation.
  for(let attempt=0;;attempt++){
    try{renameSync(temp,file);break}catch(error){
      if(attempt>=8||!['EPERM','EACCES','EBUSY'].includes(error.code))throw error
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20*(attempt+1))
    }
  }
}

export function createAgentFiles(directory) {
  mkdirSync(directory,{recursive:true})
  const root=realpathSync(directory)
  const inside=file=>{const rel=relative(root,file);if(isAbsolute(rel)||rel==='..'||/^\.\.[\\/]/.test(rel))throw new Error('文件超出当前制作工程');return rel}
  function path(name,{internal=false,write=false}={}) {
    if(typeof name!=='string'||name.length>500||name.includes('\0')||name.includes(':')||isAbsolute(name)||/^[a-z]:|^\\\\/i.test(name))throw new Error('请使用工程内相对路径')
    const file=resolve(root,name),rel=inside(file)
    const normalized=rel.replaceAll('\\','/').toLowerCase()
    if(!internal&&(normalized==='.agent'||normalized.startsWith('.agent/')))throw new Error('Agent 检查点由任务管理器维护')
    let ancestor=file
    while(!existsSync(ancestor)){const parent=dirname(ancestor);if(parent===ancestor)throw new Error('无效工程路径');ancestor=parent}
    inside(realpathSync(ancestor))
    if(write&&existsSync(file)&&!statSync(file).isFile())throw new Error('目标不是文件')
    return file
  }
  function entries() {
    const rows=[]
    function walk(dir){
      for(const entry of readdirSync(dir,{withFileTypes:true})){
        if(['.agent','node_modules','bundle'].includes(entry.name.toLowerCase()))continue
        const file=join(dir,entry.name),rel=relative(root,file).replaceAll('\\','/')
        if(entry.isSymbolicLink()||lstatSync(file).isSymbolicLink())continue
        if(entry.isDirectory())walk(file)
        else if(entry.isFile())rows.push({path:rel,bytes:statSync(file).size})
        if(rows.length>1500)throw new Error('工程文件数量超过1500')
      }
    }
    walk(root);return rows.sort((a,b)=>a.path.localeCompare(b.path))
  }
  function read(name,offset=0,limit=16000) {
    const file=path(name)
    if(statSync(file).size>2*1024*1024)throw new Error('文件过大，请使用图片或素材查看工具')
    const bytes=readFileSync(file),text=bytes.toString('utf8')
    offset=Number(offset);limit=Number(limit)
    if(!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>120000)throw new Error('读取范围无效')
    return {path:name,sha256:agentHash(bytes),length:text.length,offset,text:text.slice(offset,offset+limit),more:offset+limit<text.length}
  }
  function write(name,content,expectedSha256) {
    if(typeof content!=='string'||Buffer.byteLength(content)>400000)throw new Error('单文件写入最多400KB')
    const file=path(name,{write:true})
    if(existsSync(file)&&expectedSha256!==agentHash(readFileSync(file)))throw new Error('文件已存在或已变化，请先读取并传 expectedSha256')
    if(entries().reduce((n,row)=>n+row.bytes,0)+Buffer.byteLength(content)>32*1024*1024)throw new Error('工程文件总量超过32MB')
    mkdirSync(dirname(file),{recursive:true});writeFileSync(file,content)
    return {path:name,bytes:Buffer.byteLength(content),sha256:agentHash(content)}
  }
  function patch(name,oldText,newText) {
    if(typeof oldText!=='string'||!oldText||typeof newText!=='string')throw new Error('补丁需要非空 oldText 和 newText')
    const current=read(name,0,120000)
    if(current.more)throw new Error('大文件请分段读取后整体写入')
    const first=current.text.indexOf(oldText)
    if(first<0||current.text.indexOf(oldText,first+oldText.length)>=0)throw new Error('补丁必须准确且唯一匹配')
    return write(name,current.text.slice(0,first)+newText+current.text.slice(first+oldText.length),current.sha256)
  }
  function fingerprint() {
    return agentHash(JSON.stringify(entries().map(row=>{
      let bytes=readFileSync(path(row.path))
      if(row.path==='composition.json'){const value=JSON.parse(bytes.toString('utf8'));delete value.audio;if(value.production)delete value.production.audio;bytes=JSON.stringify(value)}
      return [row.path,agentHash(bytes)]
    })))
  }
  return {root,path,entries,read,write,patch,fingerprint}
}
