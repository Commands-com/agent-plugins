/**
 * Gemini provider plugin — desktop-side.
 *
 * Provides config schema, model listing, validation, and env building
 * for the Electron desktop app.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_MODEL = 'gemini-3.1-pro-preview';

/**
 * Check if Gemini CLI OAuth credentials exist at ~/.gemini/oauth_creds.json.
 */
async function hasGeminiAuth() {
  try {
    const credsPath = path.join(os.homedir(), '.gemini', 'oauth_creds.json');
    const credsData = await fs.promises.readFile(credsPath, 'utf8');
    const creds = JSON.parse(credsData);
    return !!creds.access_token && !!creds.refresh_token;
  } catch {
    return false;
  }
}

export default {
  id: 'gemini',
  apiVersion: '1',
  defaultModel: DEFAULT_MODEL,

  configSchema: {
    apiKey: {
      type: 'secret',
      required: false,
      label: 'API Key (optional — falls back to Gemini CLI OAuth)',
    },
  },

  /**
   * List available models.
   */
  async listModels(_config) {
    return {
      models: [
        'gemini-3.1-pro-preview',
        'gemini-2.5-flash',
        'gemini-2.0-flash',
      ],
    };
  },

  /**
   * Validate provider configuration.
   * Checks that either an API key is provided or Gemini CLI OAuth is available.
   */
  async validate({ config, model }) {
    if (config?.apiKey && typeof config.apiKey === 'string' && config.apiKey.trim().length > 0) {
      return { ok: true };
    }

    if (await hasGeminiAuth()) {
      return { ok: true };
    }

    return {
      ok: false,
      error: 'No API key provided and no Gemini CLI OAuth token found. Either enter an API key or run `gemini` and sign in.',
    };
  },

  /**
   * Build environment variables for the agent process.
   */
  buildEnv(config, profile) {
    const env = {
      PROVIDER: 'gemini',
      MODEL: profile?.model || DEFAULT_MODEL,
    };

    if (config?.apiKey) {
      env.PROVIDER_GEMINI_API_KEY = config.apiKey;
    }

    return env;
  },
};
