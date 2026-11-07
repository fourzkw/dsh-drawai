import { loadVideoModule } from './motion/video-runtime.js'
import {existsSync,mkdirSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {randomUUID,createHash} from 'node:crypto'

export async function captureMotionPage(args,{directory,signal,browserExecutable}={}){
  const url=new URL(args.url)
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error('页面地址必须是无凭据的 HTTP(S) URL')
  const width=Number(args.width??1920),height=Number(args.height??1080),scale=Number(args.scale??2)
  if(!Number.isInteger(width)||width<320||width>2560||!Number.isInteger(height)||height<240||height>1440||![1,2].includes(scale))throw new Error('采集尺寸无效')
  if(!Array.isArray(args.elements??[])||(args.elements||[]).length>20||!Array.isArray(args.steps??[])||(args.steps||[]).length>16)throw new Error('单页最多20个切片、16个操作')
  const executable=[browserExecutable,process.env.DRAWAI_CHROME_PATH,'C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(p=>p&&existsSync(p))
  signal?.throwIfAborted()
  const { openBrowser } = await loadVideoModule('@remotion/renderer', {signal})
  const browser=await openBrowser('chrome',{browserExecutable:executable,logLevel:'error'})
  const abort=()=>{void browser.close({silent:true}).catch(()=>{})};signal?.addEventListener('abort',abort,{once:true})
  try{
    signal?.throwIfAborted()
    const page=await browser.newPage({context:()=>null,logLevel:'error',indent:false,pageIndex:0,onBrowserLog:null,onLog:()=>{}})
    await page.setViewport({width,height,deviceScaleFactor:scale})
    await page.goto({url:url.href,timeout:30000})
    for(const step of args.steps||[]){
      signal?.throwIfAborted()
      await page.evaluate(step=>{
        if(step.action==='scroll'){window.scrollTo(0,Math.max(0,Math.min(12000,Number(step.y)||0)));return}
        const el=document.querySelector(step.selector)
        if(!el)throw Error('页面操作选择器不存在：'+step.selector)
        if(step.action==='click'){
          const trigger=el.closest('button,input,a')||el
          if(trigger.form&&trigger.type==='submit'||trigger.closest('a')?.origin&&trigger.closest('a').origin!==location.origin)throw Error('不支持提交表单或跨站导航')
          el.click()
        }else if(step.action==='fill'){
          if(!['INPUT','TEXTAREA'].includes(el.tagName)||['password','file','hidden','submit'].includes(el.type))throw Error('只允许填入普通文本控件')
          const setter=Object.getOwnPropertyDescriptor(el.tagName==='INPUT'?HTMLInputElement.prototype:HTMLTextAreaElement.prototype,'value').set
          setter.call(el,String(step.value??'').slice(0,2000));el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}))
        }else throw Error('未知页面操作')
      },step)
      await page.evaluate(()=>new Promise(r=>setTimeout(r,250)))
    }
    const settle=Math.max(0,Math.min(5000,Number(args.waitMs)||600))
    await page.evaluate(async ms=>{await Promise.race([document.fonts.ready,new Promise(r=>setTimeout(r,5000))]);await new Promise(r=>setTimeout(r,ms))},settle)
    const info=await page.evaluate(()=>{
      const selector=el=>{
        const parts=[]
        while(el&&el.tagName!=='HTML'){
          if(el.id){parts.unshift('#'+CSS.escape(el.id));break}
          const tag=el.tagName.toLowerCase(),siblings=[...el.parentElement.children].filter(e=>e.tagName===el.tagName)
          parts.unshift(tag+(siblings.length>1?':nth-of-type('+(siblings.indexOf(el)+1)+')':''));el=el.parentElement
        }
        return parts.join(' > ')
      }
      return {url:location.href,title:document.title,pageH:Math.max(document.documentElement.scrollHeight,innerHeight),pageW:Math.max(document.documentElement.scrollWidth,innerWidth),
        bodyText:(document.body?.innerText||'').replace(/\s+/g,' ').trim().slice(0,400),
        elements:[...document.querySelectorAll('main,header,nav,h1,h2,h3,article,button,input,[data-testid]')].slice(0,100).map(el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return {selector:selector(el),text:(el.innerText||el.getAttribute('aria-label')||'').slice(0,160),x:r.x+scrollX,y:r.y+scrollY,w:r.width,h:r.height,font:s.fontFamily,fontSize:s.fontSize,color:s.color,background:s.backgroundColor,radius:s.borderRadius}})}
    })
    if(!['http:','https:'].includes(new URL(info.url).protocol))throw Error('页面跳转至不支持的协议')
    if(info.pageH>12000||info.pageW>2560)throw Error('页面超出采集范围，请缩小页面或按区域采集')
    // 认证失败页 / 错误页 / 空白页不该被静默截下来当成界面：静默失败的截图会比没截更误导。
    const bodyText=String(info.bodyText||'')
    const authLike=/authentication required|unauthorized|403 forbidden|404 not found|page not found/i.test(bodyText+' '+info.title)
      ||(bodyText.length<200&&/(?:^|\s)(?:sign in|log in)(?:\s|$)|登录|请先登录/i.test(bodyText))
    if(authLike)throw Error('页面看起来是登录/错误页，不是要采集的界面（标题“'+info.title+'”，页面文字“'+bodyText.slice(0,120)+'”）。换带 token 的地址（dsh web 启动时打印的那条），或改用本地 HTML 模板再截')
    if(bodyText.length<12&&info.elements.length<3)throw Error('页面几乎是空白（标题“'+info.title+'”，可见文字 '+bodyText.length+' 字）：可能还没渲染完，先用 steps/waitMs 等到内容出现，或改用本地 HTML 模板')
    const id='capture-'+randomUUID(),files=[];mkdirSync(directory,{recursive:true})
    let bytes=0
    const screenshot=async(name,clip,extra={})=>{
      signal?.throwIfAborted()
      const result=await page._client().send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true,clip:{...clip,scale:1}})
      const data=Buffer.from((result.value||result).data,'base64');bytes+=data.length
      if(data.length>16*1024*1024||bytes>48*1024*1024)throw Error('页面采集图片超过大小限制')
      const filename=id+'-'+name+'.png';writeFileSync(join(directory,filename),data)
      files.push({filename,sha256:createHash('sha256').update(data).digest('hex'),...clip,...extra})
    }
    await screenshot('page',{x:0,y:0,width:info.pageW,height:info.pageH},{kind:'page'})
    for(const [index,item]of (args.elements||[]).entries()){
      if(typeof item.selector!=='string'||item.selector.length>500)throw Error('切片选择器无效')
      const box=await page.evaluate(selector=>{const el=document.querySelector(selector);if(!el)throw Error('切片选择器不存在：'+selector);const r=el.getBoundingClientRect();return {x:r.x+scrollX,y:r.y+scrollY,width:r.width,height:r.height}},item.selector)
      if(box.width<1||box.height<1||box.x<0||box.y<0)throw Error('切片元素不可见')
      if(item.transparent)await page._client().send('Emulation.setDefaultBackgroundColorOverride',{color:{r:0,g:0,b:0,a:0}})
      try{await screenshot('element-'+index,box,{kind:'element',selector:item.selector,label:String(item.label||'').slice(0,160)})}
      finally{await page._client().send('Emulation.setDefaultBackgroundColorOverride',{})}
    }
    if(args.hideForBackplate){
      if(typeof args.hideForBackplate!=='string'||args.hideForBackplate.length>500)throw Error('底板选择器无效')
      await page.evaluate(selector=>{for(const el of document.querySelectorAll(selector))el.style.visibility='hidden'},args.hideForBackplate)
      await screenshot('backplate',{x:0,y:0,width:info.pageW,height:info.pageH},{kind:'backplate'})
    }
    const result={id,...info,viewport:{width,height,scale},files,steps:args.steps||[],capturedAt:new Date().toISOString()}
    writeFileSync(join(directory,id+'-layout.json'),JSON.stringify(result,null,2))
    return result
  }finally{signal?.removeEventListener('abort',abort);await browser.close({silent:true}).catch(()=>{})}
}
