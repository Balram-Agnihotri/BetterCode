import { randomUUID } from 'node:crypto';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { WebClient } from '@slack/web-api';
import { loadProjectAgents } from '../agents/agentLoader';
import { loadConfig } from '../config/loadConfig';
import { resolveChannelDecision, resolveAccess, resolveBudgets } from '../config/resolveChannel';
import { recordToolCall } from '../data/audit';
import { claimEvent } from '../data/dedupe';
import { getSecret, materializeSshKey } from '../data/secrets';
import { AnthropicClient } from '../llm/anthropic';
import { OpenAIClient } from '../llm/openai';
import { createLogger } from '../observability/logger';
import { RepoKnowledgeBase } from '../index/repoKnowledgeBase';
import { runJob } from '../orchestrator/orchestrator';
import { SimpleRepoManager } from '../repo/repoManager';
import { BetterCodeError, type FailureCode } from '../types';
import { normalizeEvent } from './normalizeEvent';
import { failureMessage, formatFinalMessage } from './mrkdwn';
import type { SlackEnvelope } from './types';
import { verifySlackSignature } from './verifySignature';

// Deployment note: API Gateway has a 29-second integration timeout; LLM calls
// typically take 30-90 s. Lambda continues running past the 504 that API Gateway
// returns to Slack. The DynamoDB events dedupe table ensures Slack retries are
// no-ops while the original invocation finishes and posts the answer.
// For a cleaner setup with no 504s, use a Lambda Function URL (no integration
// timeout) instead of API Gateway.

const log = createLogger({ mod: 'handler' });

const ack = (body: Record<string, unknown> = { ok: true }): APIGatewayProxyResult => ({
  statusCode: 200,
  body: JSON.stringify(body),
});

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const cfg = await loadConfig();
  const headers = lowerHeaders(event.headers);
  const rawBody =
    event.isBase64Encoded && event.body
      ? Buffer.from(event.body, 'base64').toString('utf8')
      : (event.body ?? '');

  // 1. Verify Slack HMAC signature (timing-safe, ±300 s replay window).
  const signingSecret = await resolveSigningSecret(cfg.slack.signingSecretEnv);
  const valid = verifySlackSignature({
    signingSecret,
    signature: headers['x-slack-signature'],
    timestamp: headers['x-slack-request-timestamp'],
    rawBody,
  });
  if (!valid) {
    log.warn({}, 'rejected request with invalid Slack signature');
    return { statusCode: 401, body: 'invalid signature' };
  }

  let envelope: SlackEnvelope;
  try {
    envelope = JSON.parse(rawBody) as SlackEnvelope;
  } catch {
    return { statusCode: 400, body: 'bad json' };
  }

  // 2. URL verification handshake.
  if (envelope.type === 'url_verification') {
    return { statusCode: 200, headers: { 'content-type': 'text/plain' }, body: envelope.challenge ?? '' };
  }
  if (envelope.type !== 'event_callback' || !envelope.event_id) return ack();

  // 3. Dedupe Slack retries (lightweight conditional Put on the events table).
  if (!(await claimEvent(envelope.event_id))) {
    log.info({ eventId: envelope.event_id }, 'duplicate event ignored');
    return ack();
  }

  // 4. Normalize + routing decision.
  const norm = normalizeEvent(envelope);
  if (!norm) return ack();
  if (!norm.isAppMention && norm.mentionsBot) return ack(); // drop message-typed duplicate

  const decision = resolveChannelDecision(cfg, {
    channelId: norm.channelId,
    isAppMention: norm.isAppMention,
    isBot: norm.isBot,
    subtype: norm.subtype,
    text: norm.text,
  });
  if (!decision.answer) {
    log.debug({ reason: decision.rejectReason, channel: norm.channelId }, 'not answering');
    return ack();
  }

  const project = cfg.projects[decision.project];
  if (!project) {
    log.error({ project: decision.project }, 'project not found in config');
    return ack();
  }

  // 5. Resolve Slack bot token and run inline.
  const jobId = randomUUID();
  const channelId = norm.channelId;
  const threadTs = norm.threadTs;
  log.info({ jobId, channel: channelId, project: decision.project, agent: decision.agent }, 'processing inline');

  const slack = new WebClient(await getSecret(cfg.slack.botTokenSecretName));

  try {
    const registry = await loadProjectAgents(project.agentDir, project.subagents);
    if (!registry.has(decision.agent)) {
      throw new BetterCodeError('INTERNAL', `agent "${decision.agent}" not found in project`);
    }

    const sshKeyPath = await resolveSshKey(project.repoUrl);
    const repo = new SimpleRepoManager(process.env.REPO_CACHE_ROOT ?? '/tmp/bettercode', log);
    const snapshot = await repo.getSnapshot(decision.project, project, { sshKeyPath });

    const knowledgeBase = await RepoKnowledgeBase.buildOrLoad(snapshot, resolveAccess(cfg, project));

    const apiKey = await getSecret(cfg.llm.apiKeySecretName);
    const llm = cfg.llm.provider === 'openai' ? new OpenAIClient(apiKey) : new AnthropicClient(apiKey);
    const answer = await runJob({
      jobId,
      question: norm.text,
      agentName: decision.agent,
      snapshot,
      registry,
      access: resolveAccess(cfg, project),
      budgets: resolveBudgets(cfg, decision.channel),
      cfg,
      llm,
      logger: log.child({ jobId }),
      recordAudit: recordToolCall,
      knowledgeBase,
    });

    const text = formatFinalMessage(answer, cfg.budgets.maxSlackChars);
    await slack.chat.postMessage({ channel: channelId, thread_ts: threadTs, text });
    log.info({ jobId, usage: answer.usage, sha: snapshot.commitSha }, 'job succeeded');
  } catch (err) {
    const code: FailureCode = err instanceof BetterCodeError ? err.code : 'INTERNAL';
    log.error({ jobId, err: (err as Error).message, code }, 'job failed');
    try {
      await slack.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: failureMessage(code) });
    } catch {
      /* best effort */
    }
  }

  return ack();
}

function lowerHeaders(headers: APIGatewayProxyEvent['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers ?? {})) {
    if (typeof v === 'string') out[k.toLowerCase()] = v;
  }
  return out;
}

async function resolveSigningSecret(envVarName: string): Promise<string> {
  const fromEnv = process.env[envVarName];
  if (fromEnv) return fromEnv;
  const secretName = process.env.SLACK_SIGNING_SECRET_SECRET_NAME;
  if (secretName) return getSecret(secretName);
  return '';
}

async function resolveSshKey(repoUrl: string): Promise<string | undefined> {
  const secretName = process.env.GITHUB_DEPLOY_KEY_SECRET_NAME;
  if (!repoUrl.startsWith('git@') || !secretName) return undefined;
  return materializeSshKey(secretName);
}
