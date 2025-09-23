<p align="center">
 <img width="300px" src="https://github.com/Code-Fundi/.github/blob/main/media/dispersl/logo.png?raw=true" align="center" alt="Dispersl MCP Server" />
</p>
</p>

<p align="center">
  <a href="https://discord.gg/6RJTWCuWZj">
    <img src="https://img.shields.io/badge/Discord-7289DA?logo=discord&logoColor=white" />
  </a>
  <a href="https://x.com/disperslHQ">
    <img src="https://img.shields.io/badge/X/Twitter-808080?logo=x&logoColor=white" />
  </a>
  <a href="https://www.tiktok.com/@codefundi">
    <img src="https://img.shields.io/badge/TikTok-000000?logo=tiktok&logoColor=white" />
  </a>
<br />
</p>


#

# Dispersl MCP Server

A Model Context Protocol (MCP) server implementation that integrates with [Dispersl]("https://dispersl.com"); The AI Dev Team, to give you multi-agents that work together to build software.

This MCP server can use other MCP servers as well for distributed, tool-driven workflows.

> Built for modern AI-driven development, with support for multiple LLM models, multi-agent planning, and full SDLC automation.

---

## Features

- Multi-agent orchestration (plan, code, test, git, docs, chat)
- Code generation, test generation, and documentation
- Git operations and repo management
- Conversational agentic chat
- API key and session management
- Connect to and manage other MCP servers (local or remote)
- Extensible with custom tools and external agents
- Works with Cursor, VS Code, and other MCP-compatible clients

---

## Installation

### Running with npx

```bash
env DISPERSL_API_KEY=your-api-key npx -y dispersl-mcp
```

### Manual Installation

```bash
npm install -g dispersl-mcp
```

### Running on Cursor

For the most up-to-date configuration instructions, see the [Cursor MCP Server Configuration Guide](https://docs.cursor.com/context/model-context-protocol#configuring-mcp-servers).

**Example Cursor MCP config:**

```json
{
  "mcpServers": {
    "dispersl-mcp": {
      "command": "npx",
      "args": ["-y", "dispersl-mcp"],
      "env": {
        "DISPERSL_API_KEY": "YOUR_API_KEY"
      }
    }
  }
}
```

### Running Locally

```bash
export DISPERSL_API_KEY=your-api-key
npm run dev
```

### Running with Custom Models

You can specify default models for each agent type:

```bash
export DISPERSL_PLAN_MODEL=deepseek/deepseek-chat-v3-0324:free
export DISPERSL_CODE_MODEL=anthropic/claude-sonnet-4
export DISPERSL_TEST_MODEL=anthropic/claude-sonnet-4
export DISPERSL_GIT_MODEL=meta-llama/llama-4-maverick:free
export DISPERSL_DOCS_MODEL=openai/gpt-4o-mini
export DISPERSL_CHAT_MODEL=openai/gpt-4o-mini
```

---

## Configuration

### MCP Config Example

To connect to local and external MCP servers, use `.dispersl/mcp.json`:

```json
{
  "mcpServers": {
    "anthropic-main": {
      "command": "npx",
      "args": [
        "-y",
        "--package=@anthropic-ai/mcp-server",
        "anthropic-mcp-server"
      ],
      "env": {
        "ANTHROPIC_API_KEY": "${ANTHROPIC_API_KEY}"
      }
    },
    "anthropic-backup": {
      "command": "npx",
      "args": [
        "-y",
        "--package=@anthropic-ai/mcp-server",
        "anthropic-mcp-server"
      ],
      "env": {
        "ANTHROPIC_API_KEY": "${ANTHROPIC_API_KEY_BACKUP}"
      }
    }
  }
}
```

---

## Usage

### Tool Reference

| Tool Name                  | Description |
|--------------------------- |-------------|
| list_models                | List available models |
| dispersl_code_agent        | Generate code files and codebases based on a prompt using agentic execution |
| dispersl_testing_agent     | Generate end to end tests based on a prompt using agentic execution |
| dispersl_git_agent         | Execute codebase versioning operations with Git based on a prompt using agentic execution |
| dispersl_new_docs_agent    | Generate file by file technical documentation for a code repository using agentic execution |
| dispersl_chat_agent        | Chat with the Dispersl agent to get knowledge or insights about codebases using agentic execution |
| dispersl_plan_agent        | Multi-agent task dispersion using agentic execution (plan agent) |
| start_session              | Start a new agentic session |
| end_session                | End an active session |
| add_mcp_server             | Connect to an external MCP server and save to config |
| remove_mcp_server          | Disconnect from an MCP server and remove from config |
| get_models                 | List available AI models |
| get_keys                   | Get API keys for the authenticated user |
| new_key                    | Generate new API key |
| create_task                | Create a new task |
| edit_task                  | Edit a task by ID |
| get_tasks                  | Get all tasks |
| get_task                   | Get a task by ID |
| cancel_task                | Cancel a task by ID |
| edit_step                  | Edit a step by ID |
| get_steps                  | Get all steps |
| get_step                   | Get a step by ID |
| cancel_step                | Cancel a step by ID |
| get_usage_stats            | Get usage stats |
| get_language_stats         | Get language usage stats |
| get_agent_stats            | Get agent query stats |
| get_task_history           | Get task history by ID |
| get_step_history           | Get step history by ID |
| fetch_api_root             | Fetch API root (utility endpoint) |
| health_check               | Health check endpoint |


### Example: Chat

This agent is able to interact with the user to fetch insights, shared memories and task progress to the user.

```typescript
await client.callTool({
  name: "start_session",
  arguments: { session_id: "my-session" }
});

const response = await client.callTool({
  name: "dispersl_chat_agent",
  arguments: {
    prompt: "Hello, how are you?",
    model: "meta-llama/llama-4-maverick:free"
  }
});

await client.callTool({
  name: "end_session",
  arguments: { session_id: "my-session" }
});
```


### Example: Plan Agent

This agent is able to coordinate all the agents i.e `code`, `test`, `git`, `documentation` to execute complex tasks. Agents work in sync and handover tasks to each other once they complete their assigned role.

```typescript
const response = await client.callTool({
  name: "dispersl_plan_agent",
  arguments: {
    prompt: "Plan a workflow for building and testing an ExpressJS web app using TypeScript",
    model: "meta-llama/llama-4-maverick:free",
    agents: ["code", "test", "git", "docs"]
  }
});
```


### Example: Code Generation

This agent is able to run autonomously. It can also collaborate with the other agents i.e `code`, `test`, `git`, `documentation` to execute complex tasks. Agents work in sync and handover tasks to each other once they complete their assigned role.

```typescript
const response = await client.callTool({
  name: "dispersl_code_agent",
  arguments: {
    prompt: "Create a simple hello world function",
    model: "meta-llama/llama-4-maverick:free"
  }
});
```

### Example: Add External MCP Server

```typescript
await client.callTool({
  name: "add_mcp_server",
  arguments: {
    name: "my-server",
    command: "node",
    args: ["dist/server.js"],
    env: { PORT: "8080" }
  }
});
```

---

## Development

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev

# Build
npm run build

# Run tests (requires DISPERSL_API_KEY)
npm test

# Lint
npm run lint

# Format code
npm run format
```

---

## Contributing

Contributions are welcome! Please submit a Pull Request.

---

## License

MIT License - see LICENSE file for details
