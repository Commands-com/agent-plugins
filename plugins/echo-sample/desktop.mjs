const MODELS = ['echo-v1', 'echo-v2'];
const STYLES = new Set(['echo', 'uppercase', 'reverse']);

function normalizeString(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

const desktopPlugin = {
  id: 'echo_sample',
  defaultModel: 'echo-v1',

  configSchema: {
    style: {
      type: 'string',
      required: false,
      label: 'Style (echo|uppercase|reverse)',
      default: 'echo',
    },
    prefix: {
      type: 'string',
      required: false,
      label: 'Output Prefix',
      default: '[echo_sample] ',
    },
  },

  async listModels() {
    return { models: MODELS };
  },

  async validate({ config, model } = {}) {
    const selectedModel = normalizeString(model, '').trim();
    if (selectedModel && !MODELS.includes(selectedModel)) {
      return {
        ok: false,
        error: `Unsupported model: ${selectedModel}. Choose one of: ${MODELS.join(', ')}`,
      };
    }

    const styleRaw = normalizeString(config?.style, '').trim().toLowerCase();
    if (styleRaw && !STYLES.has(styleRaw)) {
      return {
        ok: false,
        error: 'Invalid style. Allowed values: echo, uppercase, reverse',
      };
    }

    const prefix = normalizeString(config?.prefix, '');
    if (prefix.length > 120) {
      return {
        ok: false,
        error: 'Prefix must be 120 characters or fewer',
      };
    }

    return { ok: true };
  },
};

export default desktopPlugin;
