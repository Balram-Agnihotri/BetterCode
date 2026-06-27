/**
 * Workspace interaction tools — let the LLM explicitly read and write its
 * per-job investigation workspace.
 *
 * These tools replace the pattern of relying on raw conversation history
 * for context. The model records findings here; the orchestrator injects
 * the workspace summary at each turn instead of replaying tool results.
 */
import { z } from 'zod';
import { ok, type ToolDefinition, type ToolContext } from './types';

// ---------------------------------------------------------------------------
// recordFinding
// ---------------------------------------------------------------------------

const recordFindingInput = z.object({
  text: z.string().min(1).describe('Description of what you found.'),
  evidence: z
    .array(z.string())
    .default([])
    .describe('Citation anchors such as "path/to/file.ts:L42" or "path:L10-L30".'),
  confidence: z
    .enum(['high', 'medium', 'low'])
    .default('medium')
    .describe('How confident you are in this finding.'),
});

export const recordFindingTool: ToolDefinition<z.infer<typeof recordFindingInput>> = {
  name: 'recordFinding',
  description:
    'Record an important discovery to your investigation workspace. ' +
    'Call this whenever you learn something significant about the codebase that is relevant to the question. ' +
    'Findings persist in the workspace and appear in your summary — they will not be lost as the conversation grows.',
  inputSchema: recordFindingInput,
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['text'],
    properties: {
      text: { type: 'string', description: 'What you found.' },
      evidence: {
        type: 'array',
        items: { type: 'string' },
        description: 'File:line citations supporting this finding.',
      },
      confidence: {
        type: 'string',
        enum: ['high', 'medium', 'low'],
        description: 'Confidence level. Default medium.',
      },
    },
  },
  async execute(input, ctx: ToolContext) {
    const { workspace } = ctx;
    if (!workspace) {
      return ok({
        content: 'Workspace not available in this context.',
        citations: [],
        meta: {},
        truncated: false,
      });
    }

    workspace.recordFinding(input.text, input.evidence, input.confidence);

    return ok({
      content: `Finding recorded [confidence: ${input.confidence}]: "${input.text}"`,
      citations: [],
      meta: { confidence: input.confidence, evidenceCount: input.evidence.length },
      truncated: false,
    });
  },
};

// ---------------------------------------------------------------------------
// getWorkspaceSummary
// ---------------------------------------------------------------------------

export const getWorkspaceSummaryTool: ToolDefinition<Record<string, never>> = {
  name: 'getWorkspaceSummary',
  description:
    'Get a structured summary of your current investigation workspace: files you have read, ' +
    'findings you have recorded, your working hypothesis, and unresolved questions. ' +
    'Call this before synthesizing your final answer to review everything you have discovered.',
  inputSchema: z.object({}).strict(),
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {},
  },
  async execute(_input, ctx: ToolContext) {
    const { workspace } = ctx;
    if (!workspace) {
      return ok({
        content: 'Workspace not available in this context.',
        citations: [],
        meta: {},
        truncated: false,
      });
    }

    if (!workspace.hasContent()) {
      return ok({
        content: 'Investigation workspace is empty. Start by using `search`, `findSymbol`, or `read` tools.',
        citations: [],
        meta: { empty: true },
        truncated: false,
      });
    }

    const rendered = workspace.renderSummary();
    return ok({
      content: rendered,
      citations: [],
      meta: { tokenEstimate: workspace.getTokenEstimate() },
      truncated: false,
    });
  },
};

// ---------------------------------------------------------------------------
// updateHypothesis
// ---------------------------------------------------------------------------

const updateHypothesisInput = z.object({
  text: z.string().min(1).describe('Your current working hypothesis or understanding of the answer.'),
});

export const updateHypothesisTool: ToolDefinition<z.infer<typeof updateHypothesisInput>> = {
  name: 'updateHypothesis',
  description:
    'Update your working hypothesis about the answer. ' +
    'Record your current understanding before digging deeper — this helps you stay on track ' +
    'and prevents losing your reasoning as the context grows.',
  inputSchema: updateHypothesisInput,
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['text'],
    properties: {
      text: { type: 'string', description: 'Working hypothesis text.' },
    },
  },
  async execute(input, ctx: ToolContext) {
    const { workspace } = ctx;
    if (!workspace) {
      return ok({
        content: 'Workspace not available in this context.',
        citations: [],
        meta: {},
        truncated: false,
      });
    }

    workspace.updateHypothesis(input.text);

    return ok({
      content: `Working hypothesis updated: "${input.text.slice(0, 200)}${input.text.length > 200 ? '…' : ''}"`,
      citations: [],
      meta: {},
      truncated: false,
    });
  },
};
