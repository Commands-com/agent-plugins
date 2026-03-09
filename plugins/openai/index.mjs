/**
 * OpenAI provider plugin — agent-side ProviderPlugin.
 *
 * Uses Codex OAuth (from ~/.codex/auth.json) with the @openai/agents SDK
 * and a custom fetch adapter that injects:
 *   store: false, stream: true, reasoning: { effort: 'xhigh' }
 *
 * Provides file-system tools scoped to input.cwd and policy.allowedCwdRoots.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import OpenAI from 'openai';
import {
  Agent,
  run,
  tool,
  setDefaultOpenAIClient,
  MCPServerStdio,
  MCPServerStreamableHttp,
  MCPServerSSE,
  connectMcpServers,
  createMCPToolStaticFilter,
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

function getOrCreateSession(sessionId, client, model) {
  if (sessionId && sessions.has(sessionId)) {
    return { session: sessions.get(sessionId), id: sessionId };
  }
  const id = sessionId || `openai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  evictOldestSession();
  const session = new OpenAIResponsesCompactionSession({
    client, model,
    compactionMode: 'input',  // Force input-based compaction; store: false means responses aren't persisted
    shouldTriggerCompaction: ({ sessionItems }) => {
      const estimatedTokens = estimateTokensFromItems(sessionItems);
      return estimatedTokens >= COMPACT_TOKEN_THRESHOLD;
    },
  });
  sessions.set(id, session);
  return { session, id };
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

function createCodexFetch(instructions) {
  return async (url, init) => {
    // Only intercept /responses calls (the Agents SDK endpoint)
    if (typeof url === 'string' && !url.includes('/responses')) {
      return globalThis.fetch(url, init);
    }

    // Handle /responses/compact separately — don't inject stream/reasoning,
    // do inject the required `instructions` field, and return JSON directly.
    const isCompact = typeof url === 'string' && url.includes('/responses/compact');

    if (typeof init?.body === 'string') {
      try {
        const b = JSON.parse(init.body);
        if (isCompact) {
          // Compact endpoint requires `instructions`; SDK doesn't send it
          if (!b.instructions && instructions) {
            b.instructions = instructions;
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
          b.reasoning = { effort: 'xhigh' };
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
function createTools(projectDir, allowedRoots, policy) {
  const safePath = createSafePath(projectDir, allowedRoots);
  const multiRoot = allowedRoots.length > 1;
  const pathDesc = multiRoot
    ? 'Path (relative to primary project root, or absolute path within any allowed directory)'
    : 'Relative path within the project';

  const listFiles = tool({
    name: 'list_files',
    description: `List files and directories at a path. Returns names with / suffix for directories.${multiRoot ? ' Accepts absolute paths to any allowed directory.' : ''}`,
    parameters: z.object({
      path: z.string().default('.').describe(pathDesc),
    }),
    execute: async ({ path: relPath }) => {
      const target = safePath(relPath);
      const entries = fs.readdirSync(target, { withFileTypes: true });
      return entries
        .map(e => e.isDirectory() ? e.name + '/' : e.name)
        .join('\n');
    },
  });

  const readFile = tool({
    name: 'read_file',
    description: `Read the contents of a file. Returns the file text.${multiRoot ? ' Accepts absolute paths to any allowed directory.' : ''}`,
    parameters: z.object({
      path: z.string().describe(pathDesc),
    }),
    execute: async ({ path: relPath }) => {
      const target = safePath(relPath);
      return fs.readFileSync(target, 'utf8');
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
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
      return `Wrote ${content.length} bytes to ${relPath}`;
    },
  });

  const searchFiles = tool({
    name: 'search_files',
    description: `Search for a text pattern (regex) across files. Returns matching file paths and line numbers.${multiRoot ? ' Searches all allowed directories.' : ''}`,
    parameters: z.object({
      pattern: z.string().describe('Regex pattern to search for'),
      glob: z.string().default('*').describe('File glob pattern to filter (e.g. "*.js", "**/*.ts")'),
    }),
    execute: async ({ pattern, glob: globPattern }) => {
      const allResults = [];

      if (process.platform === 'win32') {
        // Pure JS fallback — grep is not available on Windows
        let re;
        try { re = new RegExp(pattern); } catch { return `Invalid regex pattern: ${pattern}`; }
        const globRe = new RegExp(
          '^' + globPattern.replace(/\./g, '\\.').replace(/\*\*/g, '{{GLOBSTAR}}').replace(/\*/g, '[^/]*').replace(/\?/g, '.').replace(/\{\{GLOBSTAR\}\}/g, '.*') + '$'
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
            const result = execFileSync(
              'grep',
              ['-rn', `--include=${globPattern}`, pattern, '.'],
              { cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 10000 },
            );
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

  // Allowed command prefixes for run_command — read-only and build/test commands only.
  // Commands not matching these prefixes are rejected.
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
  const runCommandDescription = policy
    ? (shellAllowSummary
      ? `Run one non-interactive command allowed by the permission profile. Allowed command prefixes include: ${shellAllowSummary}.`
      : 'Run one non-interactive command, constrained by the permission profile.')
    : (isFullProfileWithoutPolicy
      ? 'Run one non-interactive command in the project directory. Full Access profile detected, so command-prefix allowlist checks are not applied.'
      : 'Run an allowed command in the project directory (no shell). Permitted: build, test, lint, git read-only, file inspection. Destructive or network commands are blocked.');

  function isCommandAllowed(cmd) {
    const trimmed = cmd.trim();
    return ALLOWED_COMMANDS.some(prefix => {
      if (trimmed === prefix) return true;
      if (trimmed.startsWith(prefix + ' ')) return true;
      return false;
    });
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
      if (!policy && !isFullProfileWithoutPolicy && !isCommandAllowed(trimmedCommand)) {
        return `Command not allowed. Only read-only and build/test commands are permitted. Allowed prefixes: ${ALLOWED_COMMANDS.slice(0, 10).join(', ')}, ...`;
      }

      try {
        const [program, ...args] = argv;
        if (!program) {
          return 'Command rejected: command cannot be empty.';
        }
        // Validate that file-reading commands cannot access paths outside allowed roots
        validatePathArgs(program, args);
        const result = execFileSync(program, args, {
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
        if (err.message && err.message.includes('escapes allowed directories')) {
          return `Command rejected: ${err.message}`;
        }
        return `Exit code ${err.status || 1}\nstdout: ${err.stdout || ''}\nstderr: ${err.stderr || ''}`.trim();
      }
    },
  });

  const tools = [listFiles, readFile];

  const writeIsDisallowed = hasAnyDisallowedTool(policy, [
    'Write',
    'Edit',
    'MultiEdit',
    'NotebookEdit',
    'NotebookWrite',
  ]);
  if (!writeIsDisallowed) {
    tools.push(writeFile);
  }

  tools.push(searchFiles);

  const bashIsDisallowed = hasDisallowedTool(policy, 'Bash');
  if (!bashIsDisallowed) {
    tools.push(runCommand);
  }

  return tools;
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

    // Build the full set of allowed roots from policy (if available)
    const allowedRoots = [projectDir];
    if (input.policy?.allowedCwdRoots?.length) {
      for (const root of input.policy.allowedCwdRoots) {
        const resolved = path.resolve(root);
        if (!allowedRoots.includes(resolved)) allowedRoots.push(resolved);
      }
    }

    // Build system prompt before client so we can pass it to the fetch adapter
    // for /responses/compact calls (Codex requires `instructions` on compact)
    let defaultPrompt;
    if (allowedRoots.length > 1) {
      const dirList = allowedRoots.map((r) => `  - ${r}`).join('\n');
      defaultPrompt = `You are a coding assistant with access to multiple project directories:\n${dirList}\n\nYour primary working directory is: ${projectDir}\nRelative paths resolve against the primary directory. Use absolute paths to access other directories.\nYou can list files, read files, write files, search for patterns, and run shell commands.\nAlways explore the project structure before making changes.\nWhen editing files, read them first to understand the context.\nKeep responses concise and focused on the task.`;
    } else {
      defaultPrompt = `You are a coding assistant with access to a project directory at: ${projectDir}\n\nYou can list files, read files, write files, search for patterns, and run shell commands.\nAlways explore the project structure before making changes.\nWhen editing files, read them first to understand the context.\nKeep responses concise and focused on the task.`;
    }
    const systemPrompt = input.systemPrompt || defaultPrompt;

    // Set up OpenAI client with Codex fetch adapter
    const client = new OpenAI({
      apiKey: accessToken,
      baseURL: baseUrl,
      fetch: createCodexFetch(systemPrompt),
    });
    setDefaultOpenAIClient(client);

    const mcpSession = await connectPolicyMcpServers(input.mcpServers, input.policy);
    try {
      // Build agent with file-system tools scoped to allowed directories
      const tools = createTools(projectDir, allowedRoots, input.policy);

      const agent = new Agent({
        name: 'Coder',
        instructions: systemPrompt,
        model,
        tools,
        ...(mcpSession?.active?.length ? { mcpServers: mcpSession.active } : {}),
      });

      // Use SDK compaction session for conversation history management + auto-compaction
      const { session, id: sessionId } = getOrCreateSession(input.resumeSessionId, client, model);

      // Run the agent — pass maxTurns from input so room fan-out's
      // max_tool_rounds constraint is respected (SDK defaults to 10).
      const maxTurns = input.maxTurns && input.maxTurns > 0 ? input.maxTurns : 500;
      const result = await run(agent, input.prompt, { maxTurns, session });

      return {
        result: result.finalOutput || '',
        turns: 1,
        costUsd: 0,
        model,
        sessionId,
      };
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
  },
};

export default openaiProvider;
