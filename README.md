# BetterCode

Slack-native, read-only **codebase Q&A**. Ask a question in a configured Slack
channel; BetterCode syncs the repo, runs an agentic LLM tool-calling loop over a
read-only snapshot, and replies **in-thread** with a grounded answer and
GitHub-linked code citations. No human in the loop for ordinary answers.

It borrows Claude Code's architecture — agentic loop, read/search tools,
specialized subagents with isolated context and constrained tools, and
project-local agent manifests — and packages it as a **single serverless Lambda**
(AWS Lambda).

> **Design docs:** [docs/DESIGN.md](docs/DESIGN.md) · [docs/DECISIONS.md](docs/DECISIONS.md)

## How it works

```
Slack → API Gateway → Handler λ (verify · dedupe · decide · runJob · reply)
                          → git fetch + reset --hard (plain clone in /tmp)
                          → agentic loop: ProductLens + explore via read/search/agent tools
                          → chat.postMessage (threaded answer with citations)
```

- **Handler** verifies the Slack signature, dedupes on `event_id`, decides
  whether to answer, then runs the orchestrator inline and posts the reply.
- **Orchestrator** drives `ProductLens` (synthesis) which delegates breadth to
  `explore` (read-only investigation) via `read` / `search` / `agent` tools.
- Repo is refreshed per job with `git fetch + reset --hard` on a plain clone.
  The current HEAD SHA flows into every citation and GitHub link.

## Layout

```
bettercode.config.yaml                     # channels → projects → repos → agents
projects/<project>/.github/agents/*.md     # agent manifests (YAML frontmatter)
src/{slack,repo,agents,tools,orchestrator,llm,data,config,observability}
infra/cdk/                                  # AWS CDK stack
docs/                                       # DESIGN.md, DECISIONS.md
test/                                       # vitest suites
```

## Develop

Requires Node ≥ 20. Code search also needs `git` and `rg` (ripgrep) on PATH.

```bash
npm install
npm run typecheck     # tsc --noEmit
npm test              # vitest (30 tests)
npm run lint
```

## Test locally (without deploying Lambda)

### 1. Run the test suite

```bash
npm test
```

Covers: manifest parsing, path guard, redaction, signature verification, channel
routing, and a full end-to-end orchestrator loop driven by a scripted fake LLM
against a real temp worktree.

### 2. Smoke-test the orchestrator against a real repo

Requires `ANTHROPIC_API_KEY` and a local copy of the target repo.

```bash
# Point agentDir at the local agents folder and worktreeRoot at the repo
ANTHROPIC_API_KEY=sk-ant-... npx tsx -e "
import { loadProjectAgents } from './src/agents/agentLoader';
import { AnthropicClient } from './src/llm/anthropic';
import { runJob } from './src/orchestrator/orchestrator';
import { loadConfig } from './src/config/loadConfig';
import { createLogger } from './src/observability/logger';
import { recordToolCall } from './src/data/audit';

const cfg = await loadConfig();
const project = cfg.projects['engage-workspace'];
const registry = await loadProjectAgents(project.agentDir, project.subagents);
const llm = new AnthropicClient(process.env.ANTHROPIC_API_KEY!);
const snapshot = {
  project: 'engage-workspace',
  commitSha: 'local',
  branch: 'main',
  worktreeRoot: '/path/to/local/repo',   // ← set this
  githubWebBaseUrl: project.githubWebBaseUrl,
};
const answer = await runJob({
  jobId: 'local-test',
  question: 'How does authentication work?',
  agentName: 'ProductLens',
  snapshot,
  registry,
  access: cfg.access,
  budgets: cfg.budgets,
  cfg,
  llm,
  logger: createLogger(),
  recordAudit: recordToolCall,
});
console.log(answer.answer);
console.log('Citations:', answer.citations.length);
"
```

### 3. Full end-to-end with a real Slack workspace (via ngrok)

This runs the actual Lambda handler as a local HTTP server and tunnels Slack
events to it.

**Prerequisites:** `ngrok` installed, a Slack app with a bot token and signing
secret, and `ANTHROPIC_API_KEY`.

**Step 1 — Create `.env`** (copy from `.env.example`):

```bash
SLACK_SIGNING_SECRET=your-signing-secret
BETTERCODE_LLM_ANTHROPIC_API_KEY=sk-ant-...
BETTERCODE_SLACK_BOT_TOKEN=xoxb-...
# If repo uses SSH: GITHUB_DEPLOY_KEY_SECRET_NAME=bettercode/github/your-repo
```

> Secrets named `bettercode/<segment>` are automatically resolved from the env
> variable `BETTERCODE_<SEGMENT_UPPERCASED>` — see `src/data/secrets.ts`.

**Step 2 — Start a local HTTP server wrapping the handler:**

```bash
npx tsx -e "
import { createServer } from 'node:http';
import { handler } from './src/slack/ingressHandler';

const server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString();
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === 'string') headers[k] = v;
  }
  const result = await handler({
    httpMethod: req.method ?? 'POST',
    headers,
    body,
    isBase64Encoded: false,
    path: req.url ?? '/',
    queryStringParameters: null,
    multiValueHeaders: {},
    multiValueQueryStringParameters: null,
    pathParameters: null,
    stageVariables: null,
    requestContext: {} as never,
    resource: '',
  });
  res.writeHead(result.statusCode, result.headers ?? {});
  res.end(result.body);
});

server.listen(3000, () => console.log('Listening on http://localhost:3000'));
" 
```

**Step 3 — Tunnel with ngrok:**

```bash
ngrok http 3000
```

**Step 4 — Point Slack at ngrok:**

In your Slack app settings → *Event Subscriptions*, set the Request URL to
`https://<your-ngrok-id>.ngrok.io/`. Slack will send the URL verification
challenge; the server handles it automatically.

Subscribe to `app_mention` and `message.channels`, install the app to your
workspace, and invite the bot to a channel listed in `bettercode.config.yaml`.

**Step 5 — Ask a question:**

```
@BetterCode how does authentication work?
```

The answer appears in-thread once the LLM finishes (typically 30-90 s).

## Deploy (Lambda)

No CDK or IaC is included — deploy with whatever tool you prefer (AWS Console,
SAM, Serverless Framework, Terraform, etc.).

**What the Lambda needs:**

| Setting | Value |
|---|---|
| Runtime | Node.js 20, ARM64 |
| Memory | 2048 MB |
| Timeout | 5 minutes (300 s) |
| Ephemeral storage | 10 GiB |
| Handler | `src/slack/ingressHandler.handler` (after bundling) |
| Layer | ARM64 layer containing `git` and `rg` (ripgrep) on PATH |

**Environment variables (set on the Lambda):**

```
SLACK_SIGNING_SECRET=your-signing-secret
BETTERCODE_SLACK_BOT_TOKEN=xoxb-...
BETTERCODE_LLM_ANTHROPIC_API_KEY=sk-ant-...
# If repo uses SSH:
GITHUB_DEPLOY_KEY_SECRET_NAME=bettercode/github/your-repo  # or set key directly
```

> Secrets Manager is optional. If the env var `BETTERCODE_<SEGMENT>` is set,
> Secrets Manager is never called. See [src/data/secrets.ts](src/data/secrets.ts).

**Steps:**

1. Bundle the source: `npx esbuild src/slack/ingressHandler.ts --bundle --platform=node --target=node20 --outfile=dist/handler.js`
2. Zip `dist/handler.js` and deploy to Lambda.
3. Add the `git`+`rg` layer (build an ARM64 layer or use a public one).
4. Set the environment variables above.
5. Attach API Gateway (REST or HTTP) triggering the Lambda, or use a **Lambda Function URL** (recommended — avoids the API Gateway 29-second timeout).
6. In your Slack app settings → *Event Subscriptions*, set the Request URL to the API Gateway/Function URL endpoint. Slack will send the URL verification challenge automatically.
7. Subscribe to `app_mention` and `message.channels`, install the app, and invite the bot to a channel listed in `bettercode.config.yaml`.
8. `@BetterCode` a question → threaded answer with `Repo @ <sha>` and GitHub source links.

## Security posture

Read-only repo access on a plain worktree; **no write/edit/bash** tool exposed
to the LLM; Slack signature verification; path-traversal + symlink-escape
protection; secret-file denylist; secret redaction on every tool output and log;
prompt-injection-resistant prompting (repo + Slack text treated as untrusted
data). See [docs/DESIGN.md §12](docs/DESIGN.md).

## Status

Type-clean (`tsc --noEmit`), 30 tests passing including a full end-to-end
orchestration-loop test. Ready to wire up: git/rg Lambda layer, secrets, Slack
app Request URL.
