# Dispersl MCP

A Model Context Protocol (MCP) server for DisperslAPI integration. This server can act as both a server and client, connecting to other MCP servers and executing their tools. It manages sessions and executes tools in a loop until an `end_session` tool is called or streaming multipart/string content is used via a chat endpoint.

## Features

- Model Management: List available models and their capabilities
- Code Generation: Generate code based on prompts
- Testing: Generate tests based on prompts
- Git Operations: Execute Git operations based on prompts
- Documentation: Generate documentation for repositories
- Chat: Interact with the agentic LLM
- API Key Management: Generate and manage API tokens
- Conversation Management: Manage conversations and their history
- MCP Server Management: Connect to other MCP servers

## Installation

#### Cursor

<a href="https://cursor.com/install-mcp?name=dispersl&config=eyJjb21tYW5kIjoibnB4IC15IEBjb2RlZnVuZGkvZGlzcGVyc2wtbWNwIHBrX2xpdmVfc2NlY2VjYWVlaW5sbmozMmxuZmo5OSJ9"><img src="https://cursor.com/deeplink/mcp-install-dark.svg" alt="Add dispersl MCP server to Cursor" height="32" /></a>

#### Node
```bash
npm install dispersl-mcp
```

## Quick Start

```typescript
import { DisperslMCPServer } from "dispersl-mcp";

const server = new DisperslMCPServer();
await server.start(8080);
```

## Usage

### Model Management

```typescript
const response = await client.callTool({
  name: "list_models",
  arguments: {}
});
```

### Code Generation

```typescript
const response = await client.callTool({
  name: "build_code",
  arguments: {
    prompt: "Create a simple hello world function",
    model: "meta-llama/llama-4-maverick:free"
  }
});
```

### Testing

```typescript
const response = await client.callTool({
  name: "build_tests",
  arguments: {
    prompt: "Create tests for a hello world function",
    model: "meta-llama/llama-4-maverick:free"
  }
});
```

### Git Operations

```typescript
const response = await client.callTool({
  name: "git_operation",
  arguments: {
    prompt: "Initialize a new Git repository",
    model: "meta-llama/llama-4-maverick:free"
  }
});
```

### Documentation

```typescript
const response = await client.callTool({
  name: "generate_docs",
  arguments: {
    url: "https://github.com/example/repo",
    model: "meta-llama/llama-4-maverick:free"
  }
});
```

### Chat

```typescript
// Start a session
await client.callTool({
  name: "start_session",
  arguments: {
    session_id: "my-session"
  }
});

// Send a chat message
const response = await client.callTool({
  name: "chat",
  arguments: {
    prompt: "Hello, how are you?",
    model: "meta-llama/llama-4-maverick:free",
    conversation_id: "my-session"
  }
});

// End the session
await client.callTool({
  name: "end_session",
  arguments: {
    session_id: "my-session"
  }
});
```

### API Key Management

```typescript
// Generate a token
const generateResponse = await client.callTool({
  name: "generate_token",
  arguments: {
    name: "my-token",
    user_id: "my-user"
  }
});

// List tokens
const listResponse = await client.callTool({
  name: "list_tokens",
  arguments: {}
});
```

### Conversation Management

```typescript
// List conversations
const listResponse = await client.callTool({
  name: "list_conversations",
  arguments: {}
});

// Get conversation details
const getResponse = await client.callTool({
  name: "get_conversation",
  arguments: {
    conversation_id: "my-conversation"
  }
});
```

### MCP Server Management

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

## Development

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev

# Build
npm run build

# Run tests
npm test

# Lint
npm run lint

# Format code
npm run format
```

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

MIT
