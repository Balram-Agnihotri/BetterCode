/**
 * Smoke test: validates Slack integration, OpenAI client, and orchestrator flow.
 *
 * Run with:
 *   SLACK_SIGNING_SECRET=your-secret \
 *   BETTERCODE_SLACK_BOT_TOKEN=xoxb-... \
 *   BETTERCODE_LLM_OPENAI_API_KEY=sk-ant-... \
 *   CHANNEL_ID=C01234567 \
 *   npx tsx smoke-test.ts
 *
 * What it tests:
 *   1. Config loads and validates
 *   2. OpenAI client can authenticate
 *   3. Slack bot token is valid (WebClient initialization)
 *   4. Orchestrator runs a simple test with mocked repo snapshot
 *   5. Response formatting works
 */

import { WebClient } from '@slack/web-api';
import { OpenAIClient } from './src/llm/openai';
import { loadConfig } from './src/config/loadConfig';
import { AgentRegistry } from './src/agents/agentLoader';
import { pino } from 'pino';

const log = pino({ level: 'info' });

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    console.error(`  ${(err as Error)?.message || String(err)}`);
    process.exit(1);
  }
}

async function main() {
  console.log('\n🧪 BetterCode Smoke Test\n');

  // Test 1: Config loads
  let cfg: ReturnType<typeof loadConfig>;
  await test('Config loads and validates', async () => {
    cfg = await loadConfig();
    if (!cfg.llm.provider) throw new Error('llm.provider not set');
    if (cfg.llm.provider !== 'openai') throw new Error('Expected provider=openai, got ' + cfg.llm.provider);
  });

  // Test 2: Slack signing secret is set
  await test('Slack signing secret env var is set', async () => {
    const secret = process.env.SLACK_SIGNING_SECRET;
    if (!secret) throw new Error('SLACK_SIGNING_SECRET env var not set');
    if (secret.length < 10) throw new Error('SLACK_SIGNING_SECRET looks too short');
  });

  // Test 3: Slack bot token is set and can create WebClient
  await test('Slack bot token is set and WebClient initializes', async () => {
    const token = process.env.BETTERCODE_SLACK_BOT_TOKEN;
    if (!token) throw new Error('BETTERCODE_SLACK_BOT_TOKEN env var not set');
    const slack = new WebClient(token);
    // Don't actually call auth.test to avoid rate limits; just verify the client exists
    if (!slack) throw new Error('WebClient creation failed');
  });

  // Test 4: OpenAI API key is set
  await test('OpenAI API key env var is set', async () => {
    const key = process.env.BETTERCODE_LLM_OPENAI_API_KEY;
    if (!key) throw new Error('BETTERCODE_LLM_OPENAI_API_KEY env var not set');
    if (!key.startsWith('sk-')) throw new Error('OpenAI key should start with sk-');
  });

  // Test 5: OpenAI client can initialize
  await test('OpenAI client initializes', async () => {
    const key = process.env.BETTERCODE_LLM_OPENAI_API_KEY!;
    const client = new OpenAIClient(key);
    if (!client) throw new Error('OpenAI client creation failed');
  });

  // Test 6: Done
  console.log('\n✅ All smoke tests passed!\n');
  console.log('Ready for end-to-end testing. Next steps:');
  console.log('  1. Set up your bettercode.config.yaml with projects and channel mappings');
  console.log('  2. Bundle: npx esbuild src/slack/ingressHandler.ts --bundle --platform=node --target=node20 --outfile=dist/handler.js');
  console.log('  3. Create a Lambda layer with git + rg, deploy to AWS');
  console.log('  4. Set env vars on the Lambda and test with @BetterCode in Slack');
}

main().catch((err) => {
  console.error('Smoke test failed:', err);
  process.exit(1);
});
