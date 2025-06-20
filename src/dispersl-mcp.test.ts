import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { DisperslMCPServer } from "./server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

describe("DisperslMCPServer", () => {
  let server: DisperslMCPServer;
  let client: Client;

  beforeAll(async () => {
    // Start the server
    server = new DisperslMCPServer();
    await server.start(8080); // Use a different port for testing

    // Create a client to connect to the server
    const transport = new StdioClientTransport({
      command: "node",
      args: ["dist/server.js"],
      env: { PORT: "8080" }
    });

    client = new Client({
      name: "test-client",
      version: "0.1.0",
      transport
    });

    await client.connect(transport);
  });

  afterAll(async () => {
    await server.stop();
  });

  describe("Model Management", () => {
    it("should list available models", async () => {
      const response = await client.callTool({
        name: "list_models",
        arguments: {}
      });

      expect(response.status).toBe("success");
      expect(response.models).toBeDefined();
      const models = response.models as any[];
      expect(models.length).toBeGreaterThan(0);
      expect(models[0]).toHaveProperty("id");
      expect(models[0]).toHaveProperty("name");
      expect(models[0]).toHaveProperty("description");
      expect(models[0]).toHaveProperty("context_length");
      expect(models[0]).toHaveProperty("tier_requirements");
    });
  });

  describe("Code Generation", () => {
    it("should generate code based on a prompt", async () => {
      const response = await client.callTool({
        name: "build_code",
        arguments: {
          prompt: "Create a simple hello world function",
          model: "meta-llama/llama-4-maverick:free"
        }
      });

      expect(response.status).toBe("success");
      expect(response.content).toBeDefined();
    });
  });

  describe("Testing", () => {
    it("should generate tests based on a prompt", async () => {
      const response = await client.callTool({
        name: "build_tests",
        arguments: {
          prompt: "Create tests for a hello world function",
          model: "meta-llama/llama-4-maverick:free"
        }
      });

      expect(response.status).toBe("success");
      expect(response.content).toBeDefined();
    });
  });

  describe("Git Operations", () => {
    it("should execute Git operations based on a prompt", async () => {
      const response = await client.callTool({
        name: "git_operation",
        arguments: {
          prompt: "Initialize a new Git repository",
          model: "meta-llama/llama-4-maverick:free"
        }
      });

      expect(response.status).toBe("success");
      expect(response.content).toBeDefined();
    });
  });

  describe("Documentation", () => {
    it("should generate documentation for a repository", async () => {
      const response = await client.callTool({
        name: "generate_docs",
        arguments: {
          url: "https://github.com/example/repo",
          model: "meta-llama/llama-4-maverick:free"
        }
      });

      expect(response.status).toBe("success");
      expect(response.content).toBeDefined();
    });
  });

  describe("Chat", () => {
    it("should handle chat interactions", async () => {
      // Start a session
      await client.callTool({
        name: "start_session",
        arguments: {
          session_id: "test-session"
        }
      });

      // Send a chat message
      const response = await client.callTool({
        name: "chat",
        arguments: {
          prompt: "Hello, how are you?",
          model: "meta-llama/llama-4-maverick:free",
          conversation_id: "test-session"
        }
      });

      expect(response.status).toBe("success");
      expect(response.content).toBeDefined();
      expect(Array.isArray(response.content)).toBe(true);

      // End the session
      await client.callTool({
        name: "end_session",
        arguments: {
          session_id: "test-session"
        }
      });
    });
  });

  describe("API Key Management", () => {
    it("should generate and list API tokens", async () => {
      // Generate a token
      const generateResponse = await client.callTool({
        name: "generate_token",
        arguments: {
          name: "test-token",
          user_id: "test-user"
        }
      });

      expect(generateResponse.status).toBe("success");
      expect(generateResponse.publicKey).toBeDefined();
      expect(generateResponse.message).toBeDefined();

      // List tokens
      const listResponse = await client.callTool({
        name: "list_tokens",
        arguments: {}
      });

      expect(listResponse.status).toBe("success");
      expect(listResponse.apiKeys).toBeDefined();
      expect(Array.isArray(listResponse.apiKeys)).toBe(true);
    });
  });

  describe("Conversation Management", () => {
    it("should manage conversations", async () => {
      // Start a session
      await client.callTool({
        name: "start_session",
        arguments: {
          session_id: "test-conversation"
        }
      });

      // Send a chat message
      await client.callTool({
        name: "chat",
        arguments: {
          prompt: "Hello, this is a test conversation",
          model: "meta-llama/llama-4-maverick:free",
          conversation_id: "test-conversation"
        }
      });

      // List conversations
      const listResponse = await client.callTool({
        name: "list_conversations",
        arguments: {}
      });

      expect(listResponse.status).toBe("success");
      expect(listResponse.conversations).toBeDefined();
      expect(Array.isArray(listResponse.conversations)).toBe(true);

      // Get conversation details
      const getResponse = await client.callTool({
        name: "get_conversation",
        arguments: {
          conversation_id: "test-conversation"
        }
      });

      expect(getResponse.status).toBe("success");
      expect(getResponse.conversation).toBeDefined();
      const conversation = getResponse.conversation as any;
      expect(conversation?.id).toBe("test-conversation");
      expect(conversation?.messages).toBeDefined();
      expect(Array.isArray(conversation?.messages)).toBe(true);

      // End the session
      await client.callTool({
        name: "end_session",
        arguments: {
          session_id: "test-conversation"
        }
      });
    });
  });

  describe("MCP Server Management", () => {
    it("should connect to other MCP servers", async () => {
      const response = await client.callTool({
        name: "add_mcp_server",
        arguments: {
          name: "test-server",
          command: "node",
          args: ["dist/server.js"],
          env: { PORT: "8082" }
        }
      });

      expect(response).toBeUndefined(); // The tool returns void
    });
  });
}); 