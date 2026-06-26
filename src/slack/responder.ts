import type { ChatPostMessageArguments, WebClient } from '@slack/web-api';
import type { BetterCodeConfig } from '../config/schema';
import type { Logger } from '../observability/logger';
import type { AnswerResult, FailureCode, JobMessage } from '../types';
import { failureMessage, formatFinalMessage } from './mrkdwn';

export class SlackResponder {
  constructor(
    private readonly slack: WebClient,
    private readonly cfg: BetterCodeConfig,
    private readonly logger: Logger,
  ) {}

  async postFinal(job: JobMessage, answer: AnswerResult): Promise<void> {
    const text = formatFinalMessage(answer, this.cfg.budgets.maxSlackChars);
    await this.send(job, text);
  }

  async postFailure(job: JobMessage, code: FailureCode): Promise<void> {
    await this.send(job, failureMessage(code));
  }

  private async send(job: JobMessage, text: string): Promise<void> {
    const args = {
      channel: job.channelId,
      thread_ts: job.threadTs,
      text,
      ...(this.cfg.slack.responseMode === 'broadcast' ? { reply_broadcast: true } : {}),
    };
    await this.slack.chat.postMessage(args as unknown as ChatPostMessageArguments);
  }
}
