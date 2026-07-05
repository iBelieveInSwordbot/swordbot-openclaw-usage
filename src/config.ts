import 'dotenv/config';
import os from 'node:os';
import path from 'node:path';

function expandHome(p: string): string {
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  if (p === '~') return os.homedir();
  return p;
}

export interface Config {
  port: number;
  dataDir: string;
  openclawRoot: string;
  scanIntervalMs: number;
  useLocalPricing: boolean;
  slackWebhookUrl: string | null;
}

export function loadConfig(): Config {
  return {
    port: parseInt(process.env.PORT || '4848', 10),
    dataDir: expandHome(process.env.DATA_DIR || './data'),
    openclawRoot: expandHome(process.env.OPENCLAW_ROOT || '~/.openclaw'),
    scanIntervalMs: parseInt(process.env.SCAN_INTERVAL_MS || '30000', 10),
    useLocalPricing: (process.env.USE_LOCAL_PRICING ?? 'true').toLowerCase() !== 'false',
    slackWebhookUrl: process.env.SLACK_WEBHOOK_URL || null,
  };
}
