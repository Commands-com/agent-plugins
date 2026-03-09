/**
 * OpenAI provider plugin — desktop-side.
 *
 * Provides config schema, model listing, validation, and env building
 * for the Electron desktop app.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_BASE_URL = 'https://chatgpt.com/backend-api/codex';
const DEFAULT_MODEL = 'gpt-5.4';

/**
 * Check if Codex OAuth token exists at ~/.codex/auth.json.
 */
function hasCodexAuth() {
  try {
    const authPath = path.join(os.homedir(), '.codex', 'auth.json');
    const auth = JSON.parse(fs.readFileSync(authPath, 'utf8'));
    return !!auth.tokens?.access_token;
  } catch {
    return false;
  }
}

export default {
  id: 'openai',
  apiVersion: '1',
  defaultModel: DEFAULT_MODEL,

  configSchema: {
    apiKey: {
      type: 'secret',
      required: false,
      label: 'API Key (optional — falls back to Codex OAuth)',
    },
    baseUrl: {
      type: 'url',
      required: false,
      label: 'Base URL',
      default: DEFAULT_BASE_URL,
    },
  },

  /**
   * List available models.
   * Returns a static list since the Codex endpoint doesn't expose a models API.
   */
  async listModels(_config) {
    return {
      models: [
        'gpt-5.4',
      ],
    };
  },

  /**
   * Validate provider configuration.
   * Checks that either an API key is provided or Codex OAuth is available.
   */
  async validate({ config, model }) {
    // Check for an explicit API key first
    if (config?.apiKey && typeof config.apiKey === 'string' && config.apiKey.trim().length > 0) {
      return { ok: true };
    }

    // Fall back to Codex OAuth
    if (hasCodexAuth()) {
      return { ok: true };
    }

    return {
      ok: false,
      error: 'No API key provided and no Codex OAuth token found. Either enter an API key or run `codex` and sign in.',
    };
  },

  /**
   * Build environment variables for the agent process.
   */
  buildEnv(config, profile) {
    const env = {
      PROVIDER: 'openai',
      MODEL: profile?.model || DEFAULT_MODEL,
    };

    if (config?.apiKey) {
      env.PROVIDER_OPENAI_API_KEY = config.apiKey;
    }

    if (config?.baseUrl) {
      env.PROVIDER_OPENAI_BASE_URL = config.baseUrl;
    }

    return env;
  },
};
