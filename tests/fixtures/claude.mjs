let input = '';
for await (const chunk of process.stdin) input += chunk;
const prompt = JSON.parse(input).message.content[0].text;
const mode = JSON.parse(prompt.split('\n').slice(1).join('\n'))[0].content;
const emit = (value) => console.log(JSON.stringify(value));
if (mode === 'timeout') await new Promise(() => setInterval(() => {}, 1000));
else if (mode === 'incomplete') emit({type:'assistant', message:{content:[{type:'text',text:'partial'}]}});
else if (mode === 'error') emit({type:'result',subtype:'error_during_execution',is_error:true});
else if (process.argv.includes('--json-schema')) {
  const calls = mode === 'answer' ? [] : [{ name: mode === 'unknown-tool' ? 'unknown' : 'lookup_policy', arguments_json: mode === 'bad-json' ? '{' : JSON.stringify({query: mode === 'bad-args' ? 42 : 'holiday'}) }];
  // Internal CLI reasoning/text must not leak when using the envelope.
  emit({type:'assistant',message:{content:[{type:'text',text:'internal envelope preamble'}]}});
  emit({type:'result',subtype:'success',structured_output: mode === 'missing' ? undefined : {content: mode === 'answer' ? '27 days' : '',tool_calls:calls},usage:{input_tokens:3,output_tokens:5,cache_read_input_tokens:7}});
} else {
  emit({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'hello'}}});
  emit({type:'assistant',message:{content:[{type:'text',text:'hello'}]}});
  emit({type:'result',subtype:'success',usage:{input_tokens:3,output_tokens:5}});
}
