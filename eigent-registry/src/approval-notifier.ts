/**
 * Approval notification system for Eigent.
 *
 * Sends notifications when approval requests are created.
 * Supports webhook (generic), Slack (Block Kit), and email (placeholder) channels.
 */

export type NotificationChannel = 'webhook' | 'slack' | 'email';

export interface ApprovalNotification {
  approval_id: string;
  agent_id: string;
  agent_name: string;
  tool_name: string;
  arguments_hash: string;
  human_email: string;
  delegation_chain: string[];
  registry_url: string;
  expires_at: string;
}

export interface NotifierConfig {
  channels: NotificationChannel[];
  webhook_url?: string;
  slack_webhook_url?: string;
  slack_signing_secret?: string;
  email_from?: string;
  email_to?: string;
  registry_url: string;
}

/**
 * Build a Slack Block Kit message for an approval request.
 */
export function buildSlackBlockKit(notification: ApprovalNotification): Record<string, unknown> {
  const chainStr = notification.delegation_chain.join(' -> ');

  return {
    text: `Approval required: ${notification.agent_name} wants to call ${notification.tool_name}`,
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: 'Eigent Approval Request',
          emoji: true,
        },
      },
      {
        type: 'section',
        fields: [
          {
            type: 'mrkdwn',
            text: `*Agent:*\n${notification.agent_name}`,
          },
          {
            type: 'mrkdwn',
            text: `*Tool:*\n\`${notification.tool_name}\``,
          },
          {
            type: 'mrkdwn',
            text: `*Human Owner:*\n${notification.human_email}`,
          },
          {
            type: 'mrkdwn',
            text: `*Arguments Hash:*\n\`${notification.arguments_hash.slice(0, 12)}...\``,
          },
        ],
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Delegation Chain:*\n${chainStr}`,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Expires:* ${notification.expires_at}`,
        },
      },
      {
        type: 'actions',
        block_id: `approval_${notification.approval_id}`,
        elements: [
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: 'Approve',
              emoji: true,
            },
            style: 'primary',
            action_id: 'approve_action',
            value: notification.approval_id,
          },
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: 'Deny',
              emoji: true,
            },
            style: 'danger',
            action_id: 'deny_action',
            value: notification.approval_id,
          },
        ],
      },
    ],
  };
}

/**
 * Build a generic webhook payload for an approval request.
 */
export function buildWebhookPayload(notification: ApprovalNotification): Record<string, unknown> {
  return {
    event: 'approval_requested',
    approval_id: notification.approval_id,
    agent_id: notification.agent_id,
    agent_name: notification.agent_name,
    tool_name: notification.tool_name,
    arguments_hash: notification.arguments_hash,
    human_email: notification.human_email,
    delegation_chain: notification.delegation_chain,
    expires_at: notification.expires_at,
    approve_url: `${notification.registry_url}/api/v1/approvals/${notification.approval_id}/approve`,
    deny_url: `${notification.registry_url}/api/v1/approvals/${notification.approval_id}/deny`,
  };
}

/**
 * Send notifications for an approval request across all configured channels.
 */
export async function sendApprovalNotification(
  config: NotifierConfig,
  notification: ApprovalNotification,
): Promise<{ channel: NotificationChannel; success: boolean; error?: string }[]> {
  const results: { channel: NotificationChannel; success: boolean; error?: string }[] = [];

  for (const channel of config.channels) {
    try {
      switch (channel) {
        case 'webhook':
          await sendWebhookNotification(config, notification);
          results.push({ channel, success: true });
          break;

        case 'slack':
          await sendSlackNotification(config, notification);
          results.push({ channel, success: true });
          break;

        case 'email':
          // Email is a placeholder -- log intent
          results.push({
            channel,
            success: false,
            error: 'Email notification not yet implemented. Configure SMTP to enable.',
          });
          break;
      }
    } catch (err) {
      results.push({
        channel,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}

async function sendWebhookNotification(
  config: NotifierConfig,
  notification: ApprovalNotification,
): Promise<void> {
  if (!config.webhook_url) {
    throw new Error('webhook_url not configured');
  }

  const payload = buildWebhookPayload(notification);

  const response = await fetch(config.webhook_url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(`Webhook returned HTTP ${response.status}`);
  }
}

async function sendSlackNotification(
  config: NotifierConfig,
  notification: ApprovalNotification,
): Promise<void> {
  if (!config.slack_webhook_url) {
    throw new Error('slack_webhook_url not configured');
  }

  const payload = buildSlackBlockKit(notification);

  const response = await fetch(config.slack_webhook_url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(`Slack webhook returned HTTP ${response.status}`);
  }
}

/**
 * Parse a Slack interactive payload (button click) and extract the action.
 */
export function parseSlackAction(body: Record<string, unknown>): {
  approval_id: string;
  action: 'approve' | 'deny';
  user_id: string;
  user_name: string;
} | null {
  const payload = body.payload ? JSON.parse(body.payload as string) : body;
  const actions = payload.actions as Array<{
    action_id: string;
    value: string;
  }> | undefined;

  if (!actions || actions.length === 0) return null;

  const slackAction = actions[0];
  const user = payload.user as { id: string; name: string } | undefined;

  let actionType: 'approve' | 'deny';
  if (slackAction.action_id === 'approve_action') {
    actionType = 'approve';
  } else if (slackAction.action_id === 'deny_action') {
    actionType = 'deny';
  } else {
    return null;
  }

  return {
    approval_id: slackAction.value,
    action: actionType,
    user_id: user?.id ?? 'unknown',
    user_name: user?.name ?? 'unknown',
  };
}
