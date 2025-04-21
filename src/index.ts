import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';
import {
  CallToolResultSchema,
  TextContentSchema,
} from '@modelcontextprotocol/sdk/types.js';
import OpenAI from 'openai';

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
const TOOL_DEFINITIONS = [
  {
    name: 'list_directory',
    description: '指定されたパスの直下にあるファイル／ディレクトリ名を列挙する',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '絶対パス（例: /Users/honjo2/Desktop）',
        },
      },
      required: ['path'],
    },
    // MCP 側マッピング
    serverKey: 'filesystem',
    toolName: 'list_directory',
  },
] as const;

type ToolName = (typeof TOOL_DEFINITIONS)[number]['name'];

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
): Promise<{ name: ToolName; arguments: Record<string, unknown> }> {
  // 1️⃣ Function‑Calling 対応が確認済みのモデルを使う
  const MODEL_CANDIDATES = ['gpt-3.5-turbo-0125', 'gpt-4o-release'];

  for (const model of MODEL_CANDIDATES) {
    const response = await openai.chat.completions.create({
      model,
      messages: [
        {
          role: 'system',
          content:
            `あなたはツールオーケストレーターです。` +
            `一覧から *最適なツールを 1 つだけ* 選び、その function 呼び出しを JSON 形式で返してください。` +
            `それ以外の通常文章は返さないでください。`,
        },
        { role: 'user', content: userQuestion },
      ],
      tools: TOOL_DEFINITIONS.map(({ name, description, parameters }) => ({
        type: 'function',
        function: { name, description, parameters },
      })),
      tool_choice: 'auto', // ✨ 強制的に function 呼び出しを狙う
    });

    const call = response.choices[0].message.tool_calls?.[0];
    if (call) {
      return {
        name: call.function.name as ToolName,
        arguments: JSON.parse(call.function.arguments ?? '{}'),
      };
    }

    // ツール提案がなければ次のモデルでリトライ
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
  const def = TOOL_DEFINITIONS.find((d) => d.name === name)!;
  const server = cfg.mcpServers[def.serverKey];
  if (!server) throw new Error(`サーバ設定が見つかりません: ${def.serverKey}`);

  const transport = new StdioClientTransport({
    command: server.command,
    args: server.args,
    env: server.env,
  });

  const client = new Client({ name: 'desktop-lister', version: '2.0.0' });
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
async function main() {
  const question =
    process.argv.slice(2).join(' ') ||
    'デスクトップにあるファイルのファイル名をリスト化して';

  const { name, arguments: toolArgs } = await chooseTool(question);
  const filenames = await callMcpTool(name, toolArgs);

  console.log('=== 取得結果 ===');
  console.log(filenames.join('\n'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
