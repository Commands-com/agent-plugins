const SUPPORTED_STYLES = new Set(['echo', 'uppercase', 'reverse']);

const sessionStore = new Map();

function normalizeString(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function getConfigValue(config, key, fallback = '') {
  if (!config || typeof config !== 'object') return fallback;
  const candidates = [
    key,
    key.toUpperCase(),
    key.toLowerCase(),
  ];
  for (const candidate of candidates) {
    const value = config[candidate];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return fallback;
}

function applyStyle(input, style) {
  switch (style) {
    case 'uppercase':
      return input.toUpperCase();
    case 'reverse':
      return [...input].reverse().join('');
    case 'echo':
    default:
      return input;
  }
}

function createSessionId() {
  return `echo_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

const provider = {
  id: 'echo_sample',
  name: 'Echo Sample',
  defaultModel: 'echo-v1',
  capabilities: {
    supportsTools: false,
    supportsSessionResume: true,
    supportsPolicy: false,
  },

  async runPrompt(input) {
    const prompt = normalizeString(input.prompt, '');
    const styleRaw = getConfigValue(input.providerConfig, 'STYLE', 'echo').trim().toLowerCase();
    const style = SUPPORTED_STYLES.has(styleRaw) ? styleRaw : 'echo';
    const prefix = getConfigValue(input.providerConfig, 'PREFIX', '[echo_sample] ');

    const resumedId = normalizeString(input.resumeSessionId, '').trim();
    const sessionId = resumedId && sessionStore.has(resumedId) ? resumedId : createSessionId();

    const previous = sessionStore.get(sessionId) || { turns: 0 };
    const turns = previous.turns + 1;

    const transformed = applyStyle(prompt, style);
    const resultText = `${prefix}${transformed}`;

    sessionStore.set(sessionId, {
      turns,
      lastPrompt: prompt,
      lastResult: resultText,
      model: normalizeString(input.model, provider.defaultModel),
      updatedAt: Date.now(),
    });

    return {
      result: resultText,
      turns,
      costUsd: 0,
      model: normalizeString(input.model, provider.defaultModel),
      sessionId,
    };
  },
};

export default provider;
