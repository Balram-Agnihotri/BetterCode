import type { ToolCallAudit } from '../types';

export async function recordToolCall(audit: ToolCallAudit): Promise<void> {
  console.log('[audit]', JSON.stringify({
    jobId: audit.jobId,
    seq: audit.seq,
    agent: audit.agent,
    tool: audit.tool,
    ok: audit.ok,
    durationMs: audit.durationMs,
    errorCode: audit.errorCode,
  }));
}
