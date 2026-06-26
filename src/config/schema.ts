import { z } from 'zod';

/**
 * Zod schema for bettercode.config.yaml. Parsing is strict: unknown keys are
 * rejected so typos fail fast at deploy/boot rather than silently mis-routing.
 */

const modelSpec = z.object({
  id: z.string().min(1),
  maxTokens: z.number().int().positive().default(4096),
});

const accessSchema = z
  .object({
    denyGlobs: z.array(z.string()).default([]),
    allowGlobs: z.array(z.string()).default(['**/*']),
    maxBinaryBytesProbe: z.number().int().positive().default(8192),
  })
  .strict();

const budgetsSchema = z
  .object({
    maxToolCalls: z.number().int().positive(),
    maxSubagentCalls: z.number().int().positive(),
    maxWallClockMs: z.number().int().positive(),
    maxTokens: z.number().int().positive(),
    maxSearchResults: z.number().int().positive(),
    maxFileBytes: z.number().int().positive(),
    maxFileLines: z.number().int().positive(),
    maxSlackChars: z.number().int().positive(),
  })
  .strict();

const slackSchema = z
  .object({
    signingSecretEnv: z.string().min(1),
    botTokenSecretName: z.string().min(1),
    responseMode: z.enum(['thread', 'broadcast', 'channel']).default('thread'),
    postInterimMessage: z.boolean().default(true),
    ignoreBotMessages: z.boolean().default(true),
    ignoreEditsAndDeletes: z.boolean().default(true),
  })
  .strict();

const llmSchema = z
  .object({
    provider: z.enum(['anthropic', 'openai']).default('anthropic'),
    apiKeySecretName: z.string().min(1),
    models: z.object({
      router: modelSpec,
      explore: modelSpec,
      synth: modelSpec,
    }),
    fallbacks: z.record(z.string(), z.array(z.string())).default({}),
  })
  .strict();

const projectSchema = z
  .object({
    repoUrl: z.string().min(1),
    branch: z.string().min(1).default('main'),
    agentDir: z.string().min(1),
    defaultAgent: z.string().min(1),
    githubWebBaseUrl: z.string().url(),
    submodules: z.boolean().default(true),
    /** Delegation graph: agent name -> allowed subagent names. */
    subagents: z.record(z.string(), z.array(z.string())).default({}),
    access: accessSchema.partial().optional(),
  })
  .strict();

const channelSchema = z
  .object({
    project: z.string().min(1),
    agent: z.string().min(1),
    mode: z.enum(['auto', 'mention-only', 'off']).default('mention-only'),
    triggers: z
      .object({
        appMention: z.boolean().default(true),
        questionLikeMessages: z.boolean().default(false),
        botKeyword: z.string().optional(),
      })
      .strict()
      .default({ appMention: true, questionLikeMessages: false }),
    budgets: budgetsSchema.partial().optional(),
  })
  .strict();

const rateLimitsSchema = z
  .object({
    perChannelPerMinute: z.number().int().positive().default(6),
    perUserPerMinute: z.number().int().positive().default(3),
    perChannelConcurrentJobs: z.number().int().positive().default(2),
  })
  .strict();

export const configSchema = z
  .object({
    version: z.literal(1),
    slack: slackSchema,
    llm: llmSchema,
    budgets: budgetsSchema,
    access: accessSchema,
    rateLimits: rateLimitsSchema.default({}),
    projects: z.record(z.string(), projectSchema),
    channels: z.record(z.string(), channelSchema),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    // Cross-reference integrity: every channel must point at a real project.
    for (const [channelId, ch] of Object.entries(cfg.channels)) {
      if (!cfg.projects[ch.project]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `channel ${channelId} references unknown project "${ch.project}"`,
          path: ['channels', channelId, 'project'],
        });
      }
    }
  });

export type BetterCodeConfig = z.infer<typeof configSchema>;
export type ProjectConfig = z.infer<typeof projectSchema>;
export type ChannelConfig = z.infer<typeof channelSchema>;
export type AccessConfig = z.infer<typeof accessSchema>;
