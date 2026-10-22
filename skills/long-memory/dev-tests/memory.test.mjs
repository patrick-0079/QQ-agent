import {test} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MemoryStore, contextScope } from '../store.js'
import {setup,available,dispose,toolDefinitions} from '../index.js'

const privateA={kind:'private',chatId:'12345',chatKey:'private_12345'}
const privateB={kind:'private',chatId:'67890'}
const groupA={kind:'group',chatId:'11111'}
const groupB={kind:'group',chatId:'22222'}
const sample=(patch={})=>({category:'profile',key:'饮食/甜食',content:'喜欢甜食，尤其是巧克力蛋糕',evidence:'我最喜欢巧克力蛋糕',tags:['甜食','蛋糕'],...patch})
async function fixture(fn,options={}) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-agent-memory-'))
 const file=path.join(dir,'memory.sqlite')
 const store=new MemoryStore(file,options)
 try { await fn(store,file,dir) } finally {fs.rmSync(dir,{recursive:true,force:true})}
}
const save=(s,c=privateA,item=sample())=>s.run('save',c,{items:[item]})
const review=(s,c=privateA,args={})=>s.run('review',c,args)

test('SQLite persisted, reopened and engine included without network',()=>fixture(async(s,file)=>{
 const result=await save(s)
 assert.equal(result.items[0].outcome,'saved')
 assert.equal(fs.readFileSync(file).subarray(0,15).toString(),'SQLite format 3')
 assert.equal((await review(new MemoryStore(file))).memories[0].content,sample().content)
}))
test('private identities and groups cannot read each other',()=>fixture(async s=>{
 await save(s);await save(s,groupA,sample({content:'群内共享口味'}))
 assert.equal((await review(s,privateB)).memories.length,0)
 assert.equal((await review(s,groupB)).memories.length,0)
 assert.equal((await review(s,groupA)).memories.length,1)
 assert.equal((await review(s)).memories[0].content,sample().content)
}))
test('scope/path injection and inconsistent host context rejected',()=>fixture(async s=>{
 await assert.rejects(s.run('review',privateA,{scope:'private_67890'}),/scope/)
 await assert.rejects(s.run('review',privateA,{path:'x'}),/path/)
 for(const ctx of [{},{kind:'group',chatId:'12345',chatKey:'private_12345'},{kind:'private',chatId:'../../x'}]) await assert.rejects(s.run('review',ctx))
 assert.equal(contextScope({chatKey:'private_12345'}).scope,'private_12345')
}))
test('private save cannot impersonate another subject',()=>fixture(async s=>{
 await assert.rejects(save(s,privateA,sample({subject_qq:'67890'})),/私聊/)
 assert.equal((await review(s)).memories.length,0)
}))
test('group records can be filtered by subject without crossing scope',()=>fixture(async s=>{
 await save(s,groupA,sample({subject_qq:'12345'}))
 await save(s,groupA,sample({subject_qq:'67890'}))
 assert.equal((await review(s,groupA,{subject_qq:'12345'})).memories.length,1)
}))
test('exact duplicate is idempotent even with a different key',()=>fixture(async s=>{
 const first=await save(s)
 const second=await save(s,privateA,sample({key:'重复主题'}))
 assert.equal(second.items[0].outcome,'duplicate')
 assert.equal(first.items[0].memory.id,second.items[0].memory.id)
 assert.equal((await review(s)).memories.length,1)
}))
test('same-key contradiction requires explicit update',()=>fixture(async s=>{
 await save(s)
 await assert.rejects(save(s,privateA,sample({content:'不喜欢甜食'})),/update/)
 assert.equal((await review(s)).memories[0].content,sample().content)
}))
test('batch validation and conflict leave no partial write',()=>fixture(async s=>{
 await assert.rejects(s.run('save',privateA,{items:[sample(),sample({content:'不喜欢甜食'})]}))
 assert.equal((await review(s)).memories.length,0)
 await assert.rejects(s.run('save',privateA,{items:[sample(),sample({key:'新',evidence:''})]}))
 assert.equal((await review(s)).memories.length,0)
}))
test('save accepts one or two, never three',()=>fixture(async s=>{
 await assert.rejects(s.run('save',privateA,{items:[sample(),sample(),sample()]}),/1～2/)
 await assert.rejects(s.run('save',privateA,{items:[]}),/1～2/)
 const r=await s.run('save',privateA,{items:[sample(),sample({key:'宠物',content:'养了一只猫'})]})
 assert.equal(r.items.length,2)
}))
test('optimistic revision protects newer facts',()=>fixture(async s=>{
 const m=(await save(s)).items[0].memory
 const r=await s.run('update',privateA,{id:m.id,revision:1,content:'现在不喜欢甜食',evidence:'现在不喜欢了'})
 assert.equal(r.memory.revision,2)
 await assert.rejects(s.run('update',privateA,{id:m.id,revision:1,content:'旧内容',evidence:'旧依据'}),/最新 revision/)
 assert.equal((await review(s)).memories[0].content,'现在不喜欢甜食')
}))
test('cannot update or delete another conversation memory',()=>fixture(async s=>{
 const m=(await save(s)).items[0].memory
 await assert.rejects(s.run('update',privateB,{id:m.id,revision:1,content:'越界',evidence:'越界'}))
 await assert.rejects(s.run('forget',groupA,{ids:[m.id]}))
 assert.equal((await review(s)).memories.length,1)
}))
test('forget removes content and evidence from active SQLite file',()=>fixture(async(s,file)=>{
 const unique='UNIQUE_SECRET_MEMORY_9f31c284'
 const m=(await save(s,privateA,sample({content:unique,evidence:unique}))).items[0].memory
 await s.run('forget',privateA,{ids:[m.id]})
 assert.equal((await review(s)).memories.length,0)
 assert.equal(fs.readFileSync(file).includes(Buffer.from(unique)),false)
 assert.equal((await s.run('search',privateA,{query:unique})).memories.length,0)
}))
test('forget batch is atomic if an ID is absent',()=>fixture(async s=>{
 const m=(await save(s)).items[0].memory
 await assert.rejects(s.run('forget',privateA,{ids:[m.id,'missing']}))
 assert.equal((await review(s)).memories.length,1)
}))
test('expired memories removed and inferred facts cannot be permanent',async()=>{
 let now=1700000000000
 await fixture(async s=>{
  await save(s,privateA,sample({certainty:'inferred',ttl_days:1}))
  now+=86400001
  assert.equal((await review(s)).memories.length,0)
  await assert.rejects(save(s,privateA,sample({certainty:'inferred',ttl_days:0})),/推测/)
 },{now:()=>now})
})
test('completed task visible in review but excluded from recall',()=>fixture(async s=>{
 const m=(await save(s,privateA,sample({category:'task',key:'项目',content:'完成记忆插件开发'}))).items[0].memory
 await s.run('update',privateA,{id:m.id,revision:1,content:m.content,evidence:'已经完成',status:'done'})
 assert.equal((await s.run('search',privateA,{query:'记忆插件'})).memories.length,0)
 assert.equal((await review(s)).memories[0].status,'done')
}))
test('Chinese keyword recall ranks relevant memories and returns empty when irrelevant',()=>fixture(async s=>{
 await save(s)
 await save(s,privateA,sample({key:'出行',content:'明天去北京坐火车',tags:['出行']}))
 const r=await s.run('search',privateA,{query:'你喜欢什么蛋糕'})
 assert.equal(r.memories[0].key,'饮食/甜食')
 assert.equal((await s.run('search',privateA,{query:'编程语言Rust'})).memories.length,0)
}))
test('search capped at five and results length bounded',()=>fixture(async s=>{
 for(let i=0;i<12;i++) await save(s,privateA,sample({key:`项目${i}`,content:`插件项目${i} ${'长'.repeat(420)}`,evidence:'依据'.repeat(180)}))
 const r=await s.run('search',privateA,{query:'插件项目'})
 assert.ok(r.memories.length<=5 && JSON.stringify(r.memories).length<6100)
 await assert.rejects(s.run('search',privateA,{query:'项目',limit:6}))
}))
test('review pagination has no duplicates',()=>fixture(async s=>{
 for(let i=0;i<3;i++) await save(s,privateA,sample({key:`事件${i}`,content:`事件正文${i}`}))
 const first=await review(s,privateA,{limit:2})
 const next=await review(s,privateA,{limit:2,offset:first.next_offset})
 assert.equal(new Set([...first.memories,...next.memories].map(r=>r.id)).size,3)
 assert.equal(next.next_offset,null)
}))
test('SQL injection text stays data',()=>fixture(async s=>{
 const content="'); DROP TABLE memories; --"
 await save(s,privateA,sample({content,key:content}))
 assert.equal((await review(s)).memories[0].content,content)
 assert.equal((await s.run('status',privateA)).count,1)
}))
test('concurrent in-process stores do not lose updates',()=>fixture(async(s,file)=>{
 await Promise.all(Array.from({length:12},(_,i)=>save(new MemoryStore(file),privateA,sample({key:`并发${i}`,content:`内容${i}`}))))
 assert.equal((await s.run('status',privateA)).count,12)
}))
test('external lock blocks access without overwriting database',()=>fixture(async(s,file)=>{
 await save(s)
 const before=fs.readFileSync(file)
 fs.writeFileSync(file+'.lock','another process')
 await assert.rejects(review(s),/锁/)
 assert.deepEqual(fs.readFileSync(file),before)
 fs.unlinkSync(file+'.lock')
}))
test('corrupt database is never silently recreated',()=>fixture(async(s,file)=>{
 const broken=Buffer.from('not sqlite, keep original')
 fs.writeFileSync(file,broken)
 await assert.rejects(review(s))
 assert.deepEqual(fs.readFileSync(file),broken)
 assert.equal(fs.existsSync(file+'.lock'),false)
}))
test('configured scope capacity rejects extra records',()=>fixture(async s=>{
 await save(s)
 await assert.rejects(save(s,privateA,sample({key:'另一个',content:'新的记录'})),/上限/)
 assert.equal((await review(s)).memories.length,1)
},{maxPerScope:1}))
test('loader tools, disabled switch, group gate and status integration',()=>fixture(async(s,file,dir)=>{
 let cfg={dataDir:dir,enabled:true,allowInGroup:false}
 const tools=new Map()
 setup({config:()=>cfg,registerTool:t=>tools.set(t.id,t)})
 assert.equal(available(),true)
 const manifest=JSON.parse(fs.readFileSync(new URL('../skill.json',import.meta.url)))
 assert.deepEqual(manifest.tools.map(t=>t.id),toolDefinitions.map(t=>t.id))
 assert.equal((await tools.get('status').execute({chatKey:'group_11111'},{})).isError,true)
 const result=await tools.get('save').execute(privateA,{items:[sample()]})
 assert.ok(!result.isError,result.content)
 assert.equal(JSON.parse((await tools.get('status').execute(privateA,{})).content).count,1)
 cfg.enabled=false
 assert.equal((await tools.get('search').execute(privateA,{query:'蛋糕'})).isError,true)
 dispose()
}))
test('update preserves optional fields and expiration unless explicitly changed',()=>fixture(async s=>{
 const m=(await save(s,privateA,sample({ttl_days:2,source_message_id:'message-1'}))).items[0].memory
 const r=await s.run('update',privateA,{id:m.id,revision:1,content:'喜欢黑巧克力蛋糕',evidence:'黑巧才是最喜欢的'})
 assert.equal(r.memory.expires_at,m.expires_at)
 assert.deepEqual(r.memory.tags,m.tags)
 assert.equal(r.memory.source_message_id,'message-1')
}))
test('failed disk replacement leaves previous data and no temporary file',()=>fixture(async(s,file,dir)=>{
 await save(s)
 const original=fs.readFileSync(file)
 const rename=fs.renameSync
 fs.renameSync=()=>{throw new Error('simulated disk failure')}
 try {await assert.rejects(save(s,privateA,sample({key:'新',content:'不要保存这一条'})),/disk failure/)}
 finally {fs.renameSync=rename}
 assert.deepEqual(fs.readFileSync(file),original)
 assert.deepEqual(fs.readdirSync(dir),['memory.sqlite'])
 assert.equal((await review(s)).memories.length,1)
}))
test('equivalent context formats access the same existing database scope',()=>fixture(async s=>{
 await save(s)
 for(const ctx of [
  {kind:'private',chatId:12345,chatKey:'private:12345'}, {chatKey:'private:12345'},
  {kind:'private',chatId:'private:12345'}, {kind:'private',chatId:'12345',chatKey:'private/12345'},
  {kind:'private',chatId:'12345',chatKey:'private-12345'},
  {kind:' private ',chatId:' 12345 ',chatKey:' PRIVATE:12345 '},
  {kind:'private',chatId:12345,chatKey:'opaque-host-session-1'}
 ]) assert.equal((await review(s,ctx)).memories[0].content,sample().content)
}))
test('genuine identity conflicts remain rejected after normalization',()=>fixture(async s=>{
 for(const ctx of [
  {kind:'group',chatId:12345,chatKey:'private:12345'},
  {kind:'private',chatId:12345,chatKey:'private:67890'},
  {kind:'private',chatId:'group:12345'}, {chatKey:'opaque-session-only'},
  {kind:'private',chatId:12345,chatKey:'private:invalid'},
  {kind:'private',chatId:12345,chatKey:{value:'x'}}
 ]) await assert.rejects(review(s,ctx))
}))
test('colon-only group identity cannot bypass group gate',()=>fixture(async(s,file,dir)=>{
 const tools=new Map()
 setup({config:()=>({dataDir:dir,enabled:true,allowInGroup:false}),registerTool:t=>tools.set(t.id,t)})
 const r=await tools.get('save').execute({chatKey:'group:11111'},{items:[sample()]})
 assert.equal(r.isError,true)
 assert.equal(r.content,'未开启群聊记忆')
 dispose()
}))
test('conflict diagnostics disclose shapes, not actual account IDs',()=>fixture(async s=>{
 try {await review(s,{kind:'private',chatId:12345,chatKey:'private:67890'});assert.fail('expected rejection')}
 catch(e){assert.match(e.message,/字段格式/);assert.ok(!e.message.includes('12345'));assert.ok(!e.message.includes('67890'))}
}))
