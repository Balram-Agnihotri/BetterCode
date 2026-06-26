import type { JobRecord } from '../types';

export function newJobTtl(): number {
  return Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;
}

export async function putJob(_rec: JobRecord): Promise<void> {}

export async function updateJob(
  _jobId: string,
  _patch: Partial<Omit<JobRecord, 'jobId'>>,
): Promise<void> {}

export async function getJob(_jobId: string): Promise<JobRecord | undefined> {
  return undefined;
}
