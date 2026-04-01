import * as crypto from 'node:crypto';
import { listWebhookConfigs, type WebhookConfigRow } from './db.js';

// ─── Types ───

export type WebhookEvent =
  | 'agent.created'
  | 'agent.revoked'
  | 'agent.delegated'
  | 'policy.denied'
  | 'human.deprovisioned';

export interface WebhookConfig {
  url: string;
  events: WebhookEvent[];
  secret: string;
  enabled: boolean;
}

export interface WebhookPayload {
  event: WebhookEvent;
  timestamp: string;
  org_id: string;
  data: Record<string, unknown>;
}

interface RetryEntry {
  config: WebhookConfigRow;
  payload: WebhookPayload;
  attempt: number;
  nextRetryAt: number;
}

// ─── Retry Queue ───

const RETRY_DELAYS_MS = [1000, 5000, 25000];
const MAX_RETRIES = 3;

const retryQueue: RetryEntry[] = [];
let retryTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Compute HMAC-SHA256 signature of the payload body.
 */
export function computeSignature(body: string, secret: string): string {
  return crypto
    .createHmac('sha256', secret)
    .update(body, 'utf8')
    .digest('hex');
}

/**
 * Send a single webhook delivery with HMAC signature.
 */
export async function sendWebhook(
  config: WebhookConfigRow,
  event: WebhookEvent,
  payload: WebhookPayload,
): Promise<boolean> {
  const body = JSON.stringify(payload);
  const signature = computeSignature(body, config.secret);

  try {
    const response = await fetch(config.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Eigent-Signature': signature,
        'X-Eigent-Event': event,
      },
      body,
      signal: AbortSignal.timeout(10000),
    });

    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Enqueue a webhook delivery with retry support.
 */
async function deliverWithRetry(
  config: WebhookConfigRow,
  payload: WebhookPayload,
  attempt: number = 0,
): Promise<void> {
  const success = await sendWebhook(config, payload.event, payload);

  if (!success && attempt < MAX_RETRIES) {
    const delay = RETRY_DELAYS_MS[attempt] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
    retryQueue.push({
      config,
      payload,
      attempt: attempt + 1,
      nextRetryAt: Date.now() + delay,
    });
    ensureRetryTimer();
  }
}

function ensureRetryTimer(): void {
  if (retryTimer) return;
  retryTimer = setInterval(processRetryQueue, 1000);
}

async function processRetryQueue(): Promise<void> {
  const now = Date.now();
  const ready: RetryEntry[] = [];
  const remaining: RetryEntry[] = [];

  for (const entry of retryQueue) {
    if (entry.nextRetryAt <= now) {
      ready.push(entry);
    } else {
      remaining.push(entry);
    }
  }

  retryQueue.length = 0;
  retryQueue.push(...remaining);

  for (const entry of ready) {
    await deliverWithRetry(entry.config, entry.payload, entry.attempt);
  }

  if (retryQueue.length === 0 && retryTimer) {
    clearInterval(retryTimer);
    retryTimer = null;
  }
}

/**
 * Fire webhooks for all matching configs in an org.
 */
export async function fireWebhooks(
  orgId: string,
  event: WebhookEvent,
  data: Record<string, unknown>,
): Promise<void> {
  const configs = listWebhookConfigs(orgId);

  const payload: WebhookPayload = {
    event,
    timestamp: new Date().toISOString(),
    org_id: orgId,
    data,
  };

  for (const config of configs) {
    if (!config.enabled) continue;

    const events: string[] = JSON.parse(config.events);
    if (!events.includes(event)) continue;

    // Fire and forget with retry
    deliverWithRetry(config, payload).catch(() => {
      // Silently handle — retries will take care of it
    });
  }
}

/**
 * Send a test webhook event to verify configuration.
 */
export async function sendTestWebhook(config: WebhookConfigRow): Promise<boolean> {
  const payload: WebhookPayload = {
    event: 'agent.created',
    timestamp: new Date().toISOString(),
    org_id: config.org_id,
    data: {
      test: true,
      message: 'This is a test webhook from Eigent',
      config_id: config.id,
    },
  };

  return sendWebhook(config, 'agent.created', payload);
}

/**
 * Stop the retry timer (for cleanup in tests).
 */
export function stopRetryTimer(): void {
  if (retryTimer) {
    clearInterval(retryTimer);
    retryTimer = null;
  }
  retryQueue.length = 0;
}
