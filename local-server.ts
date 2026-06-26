/**
 * Local dev server for testing BetterCode end-to-end with ngrok.
 *
 * Usage:
 *   SLACK_SIGNING_SECRET=... \
 *   BETTERCODE_SLACK_BOT_TOKEN=... \
 *   BETTERCODE_LLM_OPENAI_API_KEY=... \
 *   npx tsx local-server.ts
 *
 * Then:
 *   1. In another terminal: ngrok http 3000
 *   2. Copy ngrok URL (e.g., https://abc123.ngrok.io)
 *   3. Go to Slack app settings → Event Subscriptions → Request URL
 *   4. Paste ngrok URL + /slack/events (e.g., https://abc123.ngrok.io/slack/events)
 *   5. Subscribe to: app_mention, message.channels
 *   6. Reinstall app in your workspace
 *   7. In Slack, @mention BetterCode in a channel and ask a question
 */

import http from 'http';
import { handler } from './src/slack/ingressHandler';
import { pino } from 'pino';

const log = pino({ level: 'info' });

const server = http.createServer(async (req, res) => {
  log.info({ method: req.method, url: req.url, headers: req.headers }, 'incoming request');

  // Only accept POST
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  // Collect request body
  let body = '';
  req.on('data', (chunk) => {
    body += chunk.toString();
    if (body.length > 1e6) {
      req.connection.destroy();
      log.error('request body too large');
    }
  });

  req.on('end', async () => {
    try {
      // Parse body as JSON or query string
      let parsedBody: Record<string, unknown> = {};
      if (req.headers['content-type']?.includes('application/json')) {
        parsedBody = JSON.parse(body);
      } else if (body) {
        parsedBody = Object.fromEntries(new URLSearchParams(body));
      }

      // Slack URL verification challenge (for setting up the event subscription)
      if (typeof parsedBody.challenge === 'string') {
        log.info('Slack URL verification challenge');
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(parsedBody.challenge);
        return;
      }

      // Pass to the Lambda handler
      log.info({ bodyKeys: Object.keys(parsedBody) }, 'invoking handler');
      const result = await handler({
        body: body || JSON.stringify(parsedBody),
        headers: req.headers as Record<string, string>,
      });

      res.writeHead(result.statusCode || 200, { 'Content-Type': 'application/json' });
      res.end(result.body || '{"ok":true}');
      log.info({ statusCode: result.statusCode }, 'response sent');
    } catch (err) {
      log.error(err, 'handler error');
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: (err as Error)?.message || 'Internal error' }));
    }
  });
});

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`\n🚀 Local server listening on http://localhost:${PORT}\n`);
  console.log('📡 Setup ngrok in another terminal:');
  console.log('   ngrok http 3000\n');
  console.log('🔗 Then set the ngrok URL as Slack Event Request URL:');
  console.log('   https://abc123.ngrok.io/slack/events\n');
  console.log('💬 Send a message in Slack:');
  console.log('   @BetterCode <your-question>\n');
});
