// Runtime configuration from environment (written by install.sh to /etc/myassistant/env).
// No secrets live here: keys and tokens are stored encrypted in the database.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const APP_DIR = path.resolve(here, '..');
export const VERSION = fs.readFileSync(path.join(APP_DIR, 'VERSION'), 'utf8').trim();

const env = process.env;
export const cfg = {
  dataDir: env.MA_DATA_DIR || '/var/lib/myassistant',
  port: parseInt(env.MA_PORT || '8787', 10),
  host: env.MA_HOST || '127.0.0.1',
  publicUrl: (env.MA_PUBLIC_URL || 'http://127.0.0.1:8787').replace(/\/+$/, ''),
  workspace: env.MA_WORKSPACE || '/srv/myassistant/workspace',
  sitesDir: env.MA_SITES_DIR || '/srv/myassistant/sites',
  sandboxUser: env.MA_SANDBOX_USER === undefined ? 'ma-run' : env.MA_SANDBOX_USER,
  updateUnit: env.MA_UPDATE_UNIT || 'myassistant-update.service',
  releaseBase: (env.MA_RELEASE_BASE || 'https://abish-assistant-v2.sites.tab.bot').replace(/\/+$/, ''),
  testMode: env.MA_TEST_MODE === '1',
  mockModule: env.MA_MOCK_MODULE || '',
  googleBase: env.MA_GOOGLE_BASE || '',     // test override for all Google endpoints
  geminiBase: env.MA_GEMINI_BASE || '',   // test override
  telegramBase: env.MA_TELEGRAM_BASE || 'https://api.telegram.org',
  graphBase: env.MA_GRAPH_BASE || 'https://graph.facebook.com',
  sshBin: env.MA_SSH_BIN || 'ssh',
  tickMs: parseInt(env.MA_TICK_MS || '20000', 10),
  // WhatsApp Agent Platform (2.2). The test knobs only exist so tests do not wait a real minute.
  waAgentBase: env.MA_WA_AGENT_BASE || 'https://api.whatsapp.com/agent/v1',
  waAgentPollTimeout: env.MA_WA_AGENT_POLL_TIMEOUT ? parseInt(env.MA_WA_AGENT_POLL_TIMEOUT, 10) : 20,
  waAgentMinIntervalMs: env.MA_WA_AGENT_MIN_INTERVAL_MS ? parseInt(env.MA_WA_AGENT_MIN_INTERVAL_MS, 10) : undefined,
  waAgentWindowMs: env.MA_WA_AGENT_WINDOW_MS ? parseInt(env.MA_WA_AGENT_WINDOW_MS, 10) : 60000,
  waAgentBackoffMs: env.MA_WA_AGENT_BACKOFF_MS ? parseInt(env.MA_WA_AGENT_BACKOFF_MS, 10) : 2000,
  waAgentConflictMs: env.MA_WA_AGENT_CONFLICT_MS ? parseInt(env.MA_WA_AGENT_CONFLICT_MS, 10) : 60000,
};
export function isHttps() { return cfg.publicUrl.startsWith('https://'); }
export function publicHost() { try { return new URL(cfg.publicUrl).host; } catch { return 'localhost'; } }
