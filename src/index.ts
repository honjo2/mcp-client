import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z, ZodTypeAny } from 'zod';
import {
  CallToolResultSchema,
  TextContentSchema,
} from '@modelcontextprotocol/sdk/types.js';
import OpenAI from 'openai';
import dotenv from 'dotenv';

dotenv.config();

/* ╭──────────────────────────────────────────────╮
   │ 1. MCP サーバ定義の読み込み                    │
   ╰──────────────────────────────────────────────╯ */
type MCPServersConfig = {
  mcpServers: Record<
    string,
    { command: string; args: string[]; env?: Record<string, string> }
  >;
};

const cfgPath = resolve(process.cwd(), 'config.json');
const cfg: MCPServersConfig = JSON.parse(readFileSync(cfgPath, 'utf8'));

/* ╭──────────────────────────────────────────────╮
   │ 2. ツールメタデータ（Function 定義）           │
   ╰──────────────────────────────────────────────╯ */
async function getToolDefinitions() {
  const toolDefinitions = [];

  for (const [serverKey, serverConfig] of Object.entries(cfg.mcpServers)) {
    const transport = new StdioClientTransport({
      command: serverConfig.command,
      args: serverConfig.args,
      env: serverConfig.env,
    });

    const client = new Client({ name: 'mcp-client', version: '2.0.0' });
    await client.connect(transport);

    const tools = (await client.listTools()).tools;
    console.log('Debug tools:', tools);
    toolDefinitions.push(
      ...(
        tools as unknown as Array<{
          name: string;
          description: string;
          parameters: unknown;
        }>
      ).map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        serverKey,
        toolName: tool.name,
      }))
    );

    await transport.close();
  }

  return toolDefinitions;
}

type ToolName = Awaited<ReturnType<typeof getToolDefinitions>>[number]['name'];

/* ╭──────────────────────────────────────────────╮
   │ 3. OpenAI 初期化                              │
   ╰──────────────────────────────────────────────╯ */
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/* ╭──────────────────────────────────────────────╮
   │ 4. LLM でどのツールを呼ぶか推論                │
   ╰──────────────────────────────────────────────╯ */
async function chooseTool(
  userQuestion: string
): Promise<{ name: string; arguments: Record<string, unknown> }> {
  const toolDefinitions = await getToolDefinitions();

  const MODEL_CANDIDATES = ['gpt-3.5-turbo-0125', 'gpt-4o-release'];

  for (const model of MODEL_CANDIDATES) {
    const response = await openai.chat.completions.create({
      model,
      messages: [
        {
          role: 'system',
          content:
            `あなたはシステム操作のエキスパートです。` +
            `利用可能なツールの機能を理解し、ユーザーの要求に最適なツールを選択します。` +
            `各ツールの説明（description）を注意深く確認し、要求に最も適したツールを1つ選んでください。` +
            `選択したツールの呼び出しをJSON形式で返してください。` +
            `通常の文章は返さず、ツールの呼び出し情報のみを返してください。`,
        },
        { role: 'user', content: userQuestion },
      ],
      tools: toolDefinitions.map(({ name, description, parameters }) => ({
        type: 'function',
        function: {
          name,
          description,
          parameters: parameters as any,
        },
      })),
      tool_choice: 'auto',
    });

    const call = response.choices[0].message.tool_calls?.[0];
    if (call) {
      // console.log('Debug tool arguments:', call.function.arguments);
      if (typeof call.function.arguments === 'string') {
        const args = JSON.parse(call.function.arguments);
        if (Object.keys(args).length === 0) {
          args.path = process.env.DEFAULT_PATH || '/Users/honjo2/Desktop';
        }
        call.function.arguments = JSON.stringify(args);
      }
      return {
        name: call.function.name,
        arguments: JSON.parse(call.function.arguments ?? '{}'),
      };
    }

    console.warn(`model=${model} はツールを提案せず → フォールバック`);
  }

  throw new Error('LLM がツール呼び出しを提案しませんでした（全モデル失敗）');
}

/* ╭──────────────────────────────────────────────╮
   │ 5. MCP 経由で実ツールを呼び出す                │
   ╰──────────────────────────────────────────────╯ */
async function callMcpTool(
  name: ToolName,
  args: Record<string, unknown>
): Promise<string[]> {
  const toolDefinitions = await getToolDefinitions();
  const def = toolDefinitions.find((d) => d.name === name)!;
  const server = cfg.mcpServers[def.serverKey];
  if (!server) throw new Error(`サーバ設定が見つかりません: ${def.serverKey}`);

  const transport = new StdioClientTransport({
    command: server.command,
    args: server.args,
    env: server.env,
  });

  const client = new Client({ name: 'mcp-client', version: '2.0.0' });
  await client.connect(transport);

  const raw = await client.callTool({
    name: def.toolName,
    arguments: args,
  });

  const parsed = CallToolResultSchema.parse(raw);
  return parsed.content
    .filter((c): c is z.infer<typeof TextContentSchema> => c.type === 'text')
    .map((c) => c.text.trim());
}

/* ╭──────────────────────────────────────────────╮
   │ 6. エントリポイント                            │
   ╰──────────────────────────────────────────────╯ */
async function executeTool(
  toolName: string,
  toolArgs: Record<string, unknown>
): Promise<void> {
  console.log('実行するツール:', toolName);
  console.log('ツールの引数:', JSON.stringify(toolArgs, null, 2));

  const result = await callMcpTool(toolName, toolArgs);
  console.log('=== 実行結果 ===');
  console.log(result.join('\n'));
}

async function main(): Promise<void> {
  const question =
    process.argv.slice(2).join(' ') ||
    'デスクトップにあるファイルのファイル名をリスト化して';

  const { name: toolName, arguments: toolArgs } = await chooseTool(question);
  await executeTool(toolName, toolArgs);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
