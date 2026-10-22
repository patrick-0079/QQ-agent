import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MemoryStore, contextScope } from './store.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
let config = () => ({})
let lastStatus = '尚未访问数据库'
const string = description => ({ type:'string', description })
const memoryFields = {
  content:string('简短、独立可理解的记忆，最多500字；不保存整段聊天'),
  evidence:string('支持这条记忆的简短原话或具体依据，最多500字；不要伪造'),
  source_message_id:string('可选，实际看到的消息ID；插件仅记录引用，不验证该消息'),
  certainty:{type:'string',enum:['stated','inferred'],description:'stated=对方明确表达；inferred=推测（不得作为事实，默认7天过期）'},
  tags:{type:'array',maxItems:6,items:{type:'string'},description:'关键词，最多6个，每个最多24字'},
  ttl_days:{type:'integer',minimum:0,maximum:3650,description:'有效天数；0为长期。默认档案长期、事件180天、待办90天、摘要30天、推测7天；推测不能长期'},
  status:{type:'string',enum:['active','done'],description:'默认 active，仅 task 可设 done；done 不进入普通检索'}
}
const category = {type:'string',enum:['profile','event','task','summary'],description:'记忆分类：profile=长期档案，event=事件，task=待办，summary=摘要'}
const subject = string('群聊可按真实QQ号筛选/归档，公共事项用 shared；私聊只允许当前聊天对象。不要猜QQ号')
const params = (properties, required=[]) => ({ type:'object', properties, ...(required.length ? { required } : {}), additionalProperties:false })
export const toolDefinitions = [
  {id:'save',name:'保存长期记忆',description:'由模型精选1～2条值得保留的记忆；精确去重。同主题矛盾会要求 update。仅写当前会话。',parameters:params({items:{type:'array',minItems:1,maxItems:2,description:'要保存的记忆条目，1～2 条',items:params({subject_qq:subject,category,key:string('稳定的主题键，如 饮食偏好/甜食，更新时保持同一主题'),...memoryFields},['category','key','content','evidence'])}},['items'])},
  {id:'search',name:'检索相关记忆',description:'按当前话题查当前会话的相关记忆，最多5条、约6000字符；中文关键词/二字组合检索，不是向量语义检索。',parameters:params({query:string('具体人物、事件或偏好关键词；支持中文'),subject_qq:subject,category,limit:{type:'integer',minimum:1,maximum:5,description:'最多返回几条，默认 5'}},['query'])},
  {id:'update',name:'更新长期记忆',description:'使用检索返回的 id 和 revision 更新旧事实或待办；正文和依据必填。省略标签/状态/来源时保留原值；省略有效期且确定性未变则保留原过期时间。',parameters:params({id:string('当前会话记忆ID'),revision:{type:'integer',minimum:1,description:'检索结果里的 revision，用于并发校验'},...memoryFields},['id','revision','content','evidence'])},
  {id:'forget',name:'遗忘指定记忆',description:'仅在用户要求忘记/删除或明确同意整理时使用。先检索定位，再物理删除当前会话的指定ID；无批量清空口。',parameters:params({ids:{type:'array',minItems:1,maxItems:20,description:'要删除的记忆 ID 列表',items:{type:'string'}}},['ids'])},
  {id:'review',name:'查看记忆档案',description:'用户询问你记得什么或要整理记忆时使用，分页展示当前会话有效记忆（含已完成待办）。不要每轮读取全库。',parameters:params({subject_qq:subject,category,offset:{type:'integer',minimum:0,description:'从第几条开始，默认 0'},limit:{type:'integer',minimum:1,maximum:20,description:'每页条数，默认 20'}})},
  {id:'status',name:'检查记忆库',description:'检查数据库是否可用、当前会话记忆数量和隔离范围，不读取其他会话。',parameters:params({})}
]

function databaseFile() {
  const explicit = String(config().dataDir || process.env.QQ_AGENT_DATA_DIR || '').trim()
  if (explicit) {
    if (!path.isAbsolute(explicit)) throw new Error('dataDir/QQ_AGENT_DATA_DIR 必须是绝对路径')
    return path.join(explicit,'long-memory','memory.sqlite')
  }
  let dir = path.resolve(HERE,'..','..')
  for (let i=0;i<6;i++) {
    if (fs.existsSync(path.join(dir,'src','skills.js'))) return path.join(dir,'data','long-memory','memory.sqlite')
    const parent=path.dirname(dir)
    if(parent===dir) break
    dir=parent
  }
  // Same conventional skills/<id> layout used by the supplied qqzone skill.
  if (path.basename(path.dirname(HERE)) === 'skills') return path.resolve(HERE,'..','..','data','long-memory','memory.sqlite')
  throw new Error('无法识别QQ Agent的数据目录，请在技能设置填写 dataDir（绝对路径）')
}

export function available() { return true }
export function diagnose() { return `长期记忆 v1.0.1；SQLite引擎内置；${lastStatus}；无自动宿主钩子，由模型调用检索工具。` }
export function dispose() { config=()=>({}); lastStatus='已卸载（数据已按操作落盘）' }
export function setup(api) {
  config=()=>typeof api.config==='function' ? api.config() || {} : {}
  for (const definition of toolDefinitions) {
    api.registerTool({...definition,category:'memory',async execute(ctx,args) {
      try {
        if (config().enabled===false) return {content:'长期记忆技能已关闭',isError:true}
        const identity = contextScope(ctx)
        if (config().allowInGroup===false && identity.kind==='group') return {content:'未开启群聊记忆',isError:true}
        const max = Number(config().maxPerScope)
        const store=new MemoryStore(databaseFile(),{maxPerScope:Number.isInteger(max)?Math.max(10,Math.min(10000,max)):2000})
        const result=await store.run(definition.id,ctx,args || {})
        lastStatus='数据库读写正常'
        return {content:JSON.stringify(result,null,2)}
      } catch(e) {
        lastStatus='上次操作未完成，请查看工具错误'
        const message=String(e?.message||e)
        const technical=/ENOENT|EACCES|EPERM|WebAssembly|Cannot find module|not a database|malformed|database disk image/i.test(message)
        return {content:technical?'数据库或内置引擎无法打开。确认 vendor 文件完整、数据目录可写；若数据库损坏请先保留原文件，勿清空重建。':message.slice(0,400),isError:true}
      }
    }})
  }
}
