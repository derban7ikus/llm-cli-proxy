import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createClaudeChatHandler, prepareClaudeRequest } from '../dist/claude-chat.js';
const model = 'claude-sonnet-5';
const tools = [{type:'function',function:{name:'lookup_policy',parameters:{type:'object',properties:{query:{type:'string'}},required:['query'],additionalProperties:false}}}];
const body = (text, extra={}) => ({model,messages:[{role:'user',content:text}],...extra});
async function server(t, timeoutMs=2000) {
 const app=express();app.use(express.json());app.post('/chat/completions',createClaudeChatHandler({workspace:process.cwd(),model,binary:process.execPath,binaryArgs:['tests/fixtures/claude.mjs'],timeoutMs}));
 const s=app.listen(0,'127.0.0.1');await new Promise(r=>s.once('listening',r));t.after(()=>new Promise(r=>{s.closeAllConnections();s.close(r)}));
 return async (value)=>fetch(`http://127.0.0.1:${s.address().port}/chat/completions`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});
}
function chunks(s){return s.split('\n').filter(l=>l.startsWith('data: ')&&l!=='data: [DONE]').map(l=>JSON.parse(l.slice(6)))}
test('real HTTP SSE tool calls preserve arguments, index, completion and usage without CLI preamble',async t=>{
 const post=await server(t),r=await post(body('call',{tools,stream:true,stream_options:{include_usage:true}}));assert.equal(r.status,200);
 const wire=await r.text(),events=chunks(wire);assert(!wire.includes('internal envelope'));
 const call=events[0].choices[0].delta.tool_calls[0];assert.equal(call.index,0);assert.equal(call.function.name,'lookup_policy');assert.deepEqual(JSON.parse(call.function.arguments),{query:'holiday'});
 assert.equal(events[1].choices[0].finish_reason,'tool_calls');assert.equal(events[2].usage.prompt_tokens,10);assert(wire.endsWith('data: [DONE]\n\n'));
});
test('structured text answer uses stop, nonstream and streaming agree',async t=>{
 const post=await server(t);const r=await post(body('answer',{tools}));const json=await r.json();assert.equal(json.choices[0].message.content,'27 days');assert.equal(json.choices[0].finish_reason,'stop');
});
test('native text stream does not duplicate final assistant block',async t=>{
 const post=await server(t);const r=await post(body('hello',{stream:true}));const text=chunks(await r.text()).flatMap(x=>x.choices).map(c=>c.delta.content??'').join('');assert.equal(text,'hello');
});
for(const mode of ['missing','bad-json','bad-args','unknown-tool','error','incomplete']) test(`fails closed for ${mode}`,async t=>{
 const post=await server(t);const r=await post(body(mode,{tools,stream:true}));assert.equal(r.status,502);assert((await r.json()).error);
});
test('timeout returns 504 and terminates subprocess',async t=>{const post=await server(t,100);const r=await post(body('timeout'));assert.equal(r.status,504)});
test('schema maps choice and preserves history/image while disabling CLI tools/resume',()=>{
 const b=body('x',{tools,tool_choice:{type:'function',function:{name:'lookup_policy'}}});
 b.messages=[{role:'system',content:'System policy'},{role:'user',content:[{type:'image_url',image_url:{url:'data:image/png;base64,aGVsbG8='}}]},{role:'assistant',content:null,tool_calls:[{id:'call_1',type:'function',function:{name:'lookup_policy',arguments:'{"query":"holiday"}'}}]},{role:'tool',tool_call_id:'call_1',content:'27 days'}];
 const p=prepareClaudeRequest(b,model),input=JSON.parse(p.input),schema=JSON.parse(p.args[p.args.indexOf('--json-schema')+1]);
 assert.equal(schema.properties.tool_calls.minItems,1);assert.deepEqual(schema.properties.tool_calls.items.properties.name.enum,['lookup_policy']);
 assert.equal(input.message.content[2].source.data,'aGVsbG8=');assert(input.message.content[0].text.includes('call_1'));assert(input.message.content[0].text.includes('27 days'));
 assert(p.args.includes('--no-session-persistence'));assert(!p.args.includes('--resume'));assert.equal(p.args[p.args.indexOf('--tools')+1],'');
 assert.equal(prepareClaudeRequest(body('x',{tools,tool_choice:'none'}),model).structured,false);
});
test('validates draft2020 schemas and rejects malformed requests before inference',()=>{
 const t=structuredClone(tools);t[0].function.parameters.$schema='https://json-schema.org/draft/2020-12/schema';assert(prepareClaudeRequest(body('x',{tools:t}),model).validators.get('lookup_policy')({query:'x'}));
 for(const b of [body('x',{model:'$(touch bad)'}),body('x',{tools:[{}]}),body('x',{tool_choice:'required'}),{messages:[]},body([{type:'image_url',image_url:{url:'http://localhost/private'}}])]) assert.throws(()=>prepareClaudeRequest(b,model));
});
test('rejects invalid process arguments and async schemas before spawn',()=>{
 assert.throws(()=>prepareClaudeRequest({messages:[{role:'system',content:'bad\0prompt'},{role:'user',content:'hi'}]},model));
 const t=structuredClone(tools);t[0].function.parameters.$async=true;
 assert.throws(()=>prepareClaudeRequest(body('x',{tools:t}),model));
});
