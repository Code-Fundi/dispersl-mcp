#!/usr/bin/env node
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import inquirer from "inquirer";
import { existsSync, readFileSync } from "fs";
import { DisperslMCPServer } from "../server";
import { errorNotification, successNotification, successBGNotification } from "./utils/ui/font";
import { bannerLogo } from "./utils/ui/banner";

// Helper for API key
async function getApiKey(argv: any): Promise<string> {
  if (argv.key) return argv.key;
  if (process.env.DISPERSL_API_KEY) return process.env.DISPERSL_API_KEY;
  const { apiKey } = await inquirer.prompt({
    name: "apiKey",
    type: "input",
    message: "Enter your Dispersl API key:",
  });
  return apiKey;
}

// Helper to get tool by name
async function getTool(server: DisperslMCPServer, name: string) {
  const tools = await server.getTools();
  return tools.get(name);
}

// Interactive feature selection
async function interactive(server: DisperslMCPServer, apiKey: string) {
  let active = true;
  while (active) {
    const { feature } = await inquirer.prompt({
      name: "feature",
      type: "list",
      message: "Select an option:",
      choices: [
        "Chat",
        "Build Code",
        "Build Tests",
        "Generate Docs",
        "Connect MCP Server",
        "Start Session",
        "End Session",
        "Exit",
      ],
    });
    switch (feature) {
      case "Chat": {
        const { prompt } = await inquirer.prompt({
          name: "prompt",
          type: "input",
          message: "Type your chat prompt:",
        });
        try {
          console.log(successNotification("Chat selected"));
          const tool = await getTool(server, "chat");
          const result = tool ? await tool.execute({ prompt }) : undefined;
          console.log((result && (result as any).text) || result);
        } catch (err) {
          console.error(errorNotification("Chat failed: " + (err instanceof Error ? err.message : String(err))));
        }
        break;
      }
      case "Build Code": {
        const { prompt } = await inquirer.prompt({
          name: "prompt",
          type: "input",
          message: "Describe the code to generate:",
        });
        try {
          console.log(successNotification("Build Code selected"));
          const tool = await getTool(server, "build_code");
          const result = tool ? await tool.execute({ prompt }) : undefined;
          console.log((result && (result as any).text) || result);
        } catch (err) {
          console.error(errorNotification("Build Code failed: " + (err instanceof Error ? err.message : String(err))));
        }
        break;
      }
      case "Build Tests": {
        const { prompt } = await inquirer.prompt({
          name: "prompt",
          type: "input",
          message: "Describe the tests to generate:",
        });
        try {
          console.log(successNotification("Build Tests selected"));
          const tool = await getTool(server, "build_tests");
          const result = tool ? await tool.execute({ prompt }) : undefined;
          console.log((result && (result as any).text) || result);
        } catch (err) {
          console.error(errorNotification("Build Tests failed: " + (err instanceof Error ? err.message : String(err))));
        }
        break;
      }
      case "Generate Docs": {
        const { url } = await inquirer.prompt({
          name: "url",
          type: "input",
          message: "Repository URL:",
        });
        try {
          console.log(successNotification("Generate Docs selected"));
          const tool = await getTool(server, "generate_docs");
          const result = tool ? await tool.execute({ url }) : undefined;
          console.log((result && (result as any).text) || result);
        } catch (err) {
          console.error(errorNotification("Generate Docs failed: " + (err instanceof Error ? err.message : String(err))));
        }
        break;
      }
      case "Connect MCP Server": {
        const { name, command, args } = await inquirer.prompt([
          { name: "name", type: "input", message: "MCP Server Name:" },
          { name: "command", type: "input", message: "Command to run server:" },
          { name: "args", type: "input", message: "Args (comma separated):" },
        ]);
        try {
          const tool = await getTool(server, "add_mcp_server");
          await tool?.execute({ name, command, args: args.split(",") });
          console.log(successBGNotification("Connected to MCP server."));
        } catch (err) {
          console.error(errorNotification("Failed to connect to MCP server: " + (err instanceof Error ? err.message : String(err))));
        }
        break;
      }
      case "Start Session": {
        const { session_id } = await inquirer.prompt({
          name: "session_id",
          type: "input",
          message: "Session ID:",
        });
        try {
          const tool = await getTool(server, "start_session");
          await tool?.execute({ session_id });
          console.log(successBGNotification(`Session ${session_id} started.`));
        } catch (err) {
          console.error(errorNotification("Failed to start session: " + (err instanceof Error ? err.message : String(err))));
        }
        break;
      }
      case "End Session": {
        const { session_id } = await inquirer.prompt({
          name: "session_id",
          type: "input",
          message: "Session ID to end:",
        });
        try {
          const tool = await getTool(server, "end_session");
          await tool?.execute({ session_id });
          console.log(successBGNotification(`Session ${session_id} ended.`));
        } catch (err) {
          console.error(errorNotification("Failed to end session: " + (err instanceof Error ? err.message : String(err))));
        }
        break;
      }
      case "Exit":
        active = false;
        break;
    }
  }
}

async function main() {
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
        if (!argv.silent) bannerLogo();
        const server = new DisperslMCPServer();
        await server.start();
      }
    )
    .command(
      "chat <prompt>",
      "Chat with the agent",
      (y: any) => y.positional("prompt", { type: "string", describe: "Chat prompt" }),
      async (argv: any) => {
        if (!argv.silent) bannerLogo();
        const server = new DisperslMCPServer();
        const tool = await getTool(server, "chat");
        const result = tool ? await tool.execute({ prompt: argv.prompt }) : undefined;
        console.log((result && (result as any).text) || result);
      }
    )
    .command(
      "build-code <prompt>",
      "Generate code from a prompt",
      (y: any) => y.positional("prompt", { type: "string", describe: "Prompt for code generation" }),
      async (argv: any) => {
        if (!argv.silent) bannerLogo();
        const server = new DisperslMCPServer();
        const tool = await getTool(server, "build_code");
        const result = tool ? await tool.execute({ prompt: argv.prompt }) : undefined;
        console.log((result && (result as any).text) || result);
      }
    )
    .command(
      "build-tests <prompt>",
      "Generate tests from a prompt",
      (y: any) => y.positional("prompt", { type: "string", describe: "Prompt for test generation" }),
      async (argv: any) => {
        if (!argv.silent) bannerLogo();
        const server = new DisperslMCPServer();
        const tool = await getTool(server, "build_tests");
        const result = tool ? await tool.execute({ prompt: argv.prompt }) : undefined;
        console.log((result && (result as any).text) || result);
      }
    )
    .command(
      "generate-docs <url>",
      "Generate documentation for a repo",
      (y: any) => y.positional("url", { type: "string", describe: "Repository URL" }),
      async (argv: any) => {
        if (!argv.silent) bannerLogo();
        const server = new DisperslMCPServer();
        const tool = await getTool(server, "generate_docs");
        const result = tool ? await tool.execute({ url: argv.url }) : undefined;
        console.log((result && (result as any).text) || result);
      }
    )
    .command(
      "connect <name> <command> [args..]",
      "Connect to an external MCP server",
      (y: any) => y
        .positional("name", { type: "string", describe: "MCP server name" })
        .positional("command", { type: "string", describe: "Command to run MCP server" })
        .positional("args", { type: "string", array: true, describe: "Arguments for the command" }),
      async (argv: any) => {
        if (!argv.silent) bannerLogo();
        const server = new DisperslMCPServer();
        const tool = await getTool(server, "add_mcp_server");
        await tool?.execute({ name: argv.name, command: argv.command, args: argv.args || [] });
        console.log("Connected to MCP server.");
      }
    )
    .command(
      "session <action> <session_id>",
      "Start or end a session",
      (y: any) => y
        .positional("action", { type: "string", choices: ["start", "end"], describe: "Action" })
        .positional("session_id", { type: "string", describe: "Session ID" }),
      async (argv: any) => {
        if (!argv.silent) bannerLogo();
        const server = new DisperslMCPServer();
        if (argv.action === "start") {
          const tool = await getTool(server, "start_session");
          await tool?.execute({ session_id: argv.session_id });
          console.log(`Session ${argv.session_id} started.`);
        } else {
          const tool = await getTool(server, "end_session");
          await tool?.execute({ session_id: argv.session_id });
          console.log(`Session ${argv.session_id} ended.`);
        }
      }
    )
    .help()
    .strict()
    .parseAsync();

  const apiKey = await getApiKey(argv);

  // If no command, run interactive
  if (process.argv.length <= 2) {
    if (!argv.silent) bannerLogo();
    const server = new DisperslMCPServer(apiKey);
    await interactive(server, apiKey);
    return;
  }

  // For each command, pass apiKey to DisperslMCPServer
  yargs(hideBin(process.argv))
    .command(
      "start",
      "Start the Dispersl MCP server",
      () => { },
      async () => {
        if (!argv.silent) bannerLogo();
        const server = new DisperslMCPServer(apiKey);
        await server.start();
      }
    )
    .command(
      "chat <prompt>",
      "Chat with the agent",
      (y: any) => y.positional("prompt", { type: "string", describe: "Chat prompt" }),
      async (argv: any) => {
        if (!argv.silent) bannerLogo();
        const server = new DisperslMCPServer(apiKey);
        const tool = await getTool(server, "chat");
        const result = tool ? await tool.execute({ prompt: argv.prompt }) : undefined;
        console.log((result && (result as any).text) || result);
      }
    )
    .command(
      "build-code <prompt>",
      "Generate code from a prompt",
      (y: any) => y.positional("prompt", { type: "string", describe: "Prompt for code generation" }),
      async (argv: any) => {
        if (!argv.silent) bannerLogo();
        const server = new DisperslMCPServer(apiKey);
        const tool = await getTool(server, "build_code");
        const result = tool ? await tool.execute({ prompt: argv.prompt }) : undefined;
        console.log((result && (result as any).text) || result);
      }
    )
    .command(
      "build-tests <prompt>",
      "Generate tests from a prompt",
      (y: any) => y.positional("prompt", { type: "string", describe: "Prompt for test generation" }),
      async (argv: any) => {
        if (!argv.silent) bannerLogo();
        const server = new DisperslMCPServer(apiKey);
        const tool = await getTool(server, "build_tests");
        const result = tool ? await tool.execute({ prompt: argv.prompt }) : undefined;
        console.log((result && (result as any).text) || result);
      }
    )
    .command(
      "generate-docs <url>",
      "Generate documentation for a repo",
      (y: any) => y.positional("url", { type: "string", describe: "Repository URL" }),
      async (argv: any) => {
        if (!argv.silent) bannerLogo();
        const server = new DisperslMCPServer(apiKey);
        const tool = await getTool(server, "generate_docs");
        const result = tool ? await tool.execute({ url: argv.url }) : undefined;
        console.log((result && (result as any).text) || result);
      }
    )
    .command(
      "connect <name> <command> [args..]",
      "Connect to an external MCP server",
      (y: any) => y
        .positional("name", { type: "string", describe: "MCP server name" })
        .positional("command", { type: "string", describe: "Command to run MCP server" })
        .positional("args", { type: "string", array: true, describe: "Arguments for the command" }),
      async (argv: any) => {
        if (!argv.silent) bannerLogo();
        const server = new DisperslMCPServer(apiKey);
        const tool = await getTool(server, "add_mcp_server");
        await tool?.execute({ name: argv.name, command: argv.command, args: argv.args || [] });
        console.log("Connected to MCP server.");
      }
    )
    .command(
      "session <action> <session_id>",
      "Start or end a session",
      (y: any) => y
        .positional("action", { type: "string", choices: ["start", "end"], describe: "Action" })
        .positional("session_id", { type: "string", describe: "Session ID" }),
      async (argv: any) => {
        if (!argv.silent) bannerLogo();
        const server = new DisperslMCPServer(apiKey);
        if (argv.action === "start") {
          const tool = await getTool(server, "start_session");
          await tool?.execute({ session_id: argv.session_id });
          console.log(`Session ${argv.session_id} started.`);
        } else {
          const tool = await getTool(server, "end_session");
          await tool?.execute({ session_id: argv.session_id });
          console.log(`Session ${argv.session_id} ended.`);
        }
      }
    )
    .help()
    .strict()
    .parseAsync();
}

main();