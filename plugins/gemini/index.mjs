/**
 * Gemini provider plugin — agent-side ProviderPlugin.
 *
 * Uses Gemini CLI OAuth (from ~/.gemini/oauth_creds.json) with direct HTTP
 * calls to the CodeAssist endpoint (cloudcode-pa.googleapis.com).
 *
 * Provides file-system tools scoped to input.cwd.
 * Includes robust retry logic, exponential backoff, model fallbacks,
 * and real-time streaming connections matching the Gemini CLI.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { OAuth2Client } from 'google-auth-library';
import readline from 'node:readline';
import { Readable } from 'node:stream';
import { validatePathArgsWithinProject } from '../openai/path-guard.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const CODE_ASSIST_ENDPOINT = 'https://cloudcode-pa.googleapis.com';
const CODE_ASSIST_API_VERSION = 'v1internal';

// The CodeAssist API requires that if a model is "thinking" and emits a function call,
// the first function call in that response block must have a thoughtSignature property
// to tie the tool execution back to the reasoning that prompted it. We inject a
// synthetic signature just like the Gemini CLI does if one isn't natively returned.
const SYNTHETIC_THOUGHT_SIGNATURE = 'skip_thought_signature_validator';

// Gemini CLI's embedded OAuth client credentials (public, open-source)
const GEMINI_CLIENT_ID = '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com';
const GEMINI_CLIENT_SECRET = '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';

// ---------------------------------------------------------------------------
// Logging & Utilities
// ---------------------------------------------------------------------------
function logDebug(message) {
  try {
    const logEntry = `[${new Date().toISOString()}] ${message}\n`;
    fs.appendFileSync(path.join(os.homedir(), 'gemini-provider-debug.log'), logEntry);
  } catch { /* ignore */ }
}

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Project ID bootstrap — loadCodeAssist returns the GCP companion project
// ---------------------------------------------------------------------------
let cachedProjectId = null;

async function getProjectId(auth) {
  if (cachedProjectId) return cachedProjectId;
  try {
    const res = await apiPost(auth, 'loadCodeAssist', { metadata: {} });
    cachedProjectId = res.cloudaicompanionProject || null;
  } catch {
    // Non-fatal — generateContent may still work without project for some tiers
  }
  return cachedProjectId;
}

// ---------------------------------------------------------------------------
// Session management — in-memory conversation history
// ---------------------------------------------------------------------------
const MAX_SESSIONS = 200;
const sessions = new Map(); // sessionId -> { contents: Content[] }

function evictOldestSession() {
  if (sessions.size >= MAX_SESSIONS) {
    const oldest = sessions.keys().next().value;
    sessions.delete(oldest);
  }
}

function getOrCreateSession(sessionId) {
  if (sessionId && sessions.has(sessionId)) {
    return { session: sessions.get(sessionId), id: sessionId };
  }
  const id = sessionId || `gemini-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  evictOldestSession();
  const session = { contents: [] };
  sessions.set(id, session);
  return { session, id };
}

/**
 * Ensures that the first function call in every model turn within the active loop
 * has a `thoughtSignature` property to prevent 400 errors from the API.
 */
function ensureActiveLoopHasThoughtSignatures(requestContents) {
  // Find start of the active loop (last user turn with a text message)
  let activeLoopStartIndex = -1;
  for (let i = requestContents.length - 1; i >= 0; i--) {
    const content = requestContents[i];
    if (content.role === 'user' && content.parts?.some(part => part.text)) {
      activeLoopStartIndex = i;
      break;
    }
  }

  if (activeLoopStartIndex === -1) {
    return requestContents;
  }

  const newContents = requestContents.slice();
  for (let i = activeLoopStartIndex; i < newContents.length; i++) {
    const content = newContents[i];
    if (content.role === 'model' && content.parts) {
      const newParts = content.parts.slice();
      for (let j = 0; j < newParts.length; j++) {
        const part = newParts[j];
        if (part.functionCall) {
          if (!part.thoughtSignature) {
            newParts[j] = {
              ...part,
              thoughtSignature: SYNTHETIC_THOUGHT_SIGNATURE,
            };
            newContents[i] = {
              ...content,
              parts: newParts,
            };
          }
          break; // Only inject into the FIRST function call
        }
      }
    }
  }
  return newContents;
}


// ---------------------------------------------------------------------------
// OAuth2 client setup
// ---------------------------------------------------------------------------
async function createOAuth2Client(providerConfig) {
  // 1. Explicit API key — use simple bearer token auth instead of OAuth
  const apiKey = providerConfig?.API_KEY || process.env.GEMINI_API_KEY;
  if (apiKey) {
    return { apiKey };
  }

  // 2. Load OAuth creds from ~/.gemini/oauth_creds.json
  const credsPath = path.join(os.homedir(), '.gemini', 'oauth_creds.json');
  let creds;
  try {
    const credsData = await fs.promises.readFile(credsPath, 'utf8');
    creds = JSON.parse(credsData);
  } catch {
    return null;
  }

  if (!creds.access_token || !creds.refresh_token) {
    return null;
  }

  const client = new OAuth2Client({
    clientId: GEMINI_CLIENT_ID,
    clientSecret: GEMINI_CLIENT_SECRET,
  });
  client.setCredentials({
    access_token: creds.access_token,
    refresh_token: creds.refresh_token,
    expiry_date: creds.expiry_date,
  });

  return { oauth2Client: client };
}

// ---------------------------------------------------------------------------
// API request helpers
// ---------------------------------------------------------------------------
function getMethodUrl(method) {
  const endpoint = process.env.CODE_ASSIST_ENDPOINT || CODE_ASSIST_ENDPOINT;
  const version = process.env.CODE_ASSIST_API_VERSION || CODE_ASSIST_API_VERSION;
  return `${endpoint}/${version}:${method}`;
}

// For unary (blocking) calls like loadCodeAssist
async function apiPost(auth, method, body, signal) {
  const url = getMethodUrl(method);

  if (auth.oauth2Client) {
    const res = await auth.oauth2Client.request({
      url,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      data: body,
      signal,
    });
    return res.data;
  }

  const res = await globalThis.fetch(`${url}?key=${auth.apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`Gemini API ${res.status}: ${text}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// For streaming calls (keeps socket alive) matching CLI behavior
async function apiStreamPost(auth, method, body, signal) {
  const url = getMethodUrl(method);
  let responseStream;

  if (auth.oauth2Client) {
    const res = await auth.oauth2Client.request({
      url,
      method: 'POST',
      params: { alt: 'sse' },
      headers: { 'Content-Type': 'application/json' },
      responseType: 'stream',
      data: body,
      signal,
    });
    responseStream = res.data;
  } else {
    const res = await globalThis.fetch(`${url}?key=${auth.apiKey}&alt=sse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      const text = await res.text();
      const err = new Error(`Gemini API ${res.status}: ${text}`);
      err.status = res.status;
      throw err;
    }
    responseStream = res.body; // Web stream
  }

  // Create readline interface to parse SSE chunks
  const rl = readline.createInterface({
    input: responseStream instanceof Readable ? responseStream : Readable.fromWeb(responseStream),
    crlfDelay: Infinity,
  });

  const fullResponse = {
    response: {
      candidates: [{ content: { parts: [] } }]
    }
  };

  let buffer = [];

  function processBuffer() {
    if (buffer.length === 0) return;
    const payload = buffer.join('');
    buffer = [];

    if (payload === '[DONE]') return;

    try {
      const parsed = JSON.parse(payload);
      
      // Navigate to parts in the cloudcode-pa response structure
      const parsedCandidates = parsed?.response?.candidates || parsed?.candidates || [];
      const parts = parsedCandidates[0]?.content?.parts || [];
      
      const targetParts = fullResponse.response.candidates[0].content.parts;

      for (const part of parts) {
        if (part.text) {
          const lastPart = targetParts[targetParts.length - 1];
          if (lastPart && lastPart.text !== undefined) {
            lastPart.text += part.text;
          } else {
            targetParts.push({ text: part.text });
          }
        } else if (part.functionCall) {
          // Carry over the thoughtSignature natively if it exists
          const functionCallObj = { functionCall: part.functionCall };
          if (part.thoughtSignature) {
            functionCallObj.thoughtSignature = part.thoughtSignature;
          }
          targetParts.push(functionCallObj);
        }
      }
    } catch (e) {
      logDebug(`Error parsing stream chunk: ${e.message}`);
    }
  }

  for await (const line of rl) {
    if (line.startsWith('data: ')) {
      buffer.push(line.slice(6).trim());
    } else if (line === '') {
      processBuffer();
    }
  }
  
  processBuffer(); // catch any remaining bytes

  return fullResponse;
}


// ---------------------------------------------------------------------------
// Robust Retry & Fallback Logic
// ---------------------------------------------------------------------------
const RETRYABLE_NETWORK_CODES = [
  'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED',
  'ERR_SSL_SSLV3_ALERT_BAD_RECORD_MAC', 'ERR_SSL_WRONG_VERSION_NUMBER',
  'ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC', 'ERR_SSL_BAD_RECORD_MAC', 'EPROTO',
];

function isRetryableError(error) {
  const msg = (error.message || '').toLowerCase();
  if (msg.includes('fetch failed') || msg.includes('premature close')) return true;

  if (error.code && RETRYABLE_NETWORK_CODES.includes(error.code)) return true;

  let status = error.status;
  if (!status && error.response && error.response.status) {
    status = error.response.status;
  }

  if (status) {
    // Retry on 429 (Too Many Requests), 499 (Client Closed Request), and 5xx (Server Errors)
    if (status === 429 || status === 499 || (status >= 500 && status < 600)) {
      return true;
    }
  }

  return false;
}

async function generateContentWithRetry(auth, initialModel, requestBodyBase) {
  let model = initialModel;
  const maxAttempts = 10;
  let attempt = 0;
  const initialDelayMs = 2000;
  const maxDelayMs = 30000;
  let currentDelay = initialDelayMs;

  const fallbacks = {
    'gemini-3.1-pro-preview': 'gemini-3-pro-preview',
    'gemini-3-pro-preview': 'gemini-2.5-flash',
    'gemini-2.5-flash': 'gemini-2.0-flash'
  };

  while (attempt < maxAttempts) {
    attempt++;
    const requestBody = { ...requestBodyBase, model };

    try {
      // Use the streaming endpoint which keeps sockets alive for long tool execution
      const response = await apiStreamPost(auth, 'streamGenerateContent', requestBody);
      return { response, model };
    } catch (error) {
      const msg = (error.message || '').toLowerCase();
      
      // 1. Handle explicit server wait times
      const resetMatch = msg.match(/reset after (\d+)s/);
      if (resetMatch) {
        const waitSeconds = parseInt(resetMatch[1], 10);
        if (waitSeconds <= 60) {
           logDebug(`Rate limited on ${model}. Waiting ${waitSeconds}s (attempt ${attempt}/${maxAttempts})...`);
           await delay((waitSeconds + 1) * 1000);
           continue; 
        } else {
           error.isExhausted = true; 
        }
      }

      // 2. Handle Terminal Quota / Exhaustion with Model Fallbacks
      const isExhausted = error.isExhausted || msg.includes('exhausted your capacity') || msg.includes('quota exceeded');
      if (isExhausted) {
        if (fallbacks[model]) {
          logDebug(`Capacity exhausted for ${model}, falling back to ${fallbacks[model]}.`);
          model = fallbacks[model];
          attempt = 0; // Reset attempts for the new model
          currentDelay = initialDelayMs;
          continue;
        }
      }

      // 3. Handle Transient Network/Server Errors with Exponential Backoff + Jitter
      if (isRetryableError(error)) {
        if (attempt >= maxAttempts) {
          throw error;
        }
        const jitter = currentDelay * 0.3 * (Math.random() * 2 - 1);
        const delayWithJitter = Math.max(0, currentDelay + jitter);
        
        logDebug(`Attempt ${attempt} failed for ${model}: ${error.message}. Retrying in ${Math.round(delayWithJitter)}ms...`);
        
        await delay(delayWithJitter);
        currentDelay = Math.min(maxDelayMs, currentDelay * 2);
        continue;
      }

      // 4. Non-retryable error
      throw error;
    }
  }
  throw new Error(`Retry attempts exhausted for ${model}`);
}

// ---------------------------------------------------------------------------
// Tool declarations (Gemini functionDeclarations format)
// ---------------------------------------------------------------------------
function buildToolDeclarations() {
  return [{
    functionDeclarations: [
      {
        name: 'list_files',
        description: 'List files and directories at a path (relative to project root). Returns names with / suffix for directories.',
        parameters: {
          type: 'OBJECT',
          properties: {
            path: { type: 'STRING', description: 'Relative path within the project (default: ".")' },
          },
          required: [],
        },
      },
      {
        name: 'read_file',
        description: 'Read the contents of a file (relative to project root). Returns the file text.',
        parameters: {
          type: 'OBJECT',
          properties: {
            path: { type: 'STRING', description: 'Relative file path within the project' },
          },
          required: ['path'],
        },
      },
      {
        name: 'write_file',
        description: 'Write content to a file (relative to project root). Creates parent directories if needed.',
        parameters: {
          type: 'OBJECT',
          properties: {
            path: { type: 'STRING', description: 'Relative file path within the project' },
            content: { type: 'STRING', description: 'The full file content to write' },
          },
          required: ['path', 'content'],
        },
      },
      {
        name: 'search_files',
        description: 'Search for a text pattern (regex) across files in the project. Returns matching file paths and line numbers.',
        parameters: {
          type: 'OBJECT',
          properties: {
            pattern: { type: 'STRING', description: 'Regex pattern to search for' },
            glob: { type: 'STRING', description: 'File glob pattern to filter (e.g. "*.js", "**/*.ts")' },
          },
          required: ['pattern'],
        },
      },
      {
        name: 'run_command',
        description: 'Run an allowed command in the project directory. Permitted: build, test, lint, git read-only, file inspection. Destructive or network commands are blocked.',
        parameters: {
          type: 'OBJECT',
          properties: {
            command: { type: 'STRING', description: 'The command to execute (no shell operators)' },
          },
          required: ['command'],
        },
      },
    ],
  }];
}

// ---------------------------------------------------------------------------
// Tool execution (mirrors OpenAI plugin tools)
// ---------------------------------------------------------------------------
function createSafePath(projectDir) {
  const realProjectDir = fs.realpathSync(projectDir);
  return (relPath) => {
    const resolved = path.resolve(realProjectDir, relPath || '.');
    let real;
    try {
      real = fs.realpathSync(resolved);
    } catch {
      real = resolved;
    }
    if (!real.startsWith(realProjectDir + path.sep) && real !== realProjectDir) {
      throw new Error(`Path escapes project directory: ${relPath}`);
    }
    return real;
  };
}

const ALLOWED_COMMANDS = [
  'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'ag',
  'git status', 'git log', 'git diff', 'git show', 'git branch', 'git tag', 'git rev-parse',
  'npm test', 'npm run test', 'npm run lint', 'npm run build', 'npm run check',
  'npx vitest', 'npx jest', 'npx tsc', 'npx eslint', 'npx prettier',
  'yarn test', 'yarn lint', 'yarn build', 'yarn check',
  'pnpm test', 'pnpm lint', 'pnpm build',
  'cargo build', 'cargo test', 'cargo check', 'cargo clippy',
  'python -m pytest', 'pytest', 'go test', 'go build', 'go vet',
  'echo', 'pwd', 'which', 'date', 'whoami',
  'tree', 'du', 'df', 'file', 'stat',
];

const SHELL_META_RE = /[;|&`$(){}><\n\\!#~]/;

const FILE_READING_PROGRAMS = new Set([
  'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'ag',
  'file', 'stat', 'tree', 'du', 'ls',
]);

function isCommandAllowed(cmd) {
  const trimmed = cmd.trim();
  return ALLOWED_COMMANDS.some(prefix => {
    if (trimmed === prefix) return true;
    if (trimmed.startsWith(prefix + ' ')) return true;
    return false;
  });
}

function parseCommand(cmd) {
  const tokens = [];
  let current = '';
  let inDouble = false;
  let inSingle = false;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (inSingle) {
      if (ch === "'") { inSingle = false; continue; }
      current += ch;
    } else if (inDouble) {
      if (ch === '"') { inDouble = false; continue; }
      current += ch;
    } else if (ch === "'") {
      inSingle = true;
    } else if (ch === '"') {
      inDouble = true;
    } else if (ch === ' ' || ch === '\t') {
      if (current) { tokens.push(current); current = ''; }
    } else {
      current += ch;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

function executeTool(name, args, projectDir) {
  const safePath = createSafePath(projectDir);

  switch (name) {
    case 'list_files': {
      const target = safePath(args.path || '.');
      const entries = fs.readdirSync(target, { withFileTypes: true });
      return entries.map(e => e.isDirectory() ? e.name + '/' : e.name).join('\n');
    }
    case 'read_file': {
      const target = safePath(args.path);
      return fs.readFileSync(target, 'utf8');
    }
    case 'write_file': {
      const target = safePath(args.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, args.content);
      return `Wrote ${args.content.length} bytes to ${args.path}`;
    }
    case 'search_files': {
      const globPattern = args.glob || '*';
      try {
        const result = execFileSync(
          'grep',
          ['-rn', `--include=${globPattern}`, args.pattern, '.'],
          { cwd: projectDir, encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 10000 },
        );
        const lines = result.split('\n');
        const isTruncated = lines.length > 50;
        return lines.slice(0, 50).join('\n') + (isTruncated ? '\n... (truncated)' : '');
      } catch (err) {
        if (err.status === 1) return 'No matches found.';
        return `Search error: ${err.message}`;
      }
    }
    case 'run_command': {
      const command = args.command;
      if (SHELL_META_RE.test(command)) {
        return 'Command rejected: shell operators (;, |, &&, >, $, etc.) are not allowed.';
      }
      if (!isCommandAllowed(command)) {
        return `Command not allowed. Only read-only and build/test commands are permitted. Allowed prefixes: ${ALLOWED_COMMANDS.slice(0, 10).join(', ')}, ...`;
      }
      try {
        const [program, ...cmdArgs] = parseCommand(command.trim());
        validatePathArgsWithinProject(projectDir, program, cmdArgs, FILE_READING_PROGRAMS);
        const result = execFileSync(program, cmdArgs, {
          cwd: projectDir,
          encoding: 'utf8',
          maxBuffer: 1024 * 1024,
          timeout: 30000,
        });
        const lines = result.split('\n');
        if (lines.length > 100) {
          return lines.slice(0, 100).join('\n') + '\n... (truncated)';
        }
        return result || '(no output)';
      } catch (err) {
        if (err.message && err.message.includes('escapes project directory')) {
          return `Command rejected: ${err.message}`;
        }
        return `Exit code ${err.status || 1}\nstdout: ${err.stdout || ''}\nstderr: ${err.stderr || ''}`.trim();
      }
    }
    default:
      return `Unknown tool: ${name}`;
  }
}

// ---------------------------------------------------------------------------
// Extract text and function calls from Gemini response
// ---------------------------------------------------------------------------
function extractResponseParts(response) {
  const candidates = response?.response?.candidates || response?.candidates || [];
  if (candidates.length === 0) return { text: '', functionCalls: [], parts: [] };

  const parts = candidates[0]?.content?.parts || [];
  let text = '';
  const functionCalls = [];

  for (const part of parts) {
    if (part.text) {
      text += part.text;
    }
    if (part.functionCall) {
      functionCalls.push(part.functionCall);
    }
  }

  return { text, functionCalls, parts };
}

// ---------------------------------------------------------------------------
// ProviderPlugin export
// ---------------------------------------------------------------------------
const geminiProvider = {
  id: 'gemini',
  name: 'Gemini',
  defaultModel: 'gemini-3.1-pro-preview',
  capabilities: {
    supportsTools: true,
    supportsSessionResume: true,
    supportsPolicy: false,
  },

  async runPrompt(input) {
    const auth = await createOAuth2Client(input.providerConfig);
    if (!auth) {
      return {
        result: 'Error: No credentials found. Set GEMINI_API_KEY, or run `gemini` CLI and sign in (creates ~/.gemini/oauth_creds.json).',
        turns: 0,
        costUsd: 0,
        model: input.model || 'gemini-3.1-pro-preview',
      };
    }

    let model = input.model || 'gemini-3.1-pro-preview';
    const projectDir = path.resolve(input.cwd || '.');
    const maxTurns = input.maxTurns && input.maxTurns > 0 ? input.maxTurns : 500;

    const systemPrompt = input.systemPrompt || `You are a coding assistant with access to a project directory at: ${projectDir}

You can list files, read files, write files, search for patterns, and run shell commands.
Always explore the project structure before making changes.
When editing files, read them first to understand the context.
Keep responses concise and focused on the task.`;

    // Bootstrap project ID (required by CodeAssist endpoint)
    const projectId = await getProjectId(auth);

    // Get or create session for conversation history
    const { session, id: sessionId } = getOrCreateSession(input.resumeSessionId);

    // Add user message to conversation history
    session.contents.push({
      role: 'user',
      parts: [{ text: input.prompt }],
    });

    // Tool call loop
    let turns = 0;
    let finalText = '';

    while (turns < maxTurns) {
      turns++;

      // Pre-process session contents to add required thought signatures
      // (This exact logic exists in the core Gemini CLI to prevent 400 errors)
      const validatedContents = ensureActiveLoopHasThoughtSignatures(session.contents);

      // Build request body base (without model, which might change during fallback)
      const requestBodyBase = {
        project: projectId,
        request: {
          contents: validatedContents,
          systemInstruction: {
            role: 'system',
            parts: [{ text: systemPrompt }],
          },
          tools: buildToolDeclarations(),
          generationConfig: model.includes('thinking')
            ? { thinkingConfig: { include_thoughts: true } }
            : {},
        },
      };

      let response;
      try {
        const result = await generateContentWithRetry(auth, model, requestBodyBase);
        response = result.response;
        // Update model in case a fallback occurred during generation
        model = result.model;
      } catch (err) {
        logDebug(`Gemini API error after all retries: ${err.message}\n\n---\n\n`);
        return {
          result: `Error calling Gemini API: ${err.message}`,
          turns,
          costUsd: 0,
          model,
          sessionId,
        };
      }

      const { text, functionCalls, parts } = extractResponseParts(response);

      // Add model response to conversation history
      const modelParts = parts.length > 0 ? parts : [{ text: text || '' }];
      session.contents.push({
        role: 'model',
        parts: modelParts,
      });

      // If no function calls, we're done
      if (functionCalls.length === 0) {
        finalText = text;
        break;
      }

      // Execute function calls and send results back
      const functionResponseParts = [];
      for (const fc of functionCalls) {
        let result;
        try {
          result = executeTool(fc.name, fc.args || {}, projectDir);
        } catch (err) {
          result = `Tool error: ${err.message}`;
        }
        functionResponseParts.push({
          functionResponse: {
            name: fc.name,
            response: { result },
          },
        });
      }

      // Add function responses to conversation history
      session.contents.push({
        role: 'user',
        parts: functionResponseParts,
      });

      // If this was the last allowed turn, extract any text we got
      if (turns >= maxTurns) {
        finalText = text || '(max tool rounds reached)';
      }
    }

    return {
      result: finalText,
      turns,
      costUsd: 0,
      model,
      sessionId,
    };
  },
};

export default geminiProvider;
