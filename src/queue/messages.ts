import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { z } from 'zod';
import type { JobMessage } from '../types';

const sqs = new SQSClient({});

export const jobMessageSchema = z.object({
  schemaVersion: z.literal(1),
  jobId: z.string().min(1),
  eventId: z.string().min(1),
  teamId: z.string(),
  channelId: z.string().min(1),
  threadTs: z.string().min(1),
  messageTs: z.string().min(1),
  userId: z.string(),
  text: z.string(),
  project: z.string().min(1),
  agent: z.string().min(1),
  triggerReason: z.enum(['app_mention', 'question_like', 'bot_keyword']),
  receivedAt: z.string(),
});

export function parseJobMessage(raw: string): JobMessage {
  return jobMessageSchema.parse(JSON.parse(raw)) as JobMessage;
}

/** Enqueue a job for the async worker. Ingress returns to Slack right after. */
export async function enqueueJob(msg: JobMessage): Promise<void> {
  const url = process.env.JOBS_QUEUE_URL;
  if (!url) throw new Error('JOBS_QUEUE_URL is not set');
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: url,
      MessageBody: JSON.stringify(msg),
      MessageAttributes: {
        project: { DataType: 'String', StringValue: msg.project },
        channel: { DataType: 'String', StringValue: msg.channelId },
      },
    }),
  );
}
