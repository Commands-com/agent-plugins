/**
 * OpenAI provider plugin — agent-side ProviderPlugin.
 *
 * Uses Codex OAuth (from ~/.codex/auth.json) with the @openai/agents SDK
 * and a custom fetch adapter that injects:
 *   store: false, stream: true, and efficient default reasoning/text controls
 *
 * Provides file-system tools scoped to input.cwd and policy.allowedCwdRoots.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import OpenAI from 'openai';
import {
  Agent,
  Runner,
  tool,
  MCPServerStdio,
  MCPServerStreamableHttp,
  MCPServerSSE,
  connectMcpServers,
  createMCPToolStaticFilter,
  OpenAIProvider,
} from '@openai/agents';
import { OpenAIResponsesCompactionSession } from '@openai/agents-openai';
import { z } from 'zod';
import { validatePathArgsWithinProject } from './path-guard.mjs';

// ---------------------------------------------------------------------------
// Session management via SDK OpenAIResponsesCompactionSession
// ---------------------------------------------------------------------------
const MAX_SESSIONS = 200;
// Compact at 90% of context window, matching the Codex CLI strategy.
// gpt-5.4 has a 272k token context window; ~4 chars per token estimate.
const CONTEXT_WINDOW_TOKENS = 272_000;
const COMPACT_TOKEN_THRESHOLD = Math.floor(CONTEXT_WINDOW_TOKENS * 0.9);  // ~244,800 tokens
const CHARS_PER_TOKEN = 4;
const DEFAULT_REASONING_EFFORT = 'xhigh';
const DEFAULT_TEXT_VERBOSITY = 'low';
const ALLOWED_REASONING_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh']);
const ALLOWED_TEXT_VERBOSITIES = new Set(['low', 'medium', 'high']);
const WRITE_ACCESS_SENTINEL = '__OPENAI_PROVIDER_WRITE_ACCESS_REQUEST__';
const execFileAsync = promisify(execFile);

const sessions = new Map();

function estimateTokensFromItems(items) {
  let chars = 0;
  for (const item of items) {
    chars += JSON.stringify(item).length;
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

function evictOldestSession() {
  if (sessions.size >= MAX_SESSIONS) {
    const oldest = sessions.keys().next().value;
    sessions.delete(oldest);
  }
}

function normalizeStringChoice(value, allowedValues, fallback) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return fallback;
  return allowedValues.has(normalized) ? normalized : fallback;
}

function getReasoningEffort(providerConfig) {
  return normalizeStringChoice(
    providerConfig?.REASONING_EFFORT ?? process.env.PROVIDER_OPENAI_REASONING_EFFORT,
    ALLOWED_REASONING_EFFORTS,
    DEFAULT_REASONING_EFFORT,
  );
}

function getTextVerbosity(providerConfig) {
  return normalizeStringChoice(
    providerConfig?.TEXT_VERBOSITY ?? process.env.PROVIDER_OPENAI_TEXT_VERBOSITY,
    ALLOWED_TEXT_VERBOSITIES,
    DEFAULT_TEXT_VERBOSITY,
  );
}

function getBooleanConfig(providerConfig, key, fallback = false) {
  const directValue = providerConfig?.[key];
  if (typeof directValue === 'boolean') return directValue;
  if (typeof directValue === 'string') {
    const normalized = directValue.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  }

  const envValue = process.env[`PROVIDER_OPENAI_${key}`];
  if (typeof envValue === 'string') {
    const normalized = envValue.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  }

  return fallback;
}

function ensureSessionId(sessionId) {
  return sessionId || `openai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function getSessionKey(sessionId, profile = 'default') {
  return `${sessionId}:${profile}`;
}

function getOrCreateSession(sessionId, client, model, profile = 'default') {
  const id = ensureSessionId(sessionId);
  const key = getSessionKey(id, profile);
  if (sessions.has(key)) {
    return { session: sessions.get(key), id, key };
  }
  evictOldestSession();
  const session = new OpenAIResponsesCompactionSession({
    client, model,
    compactionMode: 'input',  // Force input-based compaction; store: false means responses aren't persisted
    shouldTriggerCompaction: ({ sessionItems }) => {
      const estimatedTokens = estimateTokensFromItems(sessionItems);
      return estimatedTokens >= COMPACT_TOKEN_THRESHOLD;
    },
  });
  sessions.set(key, session);
  return { session, id, key };
}

// ---------------------------------------------------------------------------
// Codex auth + fetch adapter
// ---------------------------------------------------------------------------
function loadAccessToken(providerConfig) {
  // 1. Explicit config (from env PROVIDER_OPENAI_API_KEY or desktop providerConfig)
  if (providerConfig?.API_KEY) return providerConfig.API_KEY;

  // 2. Standard OPENAI_API_KEY env var
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;

  // 3. Codex OAuth from ~/.codex/auth.json
  const authPath = path.join(os.homedir(), '.codex', 'auth.json');
  try {
    const auth = JSON.parse(fs.readFileSync(authPath, 'utf8'));
    const token = auth.tokens?.access_token;
    if (token) return token;
  } catch {
    // file missing or unreadable
  }

  return null;
}

function createCodexFetch({
  instructions,
  reasoningEffort,
  textVerbosity,
  model,
  promptCacheKey,
  parallelToolCalls,
}) {
  function parseRequestJsonBody(body) {
    if (typeof body === 'string') {
      return JSON.parse(body);
    }
    if (body instanceof Uint8Array) {
      return JSON.parse(Buffer.from(body).toString('utf8'));
    }
    if (body instanceof ArrayBuffer) {
      return JSON.parse(Buffer.from(body).toString('utf8'));
    }
    return null;
  }

  return async (url, init) => {
    // Only intercept /responses calls (the Agents SDK endpoint)
    if (typeof url === 'string' && !url.includes('/responses')) {
      return globalThis.fetch(url, init);
    }

    // Handle /responses/compact separately — inject the same request controls
    // we use on /responses, plus the required `instructions` field, and return
    // JSON directly.
    const isCompact = typeof url === 'string' && url.includes('/responses/compact');

    if (init?.body != null) {
      try {
        const b = parseRequestJsonBody(init.body);
        if (!b || typeof b !== 'object') {
          throw new Error('request body is not JSON');
        }
        if (isCompact) {
          // Compact endpoint requires `instructions`; SDK doesn't send it
          if (!b.instructions && instructions) {
            b.instructions = instructions;
          }
          b.parallel_tool_calls = Boolean(parallelToolCalls);
          if (!b.reasoning || typeof b.reasoning !== 'object') {
            b.reasoning = { effort: reasoningEffort };
          } else if (!b.reasoning.effort) {
            b.reasoning = { ...b.reasoning, effort: reasoningEffort };
          }
          if (typeof model === 'string' && model.toLowerCase().startsWith('gpt-5')) {
            const textControls = (b.text && typeof b.text === 'object') ? b.text : {};
            if (!textControls.verbosity) {
              b.text = { ...textControls, verbosity: textVerbosity };
            }
          }
          // Strip rs_* IDs from input items — responses aren't persisted with store: false
          if (Array.isArray(b.input)) {
            b.input = b.input.map(item => {
              if (item && typeof item.id === 'string' && item.id.startsWith('rs_')) {
                const { id, ...rest } = item;
                return rest;
              }
              return item;
            });
          }
        } else {
          b.store = false;
          b.stream = true;
          b.parallel_tool_calls = Boolean(parallelToolCalls);
          if (promptCacheKey) {
            b.prompt_cache_key = promptCacheKey;
          }
          if (!b.reasoning || typeof b.reasoning !== 'object') {
            b.reasoning = { effort: reasoningEffort };
          } else if (!b.reasoning.effort) {
            b.reasoning = { ...b.reasoning, effort: reasoningEffort };
          }
          if (typeof model === 'string' && model.toLowerCase().startsWith('gpt-5')) {
            const textControls = (b.text && typeof b.text === 'object') ? b.text : {};
            if (!textControls.verbosity) {
              b.text = { ...textControls, verbosity: textVerbosity };
            }
          }
          // The Codex endpoint requires store: false, which means response items
          // are never persisted. On follow-up requests the Agents SDK embeds
          // previous response items (with rs_* IDs) in the input array. Strip
          // those IDs so the server treats items as inline values instead of
          // trying to look them up by ID (which would 404).
          if (Array.isArray(b.input)) {
            b.input = b.input.map(item => {
              if (item && typeof item.id === 'string' && item.id.startsWith('rs_')) {
                const { id, ...rest } = item;
                return rest;
              }
              return item;
            });
          }
        }
        if (process.env.PROVIDER_OPENAI_FETCH_DEBUG === '1') {
          process.stderr.write(
            `[openai-provider fetch] ${isCompact ? 'compact' : 'responses'} cache=${promptCacheKey || '(none)'} parallel=${String(parallelToolCalls)} body_parallel=${String(b.parallel_tool_calls)}\n`,
          );
        }
        init = { ...init, body: JSON.stringify(b) };
      } catch {
        // leave body as-is if not JSON
      }
    }

    const resp = await globalThis.fetch(url, init);
    if (!resp.ok) {
      const t = await resp.text();
      // Debug: log failed requests to file for inspection
      try {
        const bodyPreview = typeof init?.body === 'string'
          ? JSON.stringify(JSON.parse(init.body), null, 2).slice(0, 4000)
          : '(no body)';
        const logEntry = `[${new Date().toISOString()}] ${resp.status} error for ${url}\nResponse: ${t || '(empty)'}\nRequest body:\n${bodyPreview}\n\n---\n\n`;
        fs.appendFileSync(path.join(os.homedir(), 'openai-provider-debug.log'), logEntry);
        process.stderr.write(`[openai-provider] ${resp.status} error — details written to ~/openai-provider-debug.log\n`);
      } catch { /* ignore logging errors */ }
      return new Response(t, { status: resp.status, headers: resp.headers });
    }

    // Compact responses are regular JSON, not SSE
    if (isCompact) {
      return resp;
    }

    // Collect SSE stream and return the completed response as JSON
    const text = await resp.text();
    let completed = null;
    for (const line of text.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      const d = line.slice(6);
      if (d === '[DONE]') continue;
      try {
        const p = JSON.parse(d);
        if (p.type === 'response.completed') completed = p.response;
      } catch {
        // skip malformed SSE lines
      }
    }

    if (!completed) {
      return new Response('{}', { status: 502 });
    }
    return new Response(JSON.stringify(completed), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}

// ---------------------------------------------------------------------------
// Path safety: all file ops scoped to allowed roots
// ---------------------------------------------------------------------------
function createSafePath(primaryRoot, allowedRoots) {
  const realPrimary = fs.realpathSync(primaryRoot);
  const realRoots = allowedRoots.map((r) => fs.realpathSync(r));

  function isUnderAnyRoot(resolvedPath) {
    return realRoots.some(
      (root) => resolvedPath === root || resolvedPath.startsWith(root + path.sep),
    );
  }

  return (relPath) => {
    // Resolve relative paths against the primary root; absolute paths stay as-is
    const resolved = path.isAbsolute(relPath)
      ? path.resolve(relPath)
      : path.resolve(realPrimary, relPath);
    let real;
    try {
      real = fs.realpathSync(resolved);
    } catch {
      // File may not exist yet (e.g., for write_file); fall back to resolved path
      real = resolved;
    }
    if (!isUnderAnyRoot(real)) {
      throw new Error(`Path escapes allowed directories: ${relPath}`);
    }
    return real;
  };
}

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

function matchesArgvPrefix(argv, prefix) {
  if (!Array.isArray(prefix) || prefix.length === 0) return false;
  if (prefix.length > argv.length) return false;
  for (let i = 0; i < prefix.length; i += 1) {
    if (prefix[i] !== argv[i]) return false;
  }
  return true;
}

function formatPrefixList(prefixes, maxCount = 10) {
  if (!Array.isArray(prefixes) || prefixes.length === 0) return '';
  const labels = prefixes
    .filter((p) => Array.isArray(p) && p.length > 0)
    .map((p) => p.join(' '));
  if (labels.length === 0) return '';
  if (labels.length <= maxCount) return labels.join(', ');
  return `${labels.slice(0, maxCount).join(', ')}, ...`;
}

function getShellPolicyViolation(command, argv, policy) {
  if (!policy) return null;

  if (hasDisallowedTool(policy, 'Bash')) {
    return 'shell commands are disabled by this permission profile';
  }

  if (Array.isArray(policy?.bash?.denyPatterns)) {
    for (const pattern of policy.bash.denyPatterns) {
      try {
        if (new RegExp(pattern, 'i').test(command)) {
          return `command blocked by deny pattern: ${pattern}`;
        }
      } catch {
        // Ignore invalid patterns to avoid taking down tool execution.
      }
    }
  }

  const shellPolicy = policy.shell;
  if (!shellPolicy) return null;

  if (Array.isArray(shellPolicy.denyPrefixes)) {
    for (const prefix of shellPolicy.denyPrefixes) {
      if (matchesArgvPrefix(argv, prefix)) {
        return `command prefix denied: ${prefix.join(' ')}`;
      }
    }
  }

  if (Array.isArray(shellPolicy.allowPrefixes)) {
    if (shellPolicy.allowPrefixes.length === 0) {
      return 'no shell commands are allowed by this permission profile';
    }

    const hasWildcard = shellPolicy.allowPrefixes.some(
      (p) => Array.isArray(p) && p.length === 1 && p[0] === '*',
    );
    if (hasWildcard) return null;

    const allowed = shellPolicy.allowPrefixes.some((prefix) => matchesArgvPrefix(argv, prefix));
    if (!allowed) {
      return `command is not in allowed shell prefixes: ${argv[0] || '(unknown)'}`;
    }
  }

  return null;
}

function getServerToolLists(serverId, policy) {
  const allowRefs = Array.isArray(policy?.mcpAllowTools) ? policy.mcpAllowTools : [];
  const denyRefs = Array.isArray(policy?.mcpDenyTools) ? policy.mcpDenyTools : [];

  const allowedToolNames = [];
  const blockedToolNames = [];

  for (const ref of allowRefs) {
    if (typeof ref !== 'string') continue;
    const idx = ref.indexOf('__');
    if (idx <= 0) continue;
    if (ref.slice(0, idx) !== serverId) continue;
    const toolName = ref.slice(idx + 2);
    if (toolName) allowedToolNames.push(toolName);
  }

  for (const ref of denyRefs) {
    if (typeof ref !== 'string') continue;
    const idx = ref.indexOf('__');
    if (idx <= 0) continue;
    if (ref.slice(0, idx) !== serverId) continue;
    const toolName = ref.slice(idx + 2);
    if (toolName) blockedToolNames.push(toolName);
  }

  return {
    hasGlobalAllowList: allowRefs.length > 0,
    allowedToolNames,
    blockedToolNames,
  };
}

function isMcpServerAllowed(serverId, policy) {
  if (!Array.isArray(policy?.mcpAllowServers)) return true;
  if (policy.mcpAllowServers.includes('*')) return true;
  return policy.mcpAllowServers.includes(serverId);
}

function buildMcpServerInstance(serverId, config) {
  const rawType = typeof config?.type === 'string' ? config.type.trim() : '';
  const type = rawType || 'stdio';

  if (type === 'stdio') {
    return new MCPServerStdio({
      name: serverId,
      command: config.command,
      ...(Array.isArray(config.args) ? { args: config.args } : {}),
      ...(config.env && typeof config.env === 'object' ? { env: config.env } : {}),
    });
  }

  if (type === 'http' || type === 'sse') {
    const headers = (config.headers && typeof config.headers === 'object') ? config.headers : undefined;
    const requestInit = headers ? { headers } : undefined;
    if (type === 'http') {
      return new MCPServerStreamableHttp({
        name: serverId,
        url: config.url,
        ...(requestInit ? { requestInit } : {}),
      });
    }
    return new MCPServerSSE({
      name: serverId,
      url: config.url,
      ...(requestInit ? { requestInit } : {}),
    });
  }

  throw new Error(`unsupported_mcp_server_type_${type}`);
}

async function connectPolicyMcpServers(inputMcpServers, policy) {
  if (!inputMcpServers || typeof inputMcpServers !== 'object') {
    return null;
  }

  const prepared = [];
  for (const [serverId, config] of Object.entries(inputMcpServers)) {
    if (!isMcpServerAllowed(serverId, policy)) {
      continue;
    }

    const { hasGlobalAllowList, allowedToolNames, blockedToolNames } = getServerToolLists(serverId, policy);
    if (hasGlobalAllowList && allowedToolNames.length === 0) {
      continue;
    }

    try {
      const server = buildMcpServerInstance(serverId, config);
      const toolFilter = createMCPToolStaticFilter({
        ...(hasGlobalAllowList ? { allowed: allowedToolNames } : {}),
        ...(blockedToolNames.length > 0 ? { blocked: blockedToolNames } : {}),
      });
      if (toolFilter) {
        server.toolFilter = toolFilter;
      }
      prepared.push(server);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[openai-provider] skipping MCP server "${serverId}": ${message}\n`);
    }
  }

  if (prepared.length === 0) {
    return null;
  }

  return connectMcpServers(prepared, {
    strict: false,
    dropFailed: true,
    connectInParallel: true,
  });
}

// ---------------------------------------------------------------------------
// Create tools scoped to allowed directories
// ---------------------------------------------------------------------------
function createTools(projectDir, allowedRoots, policy, profile = 'full') {
  const safePath = createSafePath(projectDir, allowedRoots);
  const multiRoot = allowedRoots.length > 1;
  const pathDesc = multiRoot
    ? 'Path (relative to primary project root, or absolute path within any allowed directory)'
    : 'Relative path within the project';
  const isReadOnlyProfile = profile === 'read_only';
  const MAX_LIST_LIMIT = 500;
  const DEFAULT_LIST_LIMIT = 200;
  const MAX_GLOB_LIMIT = 500;
  const DEFAULT_GLOB_LIMIT = 200;
  const MAX_LIST_DEPTH = 5;
  const DEFAULT_CHANGED_FILES_LIMIT = 200;
  const MAX_CHANGED_FILES_LIMIT = 500;
  const DEFAULT_DIFF_LINE_LIMIT = 400;
  const MAX_DIFF_LINE_LIMIT = 1200;
  const MAX_GIT_OUTPUT_BUFFER = 4 * 1024 * 1024;
  const reviewScopeSchema = z.enum(['uncommitted', 'commit', 'range']);
  let gitRepoRootPromise;

  function normalizePositiveInt(value, fallback, maxValue) {
    const raw = typeof value === 'number' && Number.isFinite(value)
      ? Math.trunc(value)
      : fallback;
    const normalized = raw > 0 ? raw : fallback;
    return Math.min(normalized, maxValue);
  }

  function normalizeNonNegativeInt(value, fallback, maxValue = Number.MAX_SAFE_INTEGER) {
    const raw = typeof value === 'number' && Number.isFinite(value)
      ? Math.trunc(value)
      : fallback;
    const normalized = raw >= 0 ? raw : fallback;
    return Math.min(normalized, maxValue);
  }

  function sortDirEntries(entries) {
    return [...entries].sort((left, right) => {
      if (left.isDirectory() !== right.isDirectory()) {
        return left.isDirectory() ? -1 : 1;
      }
      return left.name.localeCompare(right.name);
    });
  }

  function formatPaginatedLines(lines, offset, limit) {
    if (lines.length === 0) {
      return 'No entries found.';
    }

    const window = lines.slice(offset, offset + limit);
    if (window.length === 0) {
      return `No entries found in the requested window. Total entries: ${lines.length}.`;
    }

    const remaining = Math.max(lines.length - (offset + window.length), 0);
    const suffix = remaining > 0
      ? `\n... (${remaining} more entries; use offset=${offset + window.length} to continue)`
      : '';
    return window.join('\n') + suffix;
  }

  async function collectListEntries(baseDir, maxDepth, maxEntries) {
    const lines = [];

    async function walk(currentDir, remainingDepth) {
      const entries = sortDirEntries(await fs.promises.readdir(currentDir, { withFileTypes: true }));
      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);
        const relativePath = path.relative(baseDir, fullPath).split(path.sep).join('/');
        lines.push(entry.isDirectory() ? `${relativePath}/` : relativePath);
        if (lines.length >= maxEntries) {
          return true;
        }
        if (entry.isDirectory() && remainingDepth > 1) {
          const shouldStop = await walk(fullPath, remainingDepth - 1);
          if (shouldStop) {
            return true;
          }
        }
      }
      return false;
    }

    await walk(baseDir, maxDepth);
    return lines;
  }

  function globPatternToRegExp(pattern) {
    const normalized = String(pattern || '').split(path.sep).join('/');
    const escaped = normalized
      .replace(/[-[\]{}()+?.,\\^$|#\s]/g, '\\$&')
      .replace(/\*\*/g, '__GLOBSTAR__')
      .replace(/\*/g, '[^/]*')
      .replace(/__GLOBSTAR__/g, '.*');
    return new RegExp(`^${escaped}$`);
  }

  async function collectGlobMatches(baseDir, pattern, maxEntries) {
    const matches = [];
    const matcher = globPatternToRegExp(pattern);

    async function walk(currentDir) {
      const entries = sortDirEntries(await fs.promises.readdir(currentDir, { withFileTypes: true }));
      for (const entry of entries) {
        if (entry.isDirectory() && (entry.name === '.git' || entry.name === 'node_modules')) {
          continue;
        }
        const fullPath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          const shouldStop = await walk(fullPath);
          if (shouldStop) {
            return true;
          }
          continue;
        }

        const relativePath = path.relative(baseDir, fullPath).split(path.sep).join('/');
        if (matcher.test(relativePath)) {
          matches.push(relativePath);
          if (matches.length >= maxEntries) {
            return true;
          }
        }
      }
      return false;
    }

    await walk(baseDir);
    return matches;
  }

  async function getGitRepoRoot() {
    if (!gitRepoRootPromise) {
      gitRepoRootPromise = (async () => {
        try {
          const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
            cwd: projectDir,
            encoding: 'utf8',
            maxBuffer: 1024 * 1024,
            timeout: 10000,
          });
          const gitRoot = stdout.trim();
          return gitRoot ? gitRoot : null;
        } catch {
          return null;
        }
      })();
    }
    return gitRepoRootPromise;
  }

  async function runGit(args, { allowExitCode1 = false } = {}) {
    const gitRoot = await getGitRepoRoot();
    if (!gitRoot) {
      return {
        ok: false,
        message: 'Current project is not inside a git repository.',
      };
    }

    try {
      const { stdout, stderr } = await execFileAsync('git', args, {
        cwd: gitRoot,
        encoding: 'utf8',
        maxBuffer: MAX_GIT_OUTPUT_BUFFER,
        timeout: 30000,
      });
      return { ok: true, stdout, stderr, gitRoot };
    } catch (err) {
      if (allowExitCode1 && (err.code === 1 || err.status === 1)) {
        return {
          ok: true,
          stdout: err.stdout || '',
          stderr: err.stderr || '',
          gitRoot,
        };
      }
      const stderr = typeof err.stderr === 'string' ? err.stderr.trim() : '';
      const message = stderr || err.message || String(err);
      return {
        ok: false,
        message: `Git command failed: ${message}`,
      };
    }
  }

  function normalizeNullableString(value) {
    const trimmed = String(value || '').trim();
    return trimmed ? trimmed : null;
  }

  function formatPaginatedText(content, offset, limit) {
    const lines = String(content || '').replace(/\r\n/g, '\n').split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop();
    }
    if (lines.length === 0) {
      return 'No output found.';
    }

    const window = lines.slice(offset, offset + limit);
    if (window.length === 0) {
      return `No lines found in the requested window. Total lines: ${lines.length}.`;
    }

    const numbered = window.map((line, idx) => `${offset + idx + 1}\t${line}`);
    const remaining = Math.max(lines.length - (offset + window.length), 0);
    const suffix = remaining > 0
      ? `\n... (${remaining} more lines; use offset=${offset + window.length} to continue)`
      : '';
    return numbered.join('\n') + suffix;
  }

  async function resolveGitPathspec(relPath) {
    const normalizedPath = normalizeNullableString(relPath);
    if (!normalizedPath) {
      return { ok: true, pathspec: null };
    }

    const gitRoot = await getGitRepoRoot();
    if (!gitRoot) {
      return {
        ok: false,
        message: 'Current project is not inside a git repository.',
      };
    }

    let absolutePath;
    try {
      absolutePath = safePath(normalizedPath);
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }

    const relativePath = path.relative(gitRoot, absolutePath).split(path.sep).join('/');
    if (relativePath === '') {
      return { ok: true, pathspec: '.' };
    }
    if (relativePath === '..' || relativePath.startsWith('../')) {
      return {
        ok: false,
        message: `Path is outside the primary git repository: ${normalizedPath}`,
      };
    }

    return { ok: true, pathspec: relativePath };
  }

  async function prepareReviewScope(scope, target, relPath) {
    const normalizedTarget = normalizeNullableString(target);
    if (scope !== 'uncommitted' && !normalizedTarget) {
      return {
        ok: false,
        message: `target is required when scope="${scope}".`,
      };
    }

    const pathspecResult = await resolveGitPathspec(relPath);
    if (!pathspecResult.ok) {
      return pathspecResult;
    }

    return {
      ok: true,
      target: normalizedTarget,
      pathspec: pathspecResult.pathspec,
    };
  }

  function buildGitPathspecArgs(pathspec) {
    return pathspec ? ['--', pathspec] : [];
  }

  async function getUncommittedStatus(pathspec) {
    return runGit([
      'status',
      '--short',
      '--untracked-files=all',
      '--ignored=no',
      '--porcelain=v1',
      ...buildGitPathspecArgs(pathspec),
    ]);
  }

  async function buildUncommittedDiff(pathspec, contextLines) {
    const sections = [];
    const staged = await runGit([
      'diff',
      '--cached',
      '--no-ext-diff',
      `--unified=${contextLines}`,
      ...buildGitPathspecArgs(pathspec),
    ]);
    if (!staged.ok) {
      return staged;
    }
    if (staged.stdout.trim()) {
      sections.push(`## Staged changes\n\n${staged.stdout.trimEnd()}`);
    }

    const unstaged = await runGit([
      'diff',
      '--no-ext-diff',
      `--unified=${contextLines}`,
      ...buildGitPathspecArgs(pathspec),
    ]);
    if (!unstaged.ok) {
      return unstaged;
    }
    if (unstaged.stdout.trim()) {
      sections.push(`## Unstaged changes\n\n${unstaged.stdout.trimEnd()}`);
    }

    const status = await getUncommittedStatus(pathspec);
    if (!status.ok) {
      return status;
    }
    const untracked = status.stdout
      .split('\n')
      .filter((line) => line.startsWith('?? '));
    if (untracked.length > 0) {
      sections.push(`## Untracked files\n\n${untracked.join('\n')}`);
    }

    return {
      ok: true,
      stdout: sections.join('\n\n'),
    };
  }

  const listFiles = tool({
    name: 'list_files',
    description: `List files and directories at a path. Supports pagination and shallow recursion. Returns names with / suffix for directories.${multiRoot ? ' Accepts absolute paths to any allowed directory.' : ''}`,
    parameters: z.object({
      path: z.string().describe(`${pathDesc}. Use "." for the current directory.`),
      depth: z.number().int().positive().nullable().describe('Recursion depth. Use 1 for direct children only, 2 to include one nested level, or null for the default depth of 1'),
      offset: z.number().int().min(0).nullable().describe('Pagination offset. Use 0 or null for the first page'),
      limit: z.number().int().positive().nullable().describe(`Maximum entries to return. Use null for the default limit of ${DEFAULT_LIST_LIMIT}`),
    }),
    execute: async ({ path: relPath, depth, offset, limit }) => {
      const target = safePath(relPath || '.');
      const stat = await fs.promises.stat(target);
      if (!stat.isDirectory()) {
        return `Path is not a directory: ${relPath}`;
      }

      const depthLimit = normalizePositiveInt(depth, 1, MAX_LIST_DEPTH);
      const paginationOffset = normalizeNonNegativeInt(offset, 0);
      const paginationLimit = normalizePositiveInt(limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
      const lines = await collectListEntries(
        target,
        depthLimit,
        paginationOffset + paginationLimit + 1,
      );
      return formatPaginatedLines(lines, paginationOffset, paginationLimit);
    },
  });

  const globFiles = tool({
    name: 'glob',
    description: `Find files by filename/path pattern without reading file contents. Prefer this for discovery before broad content searches.${multiRoot ? ' Accepts absolute paths to any allowed directory.' : ''}`,
    parameters: z.object({
      path: z.string().describe(`${pathDesc}. Use "." for the current directory.`),
      pattern: z.string().describe('Glob pattern such as "*.json", "src/**/*.ts", or "**/*test*.js"'),
      offset: z.number().int().min(0).nullable().describe('Pagination offset. Use 0 or null for the first page'),
      limit: z.number().int().positive().nullable().describe(`Maximum matches to return. Use null for the default limit of ${DEFAULT_GLOB_LIMIT}`),
    }),
    execute: async ({ path: relPath, pattern, offset, limit }) => {
      const target = safePath(relPath || '.');
      const stat = await fs.promises.stat(target);
      if (!stat.isDirectory()) {
        return `Path is not a directory: ${relPath}`;
      }

      const paginationOffset = normalizeNonNegativeInt(offset, 0);
      const paginationLimit = normalizePositiveInt(limit, DEFAULT_GLOB_LIMIT, MAX_GLOB_LIMIT);
      let lines = [];

      if (process.platform !== 'win32') {
        try {
          const { stdout } = await execFileAsync(
            'rg',
            ['--files', '-g', pattern, '.'],
            { cwd: target, encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 10000 },
          );
          lines = stdout.split('\n').filter(Boolean);
        } catch (err) {
          if (err.code !== 'ENOENT' && err.code !== 1 && err.status !== 1) {
            return `Glob error: ${err.message}`;
          }
        }
      }

      if (lines.length === 0) {
        try {
          lines = await collectGlobMatches(target, pattern, paginationOffset + paginationLimit + 1);
        } catch (err) {
          return `Glob error: ${err.message}`;
        }
      }

      return formatPaginatedLines(lines, paginationOffset, paginationLimit);
    },
  });

  const readFile = tool({
    name: 'read_file',
    description: `Read the contents of a file. Optionally limit to a line range to reduce context use.${multiRoot ? ' Accepts absolute paths to any allowed directory.' : ''}`,
    parameters: z.object({
      path: z.string().describe(pathDesc),
      start_line: z.number().int().positive().nullable().describe('1-based starting line, or null to read from the beginning'),
      end_line: z.number().int().positive().nullable().describe('1-based ending line (inclusive), or null to read through the end of the file'),
    }),
    execute: async ({ path: relPath, start_line: startLine, end_line: endLine }) => {
      const target = safePath(relPath);
      const content = await fs.promises.readFile(target, 'utf8');
      if (startLine == null && endLine == null) {
        return content;
      }

      const lines = content.split('\n');
      const start = Math.max(startLine || 1, 1);
      const end = Math.max(endLine || start, start);
      if (start > lines.length) {
        return `Requested range ${start}-${end} is outside the file (length ${lines.length} lines).`;
      }

      return lines
        .slice(start - 1, end)
        .map((line, idx) => `${start + idx}\t${line}`)
        .join('\n');
    },
  });

  const writeFile = tool({
    name: 'write_file',
    description: `Write content to a file. Creates parent directories if needed.${multiRoot ? ' Accepts absolute paths to any allowed directory.' : ''}`,
    parameters: z.object({
      path: z.string().describe(pathDesc),
      content: z.string().describe('The full file content to write'),
    }),
    execute: async ({ path: relPath, content }) => {
      const target = safePath(relPath);
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      await fs.promises.writeFile(target, content);
      return `Wrote ${content.length} bytes to ${relPath}`;
    },
  });

  const replaceFile = tool({
    name: 'replace',
    description: `Replace exact literal text within a file. Prefer this over rewriting an entire file for small edits.${multiRoot ? ' Accepts absolute paths to any allowed directory.' : ''}`,
    parameters: z.object({
      path: z.string().describe(pathDesc),
      old_string: z.string().describe('Exact literal text to replace'),
      new_string: z.string().describe('Replacement text'),
      allow_multiple: z.boolean().nullable().describe('Set true to replace all matches, or false/null to replace only the first match'),
    }),
    execute: async ({ path: relPath, old_string: oldString, new_string: newString, allow_multiple: allowMultiple }) => {
      if (!oldString) {
        return 'Error: old_string cannot be empty.';
      }

      const target = safePath(relPath);
      const content = await fs.promises.readFile(target, 'utf8');
      const count = content.split(oldString).length - 1;
      if (count === 0) {
        return `Error: old_string not found in ${relPath}.`;
      }
      const shouldReplaceAll = allowMultiple === true;
      if (count > 1 && !shouldReplaceAll) {
        return `Error: old_string found ${count} times in ${relPath}. Set allow_multiple to true to replace all.`;
      }

      const nextContent = shouldReplaceAll
        ? content.replaceAll(oldString, newString)
        : content.replace(oldString, newString);
      await fs.promises.writeFile(target, nextContent);
      return `Replaced ${count} occurrence(s) in ${relPath}`;
    },
  });

  const searchFiles = tool({
    name: 'search_files',
    description: `Search for a text pattern (regex) across files. Returns matching file paths and line numbers.${multiRoot ? ' Searches all allowed directories.' : ''}`,
    parameters: z.object({
      pattern: z.string().describe('Regex pattern to search for'),
      glob: z.string().describe('File glob pattern to filter (e.g. "*.js", "**/*.ts"). Use "*" to search all files.'),
    }),
    execute: async ({ pattern, glob: globPattern }) => {
      const normalizedGlob = globPattern || '*';
      const allResults = [];

      if (process.platform === 'win32') {
        // Pure JS fallback — grep is not available on Windows
        let re;
        try { re = new RegExp(pattern); } catch { return `Invalid regex pattern: ${pattern}`; }
        const globRe = new RegExp(
          '^' + normalizedGlob.replace(/\./g, '\\.').replace(/\*\*/g, '{{GLOBSTAR}}').replace(/\*/g, '[^/]*').replace(/\?/g, '.').replace(/\{\{GLOBSTAR\}\}/g, '.*') + '$'
        );
        function walkDir(dir, root) {
          let entries;
          try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
          for (const entry of entries) {
            if (entry.name === 'node_modules' || entry.name === '.git') continue;
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              walkDir(fullPath, root);
            } else if (globRe.test(entry.name)) {
              try {
                const content = fs.readFileSync(fullPath, 'utf8');
                const lines = content.split('\n');
                for (let i = 0; i < lines.length; i++) {
                  if (re.test(lines[i])) {
                    const relPath = './' + path.relative(root, fullPath).split(path.sep).join('/');
                    const prefix = multiRoot ? `[${root}] ` : '';
                    allResults.push(`${prefix}${relPath}:${i + 1}:${lines[i]}`);
                    if (allResults.length >= 50) return;
                  }
                }
              } catch { /* skip binary or unreadable files */ }
            }
            if (allResults.length >= 50) return;
          }
        }
        for (const root of allowedRoots) {
          walkDir(root, root);
          if (allResults.length >= 50) break;
        }
      } else {
        for (const root of allowedRoots) {
          try {
            const rgArgs = ['--line-number', '--no-heading', '--color', 'never'];
            if (normalizedGlob && normalizedGlob !== '*') {
              rgArgs.push('--glob', normalizedGlob);
            }
            rgArgs.push(pattern, '.');

            let result;
            try {
              const execResult = await execFileAsync(
                'rg',
                rgArgs,
                { cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 10000 },
              );
              result = execResult.stdout;
            } catch (err) {
              if (err.code === 'ENOENT') {
                const execResult = await execFileAsync(
                  'grep',
                  ['-rn', `--include=${normalizedGlob}`, pattern, '.'],
                  { cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 10000 },
                );
                result = execResult.stdout;
              } else if (err.code === 1) {
                result = '';
              } else {
                throw err;
              }
            }
            if (multiRoot) {
              const prefixed = result.split('\n')
                .filter(Boolean)
                .map(line => `[${root}] ${line}`);
              allResults.push(...prefixed);
            } else {
              allResults.push(...result.split('\n').filter(Boolean));
            }
          } catch (err) {
            if (err.status !== 1) {
              allResults.push(`[${root}] Search error: ${err.message}`);
            }
            // status 1 = no matches, skip silently
          }
        }
      }

      if (allResults.length === 0) return 'No matches found.';
      const lines = allResults.slice(0, 50);
      return lines.join('\n') + (allResults.length > 50 ? '\n... (truncated)' : '');
    },
  });

  const listChangedFiles = tool({
    name: 'list_changed_files',
    description: 'List files changed in a review target. Prefer this first for reviews and audits before broad filesystem exploration.',
    parameters: z.object({
      scope: reviewScopeSchema.describe('Review scope: "uncommitted" for current workspace changes, "commit" for one commit, or "range" for a git diff range'),
      target: z.string().nullable().describe('Use null for scope="uncommitted". For scope="commit", provide a commit SHA like "abc123". For scope="range", provide a diff range like "main...HEAD"'),
      path: z.string().nullable().describe('Optional file or directory path filter within the primary git repository, or null for the whole review target'),
      offset: z.number().int().min(0).nullable().describe('Pagination offset. Use 0 or null for the first page'),
      limit: z.number().int().positive().nullable().describe(`Maximum changed files to return. Use null for the default limit of ${DEFAULT_CHANGED_FILES_LIMIT}`),
    }),
    execute: async ({ scope, target, path: relPath, offset, limit }) => {
      const prepared = await prepareReviewScope(scope, target, relPath);
      if (!prepared.ok) {
        return prepared.message;
      }

      const paginationOffset = normalizeNonNegativeInt(offset, 0);
      const paginationLimit = normalizePositiveInt(limit, DEFAULT_CHANGED_FILES_LIMIT, MAX_CHANGED_FILES_LIMIT);
      let lines = [];

      if (scope === 'uncommitted') {
        const status = await getUncommittedStatus(prepared.pathspec);
        if (!status.ok) {
          return status.message;
        }
        lines = status.stdout.split('\n').filter(Boolean);
      } else if (scope === 'commit') {
        const result = await runGit([
          'show',
          '--format=',
          '--name-status',
          '--find-renames',
          prepared.target,
          ...buildGitPathspecArgs(prepared.pathspec),
        ]);
        if (!result.ok) {
          return result.message;
        }
        lines = result.stdout.split('\n').filter(Boolean);
      } else {
        const result = await runGit([
          'diff',
          '--name-status',
          '--find-renames',
          prepared.target,
          ...buildGitPathspecArgs(prepared.pathspec),
        ]);
        if (!result.ok) {
          return result.message;
        }
        lines = result.stdout.split('\n').filter(Boolean);
      }

      if (lines.length === 0) {
        return 'No changed files found.';
      }
      return formatPaginatedLines(lines, paginationOffset, paginationLimit);
    },
  });

  const readDiff = tool({
    name: 'read_diff',
    description: 'Read a paginated git diff for a review target. Prefer this before broad file reads when reviewing code changes.',
    parameters: z.object({
      scope: reviewScopeSchema.describe('Review scope: "uncommitted" for current workspace changes, "commit" for one commit, or "range" for a git diff range'),
      target: z.string().nullable().describe('Use null for scope="uncommitted". For scope="commit", provide a commit SHA like "abc123". For scope="range", provide a diff range like "main...HEAD"'),
      path: z.string().nullable().describe('Optional file or directory path filter within the primary git repository, or null for the whole review target'),
      context_lines: z.number().int().positive().nullable().describe('How many unchanged context lines to include around each hunk. Use null for the default of 5'),
      offset: z.number().int().min(0).nullable().describe('Starting diff line offset. Use 0 or null for the first page'),
      limit: z.number().int().positive().nullable().describe(`Maximum diff lines to return. Use null for the default limit of ${DEFAULT_DIFF_LINE_LIMIT}`),
    }),
    execute: async ({ scope, target, path: relPath, context_lines: contextLines, offset, limit }) => {
      const prepared = await prepareReviewScope(scope, target, relPath);
      if (!prepared.ok) {
        return prepared.message;
      }

      const requestedContextLines = normalizePositiveInt(contextLines, 5, 20);
      const paginationOffset = normalizeNonNegativeInt(offset, 0);
      const paginationLimit = normalizePositiveInt(limit, DEFAULT_DIFF_LINE_LIMIT, MAX_DIFF_LINE_LIMIT);
      let diffResult;

      if (scope === 'uncommitted') {
        diffResult = await buildUncommittedDiff(prepared.pathspec, requestedContextLines);
      } else if (scope === 'commit') {
        diffResult = await runGit([
          'show',
          '--format=medium',
          '--find-renames',
          '--no-ext-diff',
          `--unified=${requestedContextLines}`,
          prepared.target,
          ...buildGitPathspecArgs(prepared.pathspec),
        ]);
      } else {
        diffResult = await runGit([
          'diff',
          '--find-renames',
          '--no-ext-diff',
          `--unified=${requestedContextLines}`,
          prepared.target,
          ...buildGitPathspecArgs(prepared.pathspec),
        ]);
      }

      if (!diffResult.ok) {
        return diffResult.message;
      }
      if (!diffResult.stdout.trim()) {
        return 'No diff found.';
      }
      return formatPaginatedText(diffResult.stdout, paginationOffset, paginationLimit);
    },
  });

  const readFileAtRevision = tool({
    name: 'read_file_at_revision',
    description: 'Read a file exactly as it existed at a git revision. Useful for review follow-up when you need the pre-change or historical version of a file.',
    parameters: z.object({
      path: z.string().describe('Path to a file within the primary git repository'),
      revision: z.string().describe('Git revision expression such as "HEAD", "abc123", or "abc123^"'),
      start_line: z.number().int().positive().nullable().describe('1-based starting line, or null to read from the beginning'),
      end_line: z.number().int().positive().nullable().describe('1-based ending line (inclusive), or null to read through the end of the file'),
    }),
    execute: async ({ path: relPath, revision, start_line: startLine, end_line: endLine }) => {
      const normalizedRevision = normalizeNullableString(revision);
      if (!normalizedRevision) {
        return 'revision is required.';
      }

      const pathspecResult = await resolveGitPathspec(relPath);
      if (!pathspecResult.ok) {
        return pathspecResult.message;
      }
      if (!pathspecResult.pathspec || pathspecResult.pathspec === '.') {
        return 'Path must point to a file within the primary git repository.';
      }

      const result = await runGit(['show', `${normalizedRevision}:${pathspecResult.pathspec}`]);
      if (!result.ok) {
        return result.message;
      }

      const content = result.stdout;
      if (startLine == null && endLine == null) {
        return content;
      }

      const lines = content.split('\n');
      const start = Math.max(startLine || 1, 1);
      const end = Math.max(endLine || start, start);
      if (start > lines.length) {
        return `Requested range ${start}-${end} is outside the file (length ${lines.length} lines).`;
      }

      return lines
        .slice(start - 1, end)
        .map((line, idx) => `${start + idx}\t${line}`)
        .join('\n');
    },
  });

  // NOTE: 'env', 'find', and 'make' are intentionally excluded because they can
  // execute arbitrary sub-commands (env sh -c ..., find -exec ..., Makefile recipes).
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
  const ALLOWED_READ_ONLY_COMMANDS = [
    'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'ag',
    'git status', 'git log', 'git diff', 'git show', 'git branch', 'git tag', 'git rev-parse',
    'pwd', 'which', 'date', 'whoami',
    'tree', 'du', 'df', 'file', 'stat',
  ];

  // Shell metacharacters that indicate injection attempts. These are rejected
  // before the command is parsed so that no shell interpretation occurs.
  const SHELL_META_RE = /[;|&`$(){}><\n\\!#~]/;

  // Programs whose non-flag arguments may reference file paths and must stay within allowed roots.
  const FILE_READING_PROGRAMS = new Set([
    'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'ag',
    'file', 'stat', 'tree', 'du', 'ls',
  ]);

  const shellAllowSummary = Array.isArray(policy?.shell?.allowPrefixes)
    ? formatPrefixList(policy.shell.allowPrefixes)
    : '';
  const runtimePermissionProfile = String(process.env.PERMISSION_PROFILE || '').trim().toLowerCase();
  // Built-in "full" compiles to mode:none, so input.policy is undefined.
  // In that case, bypass the static fallback allowlist to preserve full-access semantics.
  const isFullProfileWithoutPolicy = !policy && runtimePermissionProfile === 'full';
  const bypassStaticAllowList = !isReadOnlyProfile && isFullProfileWithoutPolicy;
  const commandAllowList = isReadOnlyProfile ? ALLOWED_READ_ONLY_COMMANDS : ALLOWED_COMMANDS;
  const runCommandDescription = isReadOnlyProfile
    ? (policy
      ? (shellAllowSummary
        ? `Run one non-interactive read-only command allowed by the permission profile. Allowed command prefixes include: ${shellAllowSummary}.`
        : 'Run one non-interactive read-only command, constrained by the permission profile.')
      : 'Run an allowed read-only command in the project directory (no shell). Permitted: file inspection and git read-only commands. Build, test, edit, network, and destructive commands are blocked.')
    : (policy
      ? (shellAllowSummary
        ? `Run one non-interactive command allowed by the permission profile. Allowed command prefixes include: ${shellAllowSummary}.`
        : 'Run one non-interactive command, constrained by the permission profile.')
      : (bypassStaticAllowList
        ? 'Run one non-interactive command in the project directory. Full Access profile detected, so command-prefix allowlist checks are not applied.'
        : 'Run an allowed command in the project directory (no shell). Permitted: build, test, lint, git read-only, file inspection. Destructive or network commands are blocked.'));

  function isCommandAllowed(cmd) {
    const trimmed = cmd.trim();
    return commandAllowList.some(prefix => {
      if (trimmed === prefix) return true;
      if (trimmed.startsWith(prefix + ' ')) return true;
      return false;
    });
  }

  function formatAllowedPrefixes(prefixes) {
    return prefixes.slice(0, 10).join(', ') + (prefixes.length > 10 ? ', ...' : '');
  }

  function validatePathArgs(program, args) {
    validatePathArgsWithinProject(allowedRoots, program, args, FILE_READING_PROGRAMS);
  }

  /**
   * Parse a command string into [program, ...args] using basic shell-style
   * tokenisation (respects double/single quotes but no variable expansion).
   * Only called AFTER shell metacharacter rejection, so the string is safe.
   */
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

  const runCommand = tool({
    name: 'run_command',
    description: `${runCommandDescription} No shell operators (;, |, &&, >, $, etc.) and no interactive terminal sessions.`,
    parameters: z.object({
      command: z.string().describe('The command to execute (no shell operators like ;, |, &&, >, etc.)'),
    }),
    execute: async ({ command }) => {
      const trimmedCommand = String(command || '').trim();
      if (!trimmedCommand) {
        return 'Command rejected: command cannot be empty.';
      }
      // Reject shell metacharacters before any further processing
      if (SHELL_META_RE.test(trimmedCommand)) {
        return 'Command rejected: shell operators (;, |, &&, >, $, etc.) are not allowed. Provide a single command without shell syntax.';
      }
      const argv = parseCommand(trimmedCommand);
      const policyViolation = getShellPolicyViolation(trimmedCommand, argv, policy);
      if (policyViolation) {
        return `Command rejected by permission profile: ${policyViolation}`;
      }
      if (!policy && !bypassStaticAllowList && !isCommandAllowed(trimmedCommand)) {
        return `Command not allowed. Allowed prefixes: ${formatAllowedPrefixes(commandAllowList)}`;
      }

      try {
        const [program, ...args] = argv;
        if (!program) {
          return 'Command rejected: command cannot be empty.';
        }
        // Validate that file-reading commands cannot access paths outside allowed roots
        validatePathArgs(program, args);
        const { stdout } = await execFileAsync(program, args, {
          cwd: projectDir,
          encoding: 'utf8',
          maxBuffer: 1024 * 1024,
          timeout: 30000,
        });
        const lines = stdout.split('\n');
        if (lines.length > 100) {
          return lines.slice(0, 100).join('\n') + '\n... (truncated)';
        }
        return stdout || '(no output)';
      } catch (err) {
        if (err.message && err.message.includes('escapes allowed directories')) {
          return `Command rejected: ${err.message}`;
        }
        return `Exit code ${err.status || 1}\nstdout: ${err.stdout || ''}\nstderr: ${err.stderr || ''}`.trim();
      }
    },
  });

  const requestWriteAccess = tool({
    name: 'request_write_access',
    description: 'Request a rerun with write-capable tools and broader shell access when permitted by policy. Use this only when the task truly requires changes beyond read-only inspection.',
    parameters: z.object({
      reason: z.string().min(1).describe('Brief reason why write-capable tools are needed'),
    }),
    execute: async ({ reason }) => `${WRITE_ACCESS_SENTINEL}\n${String(reason || '').trim()}`,
  });

  const tools = [listChangedFiles, readDiff, readFileAtRevision, listFiles, globFiles, readFile];

  const writeIsDisallowed = hasAnyDisallowedTool(policy, [
    'Write',
    'Edit',
    'MultiEdit',
    'NotebookEdit',
    'NotebookWrite',
  ]);
  if (!writeIsDisallowed && !isReadOnlyProfile) {
    tools.push(replaceFile);
    tools.push(writeFile);
  }

  tools.push(searchFiles);

  const bashIsDisallowed = hasDisallowedTool(policy, 'Bash');
  if (!bashIsDisallowed) {
    tools.push(runCommand);
  }
  if (isReadOnlyProfile && !writeIsDisallowed) {
    tools.push(requestWriteAccess);
  }

  return tools;
}

function parseWriteAccessRequest(output) {
  if (typeof output !== 'string' || !output.startsWith(WRITE_ACCESS_SENTINEL)) {
    return null;
  }
  return output.slice(WRITE_ACCESS_SENTINEL.length).trim() || 'Write-capable tools are required.';
}

function buildDefaultPrompt({
  projectDir,
  allowedRoots,
  toolUseEnabled,
  profile,
  canEscalateToWrite,
  parallelToolCalls,
}) {
  if (!toolUseEnabled) {
    return 'You are a coding assistant.\n\nFile, shell, and MCP tools are disabled for this turn. Answer directly from the conversation context and keep responses concise and focused on the task.';
  }

  const multiRoot = allowedRoots.length > 1;
  const dirIntro = multiRoot
    ? `You are a coding assistant with access to multiple project directories:\n${allowedRoots.map((r) => `  - ${r}`).join('\n')}\n\nYour primary working directory is: ${projectDir}\nRelative paths resolve against the primary directory. Use absolute paths to access other directories.`
    : `You are a coding assistant with access to a project directory at: ${projectDir}`;

  if (profile === 'read_only') {
    return `${dirIntro}\n\nYou are operating in read-only review mode. You can inspect git-native review targets with list_changed_files, read_diff, and read_file_at_revision, plus list files, glob for candidate filenames, read files, read targeted line ranges, search for patterns, and run read-only shell commands.\nFor review or audit tasks, start with list_changed_files and read_diff for the requested uncommitted changes, commit, or diff range before broad filesystem exploration.\nWhen a diff points to a suspicious file, prefer read_file_at_revision or targeted read_file line ranges before reading whole files.\nUse glob for filename discovery and search_files only when you need content matches instead of filename discovery.${parallelToolCalls ? '\nBatch independent read-only tool calls in parallel when helpful.' : ''}\nDo not attempt edits in this mode.${canEscalateToWrite ? '\nIf the task truly requires edits or broader shell access, call request_write_access with a brief reason. The system will rerun with write-capable tools and any additional shell access permitted by policy.' : ''}\nKeep responses concise and focused on the task.`;
  }

  return `${dirIntro}\n\nYou can inspect git-native review targets with list_changed_files, read_diff, and read_file_at_revision, plus list files, glob for candidate filenames, read files, read targeted line ranges, replace exact text within files, write files, search for patterns, and run shell commands.\nFor review or audit tasks, start with list_changed_files and read_diff before broad filesystem exploration.\nPrefer filename discovery with glob, shallow/paginated list_files, targeted reads, and exact replacements for small edits.\nKeep responses concise and focused on the task.`;
}

function buildSystemPrompt(defaultPrompt, incomingSystemPrompt) {
  const normalizedIncoming = typeof incomingSystemPrompt === 'string'
    ? incomingSystemPrompt.trim()
    : '';
  if (!normalizedIncoming) {
    return defaultPrompt;
  }

  return `${normalizedIncoming}\n\nAdditional provider runtime guidance:\n${defaultPrompt}`;
}

// ---------------------------------------------------------------------------
// ProviderPlugin export
// ---------------------------------------------------------------------------
const openaiProvider = {
  id: 'openai',
  name: 'OpenAI',
  defaultModel: 'gpt-5.4',
  capabilities: {
    supportsTools: true,      // The provider supports tool use via its built-in Agents SDK tools
    supportsSessionResume: true,
    supportsPolicy: true,
  },

  async runPrompt(input) {
    const accessToken = loadAccessToken(input.providerConfig);
    if (!accessToken) {
      return {
        result: 'Error: No access token found. Set OPENAI_API_KEY, PROVIDER_OPENAI_API_KEY, or run `codex` and sign in (creates ~/.codex/auth.json).',
        turns: 0,
        costUsd: 0,
        model: input.model || 'gpt-5.4',
      };
    }

    const baseUrl = input.providerConfig?.BASE_URL || 'https://chatgpt.com/backend-api/codex';
    const model = input.model || 'gpt-5.4';
    const projectDir = path.resolve(input.cwd || '.');
    const requestedSessionId = ensureSessionId(input.resumeSessionId);
    const toolUseEnabled = input.allowToolUse !== false;
    const reasoningEffort = getReasoningEffort(input.providerConfig);
    const textVerbosity = getTextVerbosity(input.providerConfig);
    const readOnlyFirst = toolUseEnabled && getBooleanConfig(input.providerConfig, 'READ_ONLY_FIRST', true);
    const allowParallelReadOnlyTurns = toolUseEnabled && getBooleanConfig(input.providerConfig, 'PARALLEL_TOOL_CALLS', true);
    const maxTurns = input.maxTurns && input.maxTurns > 0 ? input.maxTurns : 500;

    // Build the full set of allowed roots from policy (if available)
    const allowedRoots = [projectDir];
    if (input.policy?.allowedCwdRoots?.length) {
      for (const root of input.policy.allowedCwdRoots) {
        const resolved = path.resolve(root);
        if (!allowedRoots.includes(resolved)) allowedRoots.push(resolved);
      }
    }

    const canEscalateToWrite = !hasAnyDisallowedTool(input.policy, [
      'Write',
      'Edit',
      'MultiEdit',
      'NotebookEdit',
      'NotebookWrite',
    ]);

    async function runStage({ profile, prompt, sessionProfile, enableMcp, toolUseBehavior }) {
      const parallelToolCalls = profile === 'read_only' && allowParallelReadOnlyTurns;
      const defaultPrompt = buildDefaultPrompt({
        projectDir,
        allowedRoots,
        toolUseEnabled,
        profile,
        canEscalateToWrite,
        parallelToolCalls,
      });
      const systemPrompt = buildSystemPrompt(defaultPrompt, input.systemPrompt);
      const promptCacheKey = getSessionKey(requestedSessionId, sessionProfile);

      const client = new OpenAI({
        apiKey: accessToken,
        baseURL: baseUrl,
        fetch: createCodexFetch({
          instructions: systemPrompt,
          reasoningEffort,
          textVerbosity,
          model,
          promptCacheKey,
          parallelToolCalls,
        }),
      });
      const runner = new Runner({
        modelProvider: new OpenAIProvider({
          openAIClient: client,
          useResponses: true,
        }),
      });

      const mcpSession = enableMcp
        ? await connectPolicyMcpServers(input.mcpServers, input.policy)
        : null;
      try {
        const agentConfig = {
          name: 'Coder',
          instructions: systemPrompt,
          model,
        };
        if (toolUseEnabled) {
          agentConfig.tools = createTools(projectDir, allowedRoots, input.policy, profile);
          if (toolUseBehavior) {
            agentConfig.toolUseBehavior = toolUseBehavior;
          }
          if (mcpSession?.active?.length) {
            agentConfig.mcpServers = mcpSession.active;
          }
        }

        const agent = new Agent(agentConfig);
        const { session, id: sessionId } = getOrCreateSession(requestedSessionId, client, model, sessionProfile);
        const result = await runner.run(agent, prompt, { maxTurns, session });
        return { result, sessionId };
      } finally {
        if (mcpSession) {
          try {
            await mcpSession.close();
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            process.stderr.write(`[openai-provider] failed to close MCP session: ${message}\n`);
          }
        }
      }
    }

    if (!toolUseEnabled) {
      const { result, sessionId } = await runStage({
        profile: 'full',
        prompt: input.prompt,
        sessionProfile: 'no_tools',
        enableMcp: false,
      });
      return {
        result: result.finalOutput || '',
        turns: 1,
        costUsd: 0,
        model,
        sessionId,
      };
    }

    if (!readOnlyFirst) {
      const { result, sessionId } = await runStage({
        profile: 'full',
        prompt: input.prompt,
        sessionProfile: 'full',
        enableMcp: true,
      });
      return {
        result: result.finalOutput || '',
        turns: 1,
        costUsd: 0,
        model,
        sessionId,
      };
    }

    const readOnlyStage = await runStage({
      profile: 'read_only',
      prompt: input.prompt,
      sessionProfile: 'read_only',
      enableMcp: false,
      toolUseBehavior: canEscalateToWrite ? { stopAtToolNames: ['request_write_access'] } : undefined,
    });
    const writeAccessReason = canEscalateToWrite
      ? parseWriteAccessRequest(readOnlyStage.result.finalOutput)
      : null;

    if (!writeAccessReason) {
      return {
        result: readOnlyStage.result.finalOutput || '',
        turns: 1,
        costUsd: 0,
        model,
        sessionId: readOnlyStage.sessionId,
      };
    }

    const fullStage = await runStage({
      profile: 'full',
      prompt: `${input.prompt}\n\nWrite-capable tools have been granted for this turn because: ${writeAccessReason}\nContinue and complete the task.`,
      sessionProfile: 'full',
      enableMcp: true,
    });
    return {
      result: fullStage.result.finalOutput || '',
      turns: 2,
      costUsd: 0,
      model,
      sessionId: fullStage.sessionId,
    };
  },
};

export default openaiProvider;
