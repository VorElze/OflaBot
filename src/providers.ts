// Katalog provider + default model.
// Dropdown model di UI diisi dari API provider (GET /models atau /v1/models),
// jadi user tidak perlu mengetik nama model secara manual.

export type Protocol = 'openai' | 'anthropic';

export type ProviderDef = {
  id: string;
  name: string;
  protocol: Protocol;
  baseUrl: string;
  defaultModel: string;
  hint?: string;
  /** Dipakai kalau provider tidak menyediakan endpoint daftar model. */
  fallbackModels?: string[];
  /** true = tidak butuh API key (mis. Ollama lokal) */
  noKey?: boolean;
};

export const PROVIDERS: ProviderDef[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    protocol: 'openai',
    baseUrl: 'https://api.openai.com',
    defaultModel: 'gpt-4o',
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    defaultModel: 'claude-sonnet-4-20250514',
  },
  {
    id: 'syncera-anthropic',
    name: 'Syncera.id (Anthropic)',
    protocol: 'anthropic',
    baseUrl: 'https://api.syncera.id',
    defaultModel: 'claude-sonnet-4-20250514',
    hint: 'Gateway Syncera.id dengan protokol Anthropic (/v1/messages).',
    fallbackModels: ['claude-sonnet-4-20250514', 'claude-opus-4-20250514', 'claude-3-7-sonnet-20250219'],
  },
  {
    id: 'syncera-codex',
    name: 'Syncera.id (Codex)',
    protocol: 'openai',
    baseUrl: 'https://api.syncera.id/v1',
    defaultModel: 'gpt-5-codex',
    hint: 'Gateway Syncera.id dengan protokol OpenAI (Codex). Base URL bisa diubah sesuai dashboard.',
    fallbackModels: ['gpt-5-codex', 'gpt-5', 'gpt-5-mini', 'o4-mini'],
  },
  {
    id: 'opencode-console',
    name: 'OpenCode Console (Free)',
    protocol: 'openai',
    baseUrl: 'https://opencode.ai/inference/openai/v1',
    defaultModel: '',
    hint: 'Model gratis dari OpenCode Console. API key diambil dari console OpenCode.',
    fallbackModels: ['gpt-luna', 'gemini-flash-lite', 'gemini-flash', 'claude'],
  },
  {
    id: 'opencode-go',
    name: 'opencode-go (Subscription)',
    protocol: 'openai',
    baseUrl: 'https://opencode.ai/inference/openai/v1',
    defaultModel: '',
    hint: 'Model dari langganan opencode-go (gunakan API key langganan).',
    fallbackModels: ['gpt-5', 'claude-sonnet-4-5', 'claude-opus-4-1', 'gemini-2.5-pro'],
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    protocol: 'openai',
    baseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-chat',
  },
  {
    id: 'groq',
    name: 'Groq',
    protocol: 'openai',
    baseUrl: 'https://api.groq.com/openai',
    defaultModel: 'llama-3.3-70b-versatile',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    protocol: 'openai',
    baseUrl: 'https://openrouter.ai/api',
    defaultModel: 'openai/gpt-4o',
  },
  {
    id: 'xai',
    name: 'Grok (xAI)',
    protocol: 'openai',
    baseUrl: 'https://api.x.ai',
    defaultModel: 'grok-2-latest',
  },
  {
    id: 'gemini',
    name: 'Gemini (OpenAI-compat)',
    protocol: 'openai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultModel: 'gemini-2.0-flash',
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    protocol: 'openai',
    baseUrl: 'https://api.minimax.chat/v1',
    defaultModel: 'MiniMax-Text-01',
  },
  {
    id: 'nvidia',
    name: 'NVIDIA NIM',
    protocol: 'openai',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    defaultModel: 'meta/llama-3.1-405b-instruct',
  },
  {
    id: 'nine-router',
    name: '9Router',
    protocol: 'openai',
    baseUrl: '',
    defaultModel: 'developer',
    hint: 'Endpoint 9Router remote. Base URL & key menyesuaikan server Anda.',
    fallbackModels: ['developer', 'combo-fast', 'free-coding', 'free'],
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    defaultModel: 'claude-sonnet-4-20250514',
  },
  {
    id: 'ollama',
    name: 'Ollama (lokal)',
    protocol: 'openai',
    baseUrl: 'http://localhost:11434',
    defaultModel: 'llama3.2',
    noKey: true,
  },
  {
    id: 'custom',
    name: 'Custom (OpenAI-compat)',
    protocol: 'openai',
    baseUrl: '',
    defaultModel: '',
    hint: 'Isi Base URL sendiri. Daftar model dibaca dari {base}/models.',
  },
];

export function getProvider(id: string): ProviderDef {
  return PROVIDERS.find((p) => p.id === id) || PROVIDERS[0];
}

export function isAnthropicLike(id: string): boolean {
  return getProvider(id).protocol === 'anthropic';
}
