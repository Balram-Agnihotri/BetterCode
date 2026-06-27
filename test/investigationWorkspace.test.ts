import { describe, expect, it } from 'vitest';
import { InvestigationWorkspace } from '../src/workspace/investigationWorkspace';

describe('InvestigationWorkspace', () => {
  it('starts completely empty', () => {
    const ws = new InvestigationWorkspace();
    expect(ws.hasContent()).toBe(false);
    expect(ws.isReadyToSynthesize()).toBe(false);
    expect(ws.getTokenEstimate()).toBe(0);
  });

  it('records a file read and reflects it in the summary', () => {
    const ws = new InvestigationWorkspace();
    ws.recordFileRead('src/foo.ts', 'export function foo() { return 1; }', 1, 1);
    expect(ws.hasContent()).toBe(true);

    const summary = ws.getSummary();
    expect(summary.filesRead).toHaveLength(1);
    expect(summary.filesRead[0]).toContain('src/foo.ts');
  });

  it('records multiple files and reflects recency order', () => {
    const ws = new InvestigationWorkspace();
    ws.recordFileRead('src/a.ts', 'const a = 1;', 1, 1);
    ws.recordFileRead('src/b.ts', 'const b = 2;', 1, 1);

    const summary = ws.getSummary();
    expect(summary.filesRead).toHaveLength(2);
    // Most recently read (b) should come first
    expect(summary.filesRead[0]).toContain('src/b.ts');
  });

  it('records findings and stores them', () => {
    const ws = new InvestigationWorkspace();
    ws.recordFinding('runJob is async', ['src/orchestrator.ts:L42'], 'high');
    ws.recordFinding('worker calls runJob', ['src/worker.ts:L80'], 'medium');

    const summary = ws.getSummary();
    expect(summary.findings).toHaveLength(2);
    expect(summary.findings[0]!.text).toBe('runJob is async');
    expect(summary.findings[0]!.confidence).toBe('high');
  });

  it('updates hypothesis', () => {
    const ws = new InvestigationWorkspace();
    ws.updateHypothesis('The bug is in the rate limiter');
    expect(ws.getSummary().hypothesis).toBe('The bug is in the rate limiter');

    ws.updateHypothesis('The bug is actually in the queue');
    expect(ws.getSummary().hypothesis).toBe('The bug is actually in the queue');
  });

  it('manages unknowns — add and resolve', () => {
    const ws = new InvestigationWorkspace();
    ws.addUnknown('What calls processRecord?');
    ws.addUnknown('Where is the retry logic?');
    expect(ws.getSummary().unknowns).toHaveLength(2);

    ws.resolveUnknown('processRecord');
    expect(ws.getSummary().unknowns).toHaveLength(1);
    expect(ws.getSummary().unknowns[0]).toContain('retry');
  });

  it('does not add duplicate unknowns', () => {
    const ws = new InvestigationWorkspace();
    ws.addUnknown('Same question');
    ws.addUnknown('Same question');
    expect(ws.getSummary().unknowns).toHaveLength(1);
  });

  it('is ready to synthesize when ≥2 findings and no unknowns', () => {
    const ws = new InvestigationWorkspace();
    ws.recordFinding('finding one', [], 'high');
    ws.recordFinding('finding two', [], 'medium');
    // No unknowns
    expect(ws.isReadyToSynthesize()).toBe(true);
  });

  it('is NOT ready to synthesize when unknowns remain', () => {
    const ws = new InvestigationWorkspace();
    ws.recordFinding('finding one', [], 'high');
    ws.recordFinding('finding two', [], 'medium');
    ws.addUnknown('Still unresolved');
    expect(ws.isReadyToSynthesize()).toBe(false);
  });

  it('is NOT ready to synthesize with fewer than 2 findings', () => {
    const ws = new InvestigationWorkspace();
    ws.recordFinding('only one', [], 'high');
    expect(ws.isReadyToSynthesize()).toBe(false);
  });

  it('renders a non-empty summary string when content exists', () => {
    const ws = new InvestigationWorkspace();
    ws.recordFileRead('src/foo.ts', 'export class Foo {}', 1, 1);
    ws.updateHypothesis('Foo is the entry point');
    const rendered = ws.renderSummary();
    expect(rendered).toContain('Investigation Workspace');
    expect(rendered).toContain('src/foo.ts');
    expect(rendered).toContain('Foo is the entry point');
  });

  it('renders empty string when workspace has no content', () => {
    const ws = new InvestigationWorkspace();
    expect(ws.renderSummary()).toBe('');
  });

  it('getTokenEstimate does not recurse infinitely', () => {
    const ws = new InvestigationWorkspace();
    ws.recordFileRead('src/big.ts', 'x'.repeat(2000), 1, 100);
    ws.recordFinding('something', ['src/big.ts:L1'], 'medium');
    // Should not throw RangeError
    const estimate = ws.getTokenEstimate();
    expect(estimate).toBeGreaterThan(0);
  });

  it('records call chains without duplicates', () => {
    const ws = new InvestigationWorkspace();
    ws.addCallChain('handler → runJob → processRecord');
    ws.addCallChain('handler → runJob → processRecord'); // duplicate
    expect(ws.getSummary().callChains).toHaveLength(1);
  });
});
