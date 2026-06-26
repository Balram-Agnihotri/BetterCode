// This SQS worker is the old async-queue entry point and is not used in the
// current single-Lambda setup. It is kept compilable for reference.

import { WebClient } from '@slack/web-api';
import type { SQSBatchResponse, SQSEvent, SQSRecord } from 'aws-lambda';
import { loadProjectAgents } from '../agents/agentLoader';
import { loadConfig } from '../config/loadConfig';
import { resolveAccess, resolveBudgets } from '../config/resolveChannel';
import { recordToolCall } from '../data/audit';
import { getJob, updateJob } from '../data/jobStore';
import { getSecret, materializeSshKey } from '../data/secrets';
import { AnthropicClient } from '../llm/anthropic';
import { OpenAIClient } from '../llm/openai';
import { createLogger } from '../observability/logger';
import { runJob } from '../orchestrator/orchestrator';
import { SimpleRepoManager } from '../repo/repoManager';
import { SlackResponder } from '../slack/responder';
import { BetterCodeError, type FailureCode, type JobStatus } from '../types';
import { parseJobMessage } from './messages';

const MAX_ATTEMPTS = 3;

/**
 * Async worker (SQS -> Lambda). Uses partial-batch responses so only failed
 * messages are retried. Each record is processed idempotently and answered
 * exactly once.
 */
export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const batchItemFailures: { itemIdentifier: string }[] = [];
  for (const record of event.Records) {
    const shouldRetry = await processRecord(record);
    if (shouldRetry) batchItemFailures.push({ itemIdentifier: record.messageId });
  }
  return { batchItemFailures };
}

/** Returns true if SQS should redeliver (transient failure, attempts remain). */
async function processRecord(record: SQSRecord): Promise<boolean> {
  const cfg = await loadConfig();
  let job;
  try {
    job = parseJobMessage(record.body);
  } catch (err) {
    createLogger({ mod: 'worker' }).error({ err: (err as Error).message }, 'unparseable record dropped');
    return false; // poison message: don't retry forever
  }

  const logger = createLogger({ jobId: job.jobId, channel: job.channelId, project: job.project });
  const attempt = Number(record.attributes?.ApproximateReceiveCount ?? '1');

  const existing = await getJob(job.jobId);
  if (existing?.status === 'succeeded') {
    logger.info({}, 'job already answered; skipping');
    return false;
  }

  const project = cfg.projects[job.project];
  const channel = cfg.channels[job.channelId];
  if (!project || !channel) {
    logger.error({}, 'job references missing project/channel config');
    return false;
  }

  const slack = new WebClient(await getSecret(cfg.slack.botTokenSecretName));
  const responder = new SlackResponder(slack, cfg, logger);

  try {
    await updateJob(job.jobId, { status: 'running' });

    const registry = await loadProjectAgents(project.agentDir, project.subagents);
    if (!registry.has(job.agent)) {
      throw new BetterCodeError('INTERNAL', `agent "${job.agent}" not found in project`);
    }

    const sshKeyPath = await resolveSshKey(project.repoUrl);
    const repo = new SimpleRepoManager(process.env.REPO_CACHE_ROOT ?? '/tmp/bettercode', logger);
    const snapshot = await repo.getSnapshot(job.project, project, { sshKeyPath });
    await updateJob(job.jobId, { commitSha: snapshot.commitSha });

    const apiKey = await getSecret(cfg.llm.apiKeySecretName);
    const llm = cfg.llm.provider === 'openai' ? new OpenAIClient(apiKey) : new AnthropicClient(apiKey);
    const answer = await runJob({
      jobId: job.jobId,
      question: job.text,
      agentName: job.agent,
      snapshot,
      registry,
      access: resolveAccess(cfg, project),
      budgets: resolveBudgets(cfg, channel),
      cfg,
      llm,
      logger,
      recordAudit: recordToolCall,
    });

    await responder.postFinal(job, answer);
    await updateJob(job.jobId, {
      status: 'succeeded',
      answerExcerpt: answer.answer.slice(0, 500),
      confidence: answer.confidence,
      usage: answer.usage,
    });
    logger.info({ usage: answer.usage, sha: snapshot.commitSha }, 'job succeeded');
    return false;
  } catch (err) {
    const code: FailureCode = err instanceof BetterCodeError ? err.code : 'INTERNAL';
    const retryable = err instanceof BetterCodeError ? err.retryable : true;
    logger.error({ err: (err as Error).message, code, attempt }, 'job failed');

    // Retry transient failures silently; only post a graceful message on the
    // final attempt so the user never sees duplicate errors (failure handling).
    if (retryable && attempt < MAX_ATTEMPTS) {
      await updateJob(job.jobId, { status: 'queued' });
      return true;
    }
    try {
      await responder.postFailure(job, code);
    } catch {
      /* best effort */
    }
    await updateJob(job.jobId, {
      status: failureStatus(code),
      error: { code, message: (err as Error).message.slice(0, 300) },
    });
    return false;
  }
}

async function resolveSshKey(repoUrl: string): Promise<string | undefined> {
  const secretName = process.env.GITHUB_DEPLOY_KEY_SECRET_NAME;
  if (!repoUrl.startsWith('git@') || !secretName) return undefined;
  return materializeSshKey(secretName);
}

function failureStatus(code: FailureCode): JobStatus {
  if (code === 'TIMEOUT' || code === 'BUDGET_EXCEEDED') return 'timed_out';
  if (code === 'RATE_LIMITED' || code === 'NOT_ANSWERABLE') return 'rejected';
  return 'failed';
}
