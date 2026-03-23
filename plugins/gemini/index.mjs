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
import { execFileSync, execSync } from 'node:child_process';
import { OAuth2Client } from 'google-auth-library';
import readline from 'node:readline';
import { Readable } from 'node:stream';
import { validatePathArgsWithinProject } from './path-guard.mjs';

const READ_ONLY_TIER = 'read_only';
const DEV_SAFE_TIER = 'dev_safe';
const FULL_TIER = 'full';

function normalizeToolName(name) {
  return String(name || '').trim().toLowerCase();
}

function hasDisallowedTool(policy, toolName) {
  if (!policy || !Array.isArray(policy.disallowedTools)) return false;
  const wanted = normalizeToolName(toolName);
  return policy.disallowedTools.some((t) => normalizeToolName(t) === wanted);
}

function hasAnyDisallowedTool(policy, toolNames) {
  return toolNames.some((toolName) => hasDisallowedTool(policy, toolName));
}

const TOOL_ALIASES = {
  list_files: ['list_files', 'read'],
  read_file: ['read_file', 'read'],
  search_files: ['search_files', 'search'],
  glob: ['glob', 'search'],
  generalist: ['generalist'],
  write_file: ['write_file', 'write'],
  replace: ['replace', 'edit', 'multiedit', 'write'],
  run_command: ['run_command', 'bash'],
};

function getPermissionTier(policy, safeMode) {
  if (policy?.mode === 'none' || policy?.preset === 'power') {
    return FULL_TIER;
  }
  if (policy?.preset === 'safe') {
    return READ_ONLY_TIER;
  }
  if (policy?.preset === 'balanced') {
    return DEV_SAFE_TIER;
  }
  return safeMode === false ? FULL_TIER : DEV_SAFE_TIER;
}

function isToolEnabled(policy, permissionTier, toolName) {
  if (permissionTier === READ_ONLY_TIER && ['write_file', 'replace', 'run_command'].includes(toolName)) {
    return false;
  }
  return !hasAnyDisallowedTool(policy, TOOL_ALIASES[toolName] || [toolName]);
}

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
        if (part.text !== undefined) {
          const lastPart = targetParts[targetParts.length - 1];
          if (lastPart && lastPart.text !== undefined && !!lastPart.thought === !!part.thought) {
            lastPart.text += part.text;
          } else {
            const newPart = { text: part.text };
            if (part.thought) newPart.thought = true;
            targetParts.push(newPart);
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
    'gemini-3.1-pro-preview-customtools': 'gemini-3-pro-preview',
    'gemini-3-pro-preview': 'gemini-3-flash-preview',
    'gemini-3-flash-preview': 'gemini-2.5-pro',
    'gemini-2.5-pro': 'gemini-2.5-flash',
    'gemini-2.5-flash': 'gemini-2.5-flash-lite'
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
         error.isExhausted = true; 
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
function buildToolDeclarations(policy, permissionTier) {
  const declarations = [
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
        name: 'replace',
        description: 'Replaces exact literal text within a file.',
        parameters: {
          type: 'OBJECT',
          properties: {
            path: { type: 'STRING', description: 'Relative path to the file' },
            old_string: { type: 'STRING', description: 'The exact literal text to replace' },
            new_string: { type: 'STRING', description: 'The exact literal text to replace it with' },
            allow_multiple: { type: 'BOOLEAN', description: 'If true, replaces all occurrences' }
          },
          required: ['path', 'old_string', 'new_string'],
        },
      },
    {
        name: 'glob',
        description: 'Find files matching a pattern (e.g., **/*.ts) using find/grep.',
        parameters: {
          type: 'OBJECT',
          properties: {
            pattern: { type: 'STRING', description: 'The file pattern to search for' },
          },
          required: ['pattern'],
        },
      },
    {
        name: 'generalist',
        description: 'A general-purpose AI sub-agent. Use this to delegate complex, multi-step, or turn-intensive tasks to keep your main context lean.',
        parameters: {
          type: 'OBJECT',
          properties: {
            request: { type: 'STRING', description: 'The detailed task or question for the sub-agent.' },
          },
          required: ['request'],
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
  ];

  const enabled = declarations.filter((decl) => isToolEnabled(policy, permissionTier, decl.name));
  return [{ functionDeclarations: enabled }];
}

// ---------------------------------------------------------------------------
// Tool execution (mirrors OpenAI plugin tools)
// ---------------------------------------------------------------------------

function createSafePath(primaryRoot, allowedRoots, blockedRoots = []) {
  const realPrimary = fs.realpathSync(primaryRoot);
  const realRoots = allowedRoots.map((r) => {
    try { return fs.realpathSync(r); } catch { return r; }
  });
  const realBlockedRoots = blockedRoots.map((r) => {
    try { return fs.realpathSync(r); } catch { return r; }
  });

  function isUnderAnyRoot(resolvedPath) {
    return realRoots.some(
      (root) => resolvedPath === root || resolvedPath.startsWith(root + path.sep),
    );
  }

  function isUnderBlockedRoot(resolvedPath) {
    return realBlockedRoots.some(
      (root) => resolvedPath === root || resolvedPath.startsWith(root + path.sep),
    );
  }

  return (relPath) => {
    const resolved = path.isAbsolute(relPath)
      ? path.resolve(relPath)
      : path.resolve(realPrimary, relPath || '.');
    let real;
    try {
      real = fs.realpathSync(resolved);
    } catch {
      real = resolved;
    }
    if (!isUnderAnyRoot(real)) {
      throw new Error(`Path escapes allowed directories: ${relPath}`);
    }
    if (isUnderBlockedRoot(real)) {
      throw new Error(`Path is inside a blocked directory: ${relPath}`);
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

const SEARCH_TIMEOUT_MS = 15000;
const SEARCH_MAX_BUFFER = 8 * 1024 * 1024;
const SEARCH_FILE_LIMIT = 40;
const SEARCH_LINES_PER_FILE = 3;
const SEARCH_LINE_LIMIT = 120;
const SAFE_COMMAND_LINE_LIMIT = 800;
const FULL_COMMAND_LINE_LIMIT = 2000;

function isCommandAllowed(cmd) {
  const trimmed = cmd.trim();
  return ALLOWED_COMMANDS.some(prefix => {
    if (trimmed === prefix) return true;
    if (trimmed.startsWith(prefix + ' ')) return true;
    return false;
  });
}

function formatTruncatedCommandOutput(command, lines, maxLines) {
  const visible = lines.slice(0, maxLines).join('\n');
  const trimmed = String(command || '').trim();
  let hint = 'Output was truncated. Narrow the command and continue instead of stopping.';

  if (trimmed.startsWith('git diff')) {
    hint = 'Output was truncated. For reviews, continue with narrower commands such as `git diff --name-only <range>`, then `git diff <range> -- <file>` for each changed file.';
  } else if (trimmed.startsWith('git show')) {
    hint = 'Output was truncated. Continue with narrower commands such as `git show --stat <commit>` or `git show <commit> -- <file>` for the most relevant files.';
  } else if (trimmed.startsWith('git log')) {
    hint = 'Output was truncated. Continue with narrower commands such as `git log --oneline <range>` or `git log --stat -- <file>`.';
  }

  return `${visible}\n... (truncated)\n${hint}`;
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

function isSearchResourceLimitError(err) {
  const message = String(err?.message || '');
  return err?.code === 'ETIMEDOUT'
    || err?.code === 'ENOBUFS'
    || message.includes('maxBuffer')
    || message.includes('timed out');
}

function formatSearchResourceLimitMessage() {
  return 'Search was too broad and hit local resource limits. Narrow the pattern or provide a glob like "**/*.ts". Prefer glob for filename discovery before content search.';
}

function sanitizeSearchPaths(rawOutput, safePath) {
  return String(rawOutput || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => {
      try {
        safePath(line);
        return true;
      } catch {
        return false;
      }
    });
}

function sanitizeSearchMatches(rawOutput, safePath) {
  return String(rawOutput || '')
    .split('\n')
    .filter(Boolean)
    .filter((line) => {
      const filePath = line.split(':', 1)[0];
      try {
        safePath(filePath);
        return true;
      } catch {
        return false;
      }
    });
}

function formatSearchMatches(lines, totalMatchingFiles) {
  if (lines.length === 0) {
    return 'No matches found.';
  }
  const truncatedLines = lines.length > SEARCH_LINE_LIMIT;
  const limitedLines = lines.slice(0, SEARCH_LINE_LIMIT);
  let suffix = '';
  if (totalMatchingFiles > SEARCH_FILE_LIMIT) {
    suffix += `\n... (${totalMatchingFiles - SEARCH_FILE_LIMIT} more matching files; narrow the glob or pattern to continue)`;
  }
  if (truncatedLines) {
    suffix += `\n... (truncated to ${SEARCH_LINE_LIMIT} matching lines)`;
  }
  return limitedLines.join('\n') + suffix;
}

function runSearchCommand(program, commandArgs, projectDir) {
  return execFileSync(program, commandArgs, {
    cwd: projectDir,
    encoding: 'utf8',
    maxBuffer: SEARCH_MAX_BUFFER,
    timeout: SEARCH_TIMEOUT_MS,
  });
}

function searchWithRipgrep(pattern, globPattern, projectDir, safePath) {
  const listArgs = ['-l', '--color', 'never', '--no-messages'];
  if (globPattern) {
    listArgs.push('--glob', globPattern);
  }
  listArgs.push(pattern, '.');

  const fileListOutput = runSearchCommand('rg', listArgs, projectDir);
  const matchingFiles = sanitizeSearchPaths(fileListOutput, safePath);
  if (matchingFiles.length === 0) {
    return 'No matches found.';
  }

  const filesToInspect = matchingFiles.slice(0, SEARCH_FILE_LIMIT);
  const matchArgs = ['-n', '--color', 'never', '--no-heading', '-m', String(SEARCH_LINES_PER_FILE), pattern, ...filesToInspect];
  const matchesOutput = runSearchCommand('rg', matchArgs, projectDir);
  const lines = sanitizeSearchMatches(matchesOutput, safePath);
  return formatSearchMatches(lines, matchingFiles.length);
}

function searchWithGrep(pattern, globPattern, projectDir, safePath) {
  const listArgs = ['-rl'];
  if (globPattern) {
    listArgs.push(`--include=${globPattern}`);
  }
  listArgs.push(pattern, '.');

  const fileListOutput = runSearchCommand('grep', listArgs, projectDir);
  const matchingFiles = sanitizeSearchPaths(fileListOutput, safePath);
  if (matchingFiles.length === 0) {
    return 'No matches found.';
  }

  const filesToInspect = matchingFiles.slice(0, SEARCH_FILE_LIMIT);
  const matchArgs = ['-rn', '-m', String(SEARCH_LINES_PER_FILE), pattern, ...filesToInspect];
  const matchesOutput = runSearchCommand('grep', matchArgs, projectDir);
  const lines = sanitizeSearchMatches(matchesOutput, safePath);
  return formatSearchMatches(lines, matchingFiles.length);
}

async function executeTool(name, args, projectDir, context) {
  const safePath = createSafePath(
    projectDir,
    context.allowedRoots || [projectDir],
    context.blockedRoots || [],
  );

  if (!isToolEnabled(context.policy, context.permissionTier, name)) {
    return `Tool not allowed under current permissions: ${name}`;
  }

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
      const globPattern = String(args.glob || '').trim();
      try {
        return searchWithRipgrep(args.pattern, globPattern, projectDir, safePath);
      } catch (err) {
        if (err.status === 1) return 'No matches found.';
        if (err.code === 'ENOENT') {
          try {
            return searchWithGrep(args.pattern, globPattern, projectDir, safePath);
          } catch (fallbackErr) {
            if (fallbackErr.status === 1) return 'No matches found.';
            if (isSearchResourceLimitError(fallbackErr)) {
              return formatSearchResourceLimitMessage();
            }
            return `Search error: ${fallbackErr.message}`;
          }
        }
        if (isSearchResourceLimitError(err)) {
          return formatSearchResourceLimitMessage();
        }
        if (err.status === 1) return 'No matches found.';
        return `Search error: ${err.message}`;
      }
    }

    case 'replace': {
      const target = safePath(args.path);
      const content = fs.readFileSync(target, 'utf8');
      const { old_string, new_string, allow_multiple } = args;
      const count = content.split(old_string).length - 1;
      if (count === 0) return 'Error: old_string not found in file.';
      if (count > 1 && !allow_multiple) return 'Error: old_string found multiple times. Set allow_multiple to true to replace all.';
      
      const newContent = allow_multiple ? content.replaceAll(old_string, new_string) : content.replace(old_string, new_string);
      fs.writeFileSync(target, newContent);
      return `Replaced ${count} occurrence(s) in ${args.path}`;
    }
    case 'glob': {
      try {
         const result = execSync(`find . -type f -name "${args.pattern.replace(/[^a-zA-Z0-9_.*-]/g, '')}"`, {
           cwd: projectDir, encoding: 'utf8', maxBuffer: 1024 * 1024
         });
         const lines = result
           .trim()
           .split('\n')
           .filter(Boolean)
           .filter((line) => {
             try {
               safePath(line);
               return true;
             } catch {
               return false;
             }
           });
         return lines.slice(0, 100).join('\n') + (lines.length > 100 ? '\n...(truncated)' : '');
      } catch (err) {
         return 'No files found or error executing search.';
      }
    }
    case 'generalist': {
       const sysPrompt = `You are a specialized generalist sub-agent working in ${projectDir}. 
Your goal is to solve the following task and report back the final outcome or findings to the main agent.
Be concise.
Task: ${args.request}`;
       const result = await runAgentLoop({
           auth: context.auth,
           projectId: context.projectId,
           model: context.model,
           systemPrompt: sysPrompt,
           initialMessage: args.request,
           maxTurns: 50,
           projectDir,
           safeMode: context.safeMode,
           allowedRoots: context.allowedRoots,
           blockedRoots: context.blockedRoots,
           policy: context.policy,
           permissionTier: context.permissionTier,
           resumeSessionId: null
       });
       return `Sub-agent completed task.\nResult:\n${result.result}`;
    }
    case 'run_command': {
      const command = args.command;
      if (context.permissionTier !== FULL_TIER) {
          if (SHELL_META_RE.test(command)) {
            return 'Command rejected: shell operators (;, |, &&, >, $, etc.) are not allowed in safe mode.';
          }
          if (!isCommandAllowed(command)) {
            return `Command not allowed in safe mode. Allowed prefixes: ${ALLOWED_COMMANDS.slice(0, 10).join(', ')}, ...`;
          }
          try {
            const [program, ...cmdArgs] = parseCommand(command.trim());
            validatePathArgsWithinProject(context.allowedRoots || [projectDir], program, cmdArgs, FILE_READING_PROGRAMS);
            const result = execFileSync(program, cmdArgs, {
              cwd: projectDir,
              encoding: 'utf8',
              maxBuffer: 1024 * 1024,
              timeout: 30000,
            });
            const lines = result.split('\n');
            if (lines.length > SAFE_COMMAND_LINE_LIMIT) {
              return formatTruncatedCommandOutput(command, lines, SAFE_COMMAND_LINE_LIMIT);
            }
            return result || '(no output)';
          } catch (err) {
            if (err.message && err.message.includes('escapes project directory')) {
              return `Command rejected: ${err.message}`;
            }
            return `Exit code ${err.status || 1}\nstdout: ${err.stdout || ''}\nstderr: ${err.stderr || ''}`.trim();
          }
      } else {
          try {
              const result = execSync(command, {
                  cwd: projectDir,
                  encoding: 'utf8',
                  maxBuffer: 5 * 1024 * 1024,
                  timeout: 120000,
                  shell: true
              });
              const lines = result.split('\n');
              if (lines.length > FULL_COMMAND_LINE_LIMIT) {
                  return formatTruncatedCommandOutput(command, lines, FULL_COMMAND_LINE_LIMIT);
              }
              return result || '(no output)';
          } catch (err) {
             return `Exit code ${err.status || 1}\nstdout: ${err.stdout || ''}\nstderr: ${err.stderr || ''}`.trim();
          }
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
    if (part.text !== undefined && !part.thought) {
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

async function runAgentLoop({ auth, projectId, model, systemPrompt, initialMessage, maxTurns, projectDir, safeMode, resumeSessionId, allowedRoots, blockedRoots, policy, permissionTier }) {
    const { session, id: sessionId } = getOrCreateSession(resumeSessionId);

    if (initialMessage) {
      session.contents.push({
        role: 'user',
        parts: [{ text: initialMessage }],
      });
    }

    let turns = 0;
    let finalText = '';

    while (turns < maxTurns) {
      turns++;

      const validatedContents = ensureActiveLoopHasThoughtSignatures(session.contents);

      const context = { auth, projectId, model, safeMode, maxTurns, allowedRoots, blockedRoots, policy, permissionTier };
      const requestBodyBase = {
        project: projectId,
        request: {
          contents: validatedContents,
          systemInstruction: {
            role: 'system',
            parts: [{ text: systemPrompt }],
          },
          tools: buildToolDeclarations(context.policy, context.permissionTier),
          generationConfig: {},
        },
      };

      let response;
      try {
        const result = await generateContentWithRetry(auth, model, requestBodyBase);
        response = result.response;
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

      const modelParts = parts.length > 0 ? parts : [{ text: text || '' }];
      session.contents.push({
        role: 'model',
        parts: modelParts,
      });

      if (functionCalls.length === 0) {
        finalText = text;
        break;
      }

      const functionResponseParts = [];
      for (const fc of functionCalls) {
        let result;
        try {
          // context already defined above
          result = await executeTool(fc.name, fc.args || {}, projectDir, context);
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

      session.contents.push({
        role: 'user',
        parts: functionResponseParts,
      });

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
}

const geminiProvider = {
  id: 'gemini',
  name: 'Gemini',
  defaultModel: 'gemini-3.1-pro-preview',
  capabilities: {
    supportsTools: true,
    supportsSessionResume: true,
    supportsPolicy: true,
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
    const allowedRoots = [projectDir];
    if (input.policy?.allowedCwdRoots?.length) {
      for (const root of input.policy.allowedCwdRoots) {
        const resolved = path.resolve(root);
        if (!allowedRoots.includes(resolved)) allowedRoots.push(resolved);
      }
    }
    const blockedRoots = Array.isArray(input.policy?.blockedPathRoots)
      ? input.policy.blockedPathRoots.map((root) => path.resolve(root))
      : [];

    const maxTurns = input.maxTurns && input.maxTurns > 0 ? input.maxTurns : 500;
    
    const safeMode = input.providerConfig?.SAFE_MODE !== 'false';
    const permissionTier = getPermissionTier(input.policy, safeMode);

    let workspaceGuidance;
    if (allowedRoots.length > 1) {
      const dirList = allowedRoots.map((r) => `  - ${r}`).join('\n');
      workspaceGuidance = `You are a coding assistant with access to multiple project directories:\n${dirList}\n\nYour primary working directory is: ${projectDir}\nRelative paths resolve against the primary directory. Use absolute paths to access other directories.`;
    } else {
      workspaceGuidance = `You are a coding assistant with access to a project directory at: ${projectDir}`;
    }
    const toolGuidance = `Operate only within the allowed directories and never use blocked paths.\nYour current permission tier is: ${permissionTier}.\nIn dev-safe mode, you may edit files within the workspace and run only safe local development commands. In read-only mode, do not attempt writes or shell commands.\nAlways explore the project structure before making changes.\nWhen editing files, read them first to understand the context.\nPrefer glob for filename discovery and use search_files only when you need content matches. For large repos, narrow search_files with a glob like "**/*.ts" or a more specific pattern.\nWhen reviewing a commit range, do not rely on one huge \`git diff\`. Start with \`git diff --name-only <range>\` or \`git show --stat <commit>\`, then inspect the most relevant files incrementally.\nIf a command or search returns truncated output, treat that as a cue to narrow the scope and continue with follow-up commands instead of stopping.\nKeep responses concise and focused on the task.`;
    const defaultPrompt = `${workspaceGuidance}\n\n${toolGuidance}`;
    const systemPrompt = input.systemPrompt
      ? `${input.systemPrompt}\n\nAdditional runtime guidance:\n${workspaceGuidance}\n${toolGuidance}`
      : defaultPrompt;

    const projectId = await getProjectId(auth);

    const result = await runAgentLoop({
      auth,
      projectId,
      model,
      systemPrompt,
      initialMessage: input.prompt,
      maxTurns,
      projectDir,
      safeMode,
      allowedRoots,
      blockedRoots,
      permissionTier,
      policy: input.policy,
      resumeSessionId: input.resumeSessionId
    });

    return result;
  },
};

export default geminiProvider;
