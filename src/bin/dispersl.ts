#!/usr/bin/env node
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import inquirer from "inquirer";
import { DisperslMCPServer } from "../server";
import { errorNotification, successNotification, successBGNotification } from "./utils/ui/font";
import { bannerLogo } from "./utils/ui/banner";
import type { MCPTool } from "../types";

// Helper for API key
async function getApiKey(argv: yargs.Arguments): Promise<string> {
  if ((argv as unknown as { key: string }).key) return (argv as unknown as { key: string }).key;
  if (process.env.DISPERSL_API_KEY) return process.env.DISPERSL_API_KEY;
  const { apiKey } = await inquirer.prompt({
    name: "apiKey",
    type: "input",
    message: "Enter your Dispersl API key:",
  });
  return apiKey;
}

// Helper to get tool by name
async function getTool(server: DisperslMCPServer, name: string): Promise<MCPTool | undefined> {
  const tools = await server.getTools();
  return tools.get(name);
}


async function main(): Promise<void> {
  const argv = await yargs(hideBin(process.argv))
    .scriptName("dispersl")
    .option("key", {
      describe: "Dispersl API key",
      type: "string",
    })
    .option("raw", {
      alias: "r",
      describe: "Raw/Markdown output",
      type: "boolean",
    })
    .option("silent", {
      alias: "s",
      describe: "Silent mode (no banners)",
      type: "boolean",
    })
    .command(
      "start",
      "Start the Dispersl MCP server",
      () => { },
      async () => {
        if (!(argv as unknown as { silent: boolean }).silent) bannerLogo();
        const server = new DisperslMCPServer(await getApiKey(argv));
        await server.start();
      }
    )
    .command(
      "chat <prompt>",
      "Chat with the agent",
      (y: yargs.Argv) => y.positional("prompt", { type: "string", describe: "Chat prompt" }),
      async (argv: yargs.Arguments) => {
        if (!(argv as unknown as { silent: boolean }).silent) bannerLogo();
        const server = new DisperslMCPServer(await getApiKey(argv));
        try {
          const tool = await getTool(server, "dispersl_chat_agent");
          const result = tool ? await tool.execute({ prompt: (argv as unknown as { prompt: string }).prompt }) : undefined;
          console.log(successNotification("Chat completed"));
          console.log((result && (result as { text?: string }).text) || result);
        } catch (err) {
          console.error(errorNotification("Chat failed: " + (err instanceof Error ? err.message : String(err))));
        }
      }
    )
    .command(
      "build-code <prompt>",
      "Generate code from a prompt",
      (y: yargs.Argv) => y.positional("prompt", { type: "string", describe: "Prompt for code generation" }),
      async (argv: yargs.Arguments) => {
        if (!(argv as unknown as { silent: boolean }).silent) bannerLogo();
        const server = new DisperslMCPServer(await getApiKey(argv));
        try {
          const tool = await getTool(server, "dispersl_code_agent");
          const result = tool ? await tool.execute({ prompt: (argv as unknown as { prompt: string }).prompt }) : undefined;
          console.log(successNotification("Code generation completed"));
          console.log((result && (result as { text?: string }).text) || result);
        } catch (err) {
          console.error(errorNotification("Code generation failed: " + (err instanceof Error ? err.message : String(err))));
        }
      }
    )
    .command(
      "build-tests <prompt>",
      "Generate tests from a prompt",
      (y: yargs.Argv) => y.positional("prompt", { type: "string", describe: "Prompt for test generation" }),
      async (argv: yargs.Arguments) => {
        if (!(argv as unknown as { silent: boolean }).silent) bannerLogo();
        const server = new DisperslMCPServer(await getApiKey(argv));
        try {
          const tool = await getTool(server, "dispersl_testing_agent");
          const result = tool ? await tool.execute({ prompt: (argv as unknown as { prompt: string }).prompt }) : undefined;
          console.log(successNotification("Test generation completed"));
          console.log((result && (result as { text?: string }).text) || result);
        } catch (err) {
          console.error(errorNotification("Test generation failed: " + (err instanceof Error ? err.message : String(err))));
        }
      }
    )
    .command(
      "generate-docs <url>",
      "Generate documentation for a repo",
      (y: yargs.Argv) => y.positional("url", { type: "string", describe: "Repository URL" }),
      async (argv: yargs.Arguments) => {
        if (!(argv as unknown as { silent: boolean }).silent) bannerLogo();
        const server = new DisperslMCPServer(await getApiKey(argv));
        try {
          const tool = await getTool(server, "dispersl_new_docs_agent");
          const result = tool ? await tool.execute({ url: (argv as unknown as { url: string }).url }) : undefined;
          console.log(successNotification("Documentation generation completed"));
          console.log((result && (result as { text?: string }).text) || result);
        } catch (err) {
          console.error(errorNotification("Documentation generation failed: " + (err instanceof Error ? err.message : String(err))));
        }
      }
    )
    .command(
      "connect <name> <command> [args..]",
      "Connect to an external MCP server",
      (y: yargs.Argv) => y
        .positional("name", { type: "string", describe: "MCP server name" })
        .positional("command", { type: "string", describe: "Command to run MCP server" })
        .positional("args", { type: "string", array: true, describe: "Arguments for the command" }),
      async (argv: yargs.Arguments) => {
        if (!(argv as unknown as { silent: boolean }).silent) bannerLogo();
        const server = new DisperslMCPServer(await getApiKey(argv));
        try {
          const tool = await getTool(server, "add_mcp_server");
          await tool?.execute({ name: (argv as unknown as { name: string }).name, command: (argv as unknown as { command: string }).command, args: (argv as unknown as { args: string[] }).args || [] });
          console.log(successBGNotification("Connected to MCP server."));
        } catch (err) {
          console.error(errorNotification("Failed to connect to MCP server: " + (err instanceof Error ? err.message : String(err))));
        }
      }
    )
    .command(
      "session <action> <session_id>",
      "Start or end a session",
      (y: yargs.Argv) => y
        .positional("action", { type: "string", choices: ["start", "end"], describe: "Action" })
        .positional("session_id", { type: "string", describe: "Session ID" }),
      async (argv: yargs.Arguments) => {
        if (!(argv as unknown as { silent: boolean }).silent) bannerLogo();
        const server = new DisperslMCPServer(await getApiKey(argv));
        try {
          if ((argv as unknown as { action: string }).action === "start") {
            const tool = await getTool(server, "start_session");
            await tool?.execute({ session_id: (argv as unknown as { session_id: string }).session_id });
            console.log(successNotification(`Session ${(argv as unknown as { session_id: string }).session_id} started.`));
          } else {
            const tool = await getTool(server, "end_session");
            await tool?.execute({ session_id: (argv as unknown as { session_id: string }).session_id });
            console.log(successNotification(`Session ${(argv as unknown as { session_id: string }).session_id} ended.`));
          }
        } catch (err) {
          console.error(errorNotification("Session operation failed: " + (err instanceof Error ? err.message : String(err))));
        }
      }
    )
    .help()
    .strict()
    .parseAsync();
}

main();