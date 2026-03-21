#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';

function usage() {
  console.log(`Usage: node scripts/smoke-openai-provider.mjs [--plugin-dir <dir>] [--deps-dir <dir>] [--cwd <dir>] [--prompt <text>] [--scenario <name>]

Runs the OpenAI provider locally against a mock Responses API server.
It validates the emitted tool schemas and prints the observed request flow.

Defaults:
  --plugin-dir  ./plugins/openai
  --deps-dir    ~/.commands-agent/providers/openai/node_modules
  --cwd         current working directory
  --prompt      "review the current workspace"
  --scenario    basic

Scenarios:
  basic             Validate the initial request envelope and return a final message
  tool-call         Return a read-only function call, then verify the provider continues the turn
  multi-read        Return two read-only function calls in one response and verify both outputs come back together
  review-tools      Walk a git-native review flow through changed files and paged diff reads
  write-escalation  Return request_write_access, then verify the provider reruns with full tools
`);
}

let pluginDir = path.resolve('plugins/openai');
let depsDir = path.join(os.homedir(), '.commands-agent', 'providers', 'openai', 'node_modules');
let cwd = process.cwd();
let prompt = 'review the current workspace';
let scenario = 'basic';

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === '--plugin-dir') {
    pluginDir = path.resolve(args[++i]);
  } else if (arg === '--deps-dir') {
    depsDir = path.resolve(args[++i]);
  } else if (arg === '--cwd') {
    cwd = path.resolve(args[++i]);
  } else if (arg === '--prompt') {
    prompt = args[++i];
  } else if (arg === '--scenario') {
    scenario = args[++i];
  } else if (arg === '-h' || arg === '--help') {
    usage();
    process.exit(0);
  } else {
    console.error(`Unknown argument: ${arg}`);
    usage();
    process.exit(1);
  }
}

const SUPPORTED_SCENARIOS = new Set(['basic', 'tool-call', 'multi-read', 'review-tools', 'write-escalation']);
if (!SUPPORTED_SCENARIOS.has(scenario)) {
  console.error(`Unsupported scenario: ${scenario}`);
  usage();
  process.exit(1);
}

if (!fs.existsSync(pluginDir)) {
  console.error(`Plugin directory not found: ${pluginDir}`);
  process.exit(1);
}
if (!fs.existsSync(depsDir)) {
  console.error(`Dependency directory not found: ${depsDir}`);
  process.exit(1);
}

function copyPluginTree(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.DS_Store') continue;
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyPluginTree(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function validateStrictToolSchemas(body) {
  const issues = [];
  for (const tool of body.tools || []) {
    if (tool.type !== 'function') continue;
    const params = tool.parameters || {};
    const properties = params.properties && typeof params.properties === 'object'
      ? Object.keys(params.properties)
      : [];
    const required = Array.isArray(params.required) ? params.required : [];
    for (const prop of properties) {
      if (!required.includes(prop)) {
        issues.push(`Tool "${tool.name}" is missing "${prop}" in parameters.required`);
      }
    }
    if (params.additionalProperties !== false) {
      issues.push(`Tool "${tool.name}" is missing additionalProperties=false`);
    }
  }
  return issues;
}

function makeCompletedResponse(body, output) {
  return {
    id: 'resp_test_123',
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    error: null,
    incomplete_details: null,
    instructions: body.instructions || '',
    max_output_tokens: null,
    model: body.model,
    output,
    parallel_tool_calls: body.parallel_tool_calls ?? false,
    reasoning: body.reasoning ?? {},
    text: body.text ?? { format: { type: 'text' } },
    tool_choice: 'auto',
    tools: body.tools ?? [],
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      total_tokens: 2,
    },
  };
}

function makeMessageItem(text) {
  return {
    id: 'msg_test_123',
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [
      {
        type: 'output_text',
        text,
        annotations: [],
      },
    ],
  };
}

function makeFunctionCallItem({ id, callId, name, args }) {
  return {
    id,
    type: 'function_call',
    call_id: callId,
    name,
    status: 'completed',
    arguments: JSON.stringify(args),
  };
}

function hasFunctionCallOutput(body, callId) {
  return Array.isArray(body.input) && body.input.some((item) => (
    item &&
    item.type === 'function_call_output' &&
    item.call_id === callId
  ));
}

function countFunctionCallOutputs(body) {
  if (!Array.isArray(body.input)) return 0;
  return body.input.filter((item) => item && item.type === 'function_call_output').length;
}

function getToolNames(body) {
  return (body.tools || []).map((tool) => tool.name);
}

const observed = [];
const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end('Method not allowed');
    return;
  }

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  const body = raw ? JSON.parse(raw) : {};
  observed.push({
    path: req.url,
    body,
  });

  if (req.url === '/responses/compact') {
    const response = {
      id: 'resp_compact_123',
      object: 'response',
      status: 'completed',
      model: body.model,
      output: [],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(response));
    return;
  }

  if (req.url !== '/responses') {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  const strictIssues = validateStrictToolSchemas(body);
  const responseCount = observed.filter((entry) => entry.path === '/responses').length;
  let completed;

  if (strictIssues.length > 0) {
    completed = makeCompletedResponse(body, [
      makeMessageItem(`schema issues: ${strictIssues.join('; ')}`),
    ]);
  } else if (scenario === 'basic') {
    completed = makeCompletedResponse(body, [
      makeMessageItem('smoke ok'),
    ]);
  } else if (scenario === 'tool-call') {
    if (responseCount === 1) {
      completed = makeCompletedResponse(body, [
        makeFunctionCallItem({
          id: 'fc_list_files_1',
          callId: 'call_list_files_1',
          name: 'list_files',
          args: {
            path: '.',
            depth: 1,
            offset: 0,
            limit: 10,
          },
        }),
      ]);
    } else if (hasFunctionCallOutput(body, 'call_list_files_1')) {
      completed = makeCompletedResponse(body, [
        makeMessageItem('tool-call ok'),
      ]);
    } else {
      completed = makeCompletedResponse(body, [
        makeMessageItem('tool-call scenario received an unexpected follow-up request'),
      ]);
    }
  } else if (scenario === 'multi-read') {
    if (responseCount === 1) {
      completed = makeCompletedResponse(body, [
        makeFunctionCallItem({
          id: 'fc_glob_1',
          callId: 'call_glob_1',
          name: 'glob',
          args: {
            path: '.',
            pattern: 'plugins/openai/*.mjs',
            offset: 0,
            limit: 10,
          },
        }),
        makeFunctionCallItem({
          id: 'fc_read_file_1',
          callId: 'call_read_file_1',
          name: 'read_file',
          args: {
            path: 'plugins/openai/index.mjs',
            start_line: 1,
            end_line: 40,
          },
        }),
      ]);
    } else if (
      hasFunctionCallOutput(body, 'call_glob_1') &&
      hasFunctionCallOutput(body, 'call_read_file_1')
    ) {
      completed = makeCompletedResponse(body, [
        makeMessageItem('multi-read ok'),
      ]);
    } else {
      completed = makeCompletedResponse(body, [
        makeMessageItem('multi-read scenario received an unexpected follow-up request'),
      ]);
    }
  } else if (scenario === 'review-tools') {
    if (responseCount === 1) {
      completed = makeCompletedResponse(body, [
        makeFunctionCallItem({
          id: 'fc_list_changed_files_1',
          callId: 'call_list_changed_files_1',
          name: 'list_changed_files',
          args: {
            scope: 'commit',
            target: 'HEAD',
            path: null,
            offset: 0,
            limit: 10,
          },
        }),
      ]);
    } else if (hasFunctionCallOutput(body, 'call_read_diff_1')) {
      completed = makeCompletedResponse(body, [
        makeMessageItem('review-tools ok'),
      ]);
    } else if (hasFunctionCallOutput(body, 'call_list_changed_files_1')) {
      completed = makeCompletedResponse(body, [
        makeFunctionCallItem({
          id: 'fc_read_diff_1',
          callId: 'call_read_diff_1',
          name: 'read_diff',
          args: {
            scope: 'commit',
            target: 'HEAD',
            path: 'plugins/openai/index.mjs',
            context_lines: 5,
            offset: 0,
            limit: 120,
          },
        }),
      ]);
    } else {
      completed = makeCompletedResponse(body, [
        makeMessageItem('review-tools scenario received an unexpected follow-up request'),
      ]);
    }
  } else if (scenario === 'write-escalation') {
    if (responseCount === 1) {
      completed = makeCompletedResponse(body, [
        makeFunctionCallItem({
          id: 'fc_request_write_1',
          callId: 'call_request_write_1',
          name: 'request_write_access',
          args: { reason: 'Need write-capable tools for this task' },
        }),
      ]);
    } else {
      completed = makeCompletedResponse(body, [
        makeMessageItem('write escalation ok'),
      ]);
    }
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  res.write(`data: ${JSON.stringify({ type: 'response.created', response: { id: completed.id, status: 'in_progress' } })}\n\n`);
  res.write(`data: ${JSON.stringify({ type: 'response.completed', response: completed })}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (!address || typeof address === 'string') {
  console.error('Failed to bind local server');
  process.exit(1);
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openai-provider-smoke-'));
const stagedPluginDir = path.join(tempRoot, 'openai');
copyPluginTree(pluginDir, stagedPluginDir);
fs.symlinkSync(depsDir, path.join(stagedPluginDir, 'node_modules'), 'dir');

const { default: provider } = await import(pathToFileURL(path.join(stagedPluginDir, 'index.mjs')).href);

let runResult;
let runError;
try {
  runResult = await provider.runPrompt({
    prompt,
    cwd,
    model: 'gpt-5.4',
    allowToolUse: true,
    providerConfig: {
      API_KEY: 'smoke-test-key',
      BASE_URL: `http://127.0.0.1:${address.port}`,
      READ_ONLY_FIRST: 'true',
      PARALLEL_TOOL_CALLS: 'true',
    },
    maxTurns: 5,
  });
} catch (error) {
  runError = error;
} finally {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

if (runError) {
  console.error('Provider run failed:');
  console.error(runError);
  process.exit(1);
}

const firstResponse = observed.find((entry) => entry.path === '/responses');
if (!firstResponse) {
  console.error('No /responses request was observed.');
  process.exit(1);
}

const schemaIssues = validateStrictToolSchemas(firstResponse.body);
const toolNames = (firstResponse.body.tools || []).map((tool) => tool.name).join(', ');

console.log(`Observed ${observed.length} request(s)`);
console.log(`Scenario: ${scenario}`);
console.log(`Tool names: ${toolNames}`);
console.log(`Parallel tool calls: ${String(firstResponse.body.parallel_tool_calls)}`);
console.log(`Reasoning effort: ${firstResponse.body.reasoning?.effort || '(missing)'}`);
console.log(`Prompt cache key: ${firstResponse.body.prompt_cache_key || '(missing)'}`);
console.log(`Provider result: ${runResult?.result || '(empty)'}`);

const responseRequests = observed.filter((entry) => entry.path === '/responses');
if (responseRequests.length > 1) {
  responseRequests.slice(1).forEach((entry, index) => {
    const toolList = getToolNames(entry.body).join(', ') || '(none)';
    const inputTypes = Array.isArray(entry.body.input)
      ? entry.body.input.map((item) => item?.type || '(unknown)').join(', ')
      : '(none)';
    const mode = typeof entry.body.instructions === 'string' && entry.body.instructions.includes('Do not attempt edits in this mode')
      ? 'read_only'
      : 'full_or_other';
    console.log(`Follow-up ${index + 1} tool names: ${toolList}`);
    console.log(`Follow-up ${index + 1} input types: ${inputTypes}`);
    console.log(`Follow-up ${index + 1} function_call_output count: ${countFunctionCallOutputs(entry.body)}`);
    console.log(`Follow-up ${index + 1} parallel tool calls: ${String(entry.body.parallel_tool_calls)}`);
    console.log(`Follow-up ${index + 1} prompt cache key: ${entry.body.prompt_cache_key || '(missing)'}`);
    console.log(`Follow-up ${index + 1} instructions mode: ${mode}`);
  });
}

if (schemaIssues.length > 0) {
  console.error('\nSchema validation failed:');
  for (const issue of schemaIssues) {
    console.error(`- ${issue}`);
  }
  process.exit(2);
}

if (!getToolNames(firstResponse.body).includes('glob')) {
  console.error('Expected the glob tool to be exposed in the first /responses request.');
  process.exit(12);
}
if (!getToolNames(firstResponse.body).includes('list_changed_files')) {
  console.error('Expected the list_changed_files tool to be exposed in the first /responses request.');
  process.exit(13);
}
if (!getToolNames(firstResponse.body).includes('read_diff')) {
  console.error('Expected the read_diff tool to be exposed in the first /responses request.');
  process.exit(14);
}
if (!getToolNames(firstResponse.body).includes('read_file_at_revision')) {
  console.error('Expected the read_file_at_revision tool to be exposed in the first /responses request.');
  process.exit(15);
}

if (scenario === 'tool-call') {
  if (responseRequests.length !== 2) {
    console.error(`Expected 2 /responses requests for tool-call scenario, saw ${responseRequests.length}.`);
    process.exit(3);
  }
  if (!hasFunctionCallOutput(responseRequests[1].body, 'call_list_files_1')) {
    console.error('Did not observe the expected function_call_output for list_files.');
    process.exit(4);
  }
}

if (scenario === 'multi-read') {
  if (responseRequests.length !== 2) {
    console.error(`Expected 2 /responses requests for multi-read scenario, saw ${responseRequests.length}.`);
    process.exit(8);
  }
  if (!hasFunctionCallOutput(responseRequests[1].body, 'call_glob_1')) {
    console.error('Did not observe the expected function_call_output for glob in multi-read scenario.');
    process.exit(9);
  }
  if (!hasFunctionCallOutput(responseRequests[1].body, 'call_read_file_1')) {
    console.error('Did not observe the expected function_call_output for read_file in multi-read scenario.');
    process.exit(10);
  }
  if (countFunctionCallOutputs(responseRequests[1].body) < 2) {
    console.error(`Expected at least 2 function_call_output items in multi-read scenario, saw ${countFunctionCallOutputs(responseRequests[1].body)}.`);
    process.exit(11);
  }
}

if (scenario === 'write-escalation') {
  if (responseRequests.length !== 2) {
    console.error(`Expected 2 /responses requests for write-escalation scenario, saw ${responseRequests.length}.`);
    process.exit(5);
  }
  const secondTools = getToolNames(responseRequests[1].body);
  if (!secondTools.includes('write_file') || !secondTools.includes('replace')) {
    console.error(`Write escalation did not expose full write tools. Saw: ${secondTools.join(', ')}`);
    process.exit(6);
  }
  if (responseRequests[1].body.parallel_tool_calls === true) {
    console.error('Write escalation follow-up incorrectly kept parallel_tool_calls=true.');
    process.exit(7);
  }
}

if (scenario === 'review-tools') {
  if (responseRequests.length !== 3) {
    console.error(`Expected 3 /responses requests for review-tools scenario, saw ${responseRequests.length}.`);
    process.exit(16);
  }
  if (!hasFunctionCallOutput(responseRequests[1].body, 'call_list_changed_files_1')) {
    console.error('Did not observe the expected function_call_output for list_changed_files.');
    process.exit(17);
  }
  if (!hasFunctionCallOutput(responseRequests[2].body, 'call_read_diff_1')) {
    console.error('Did not observe the expected function_call_output for read_diff.');
    process.exit(18);
  }
}

console.log('\nSchema validation passed.');
