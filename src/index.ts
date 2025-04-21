import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';
import {
  CallToolResultSchema,
  TextContentSchema,
} from '@modelcontextprotocol/sdk/types.js'; // ← CallToolResultSchema と TextContentSchema は SDK が提供&#8203;:contentReference[oaicite:0]{index=0}

/* ──────────────────────────────────────────────────────────
   型定義
────────────────────────────────────────────────────────── */

type MCPServersConfig = {
  mcpServers: Record<
    string,
    { command: string; args: string[]; env?: Record<string, string> }
  >;
};

interface Plan {
  serverKey: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
}

/* ──────────────────────────────────────────────────────────
   設定ファイル読み込み
────────────────────────────────────────────────────────── */

const configPath = resolve(process.cwd(), 'config.json');
const config: MCPServersConfig = JSON.parse(readFileSync(configPath, 'utf8'));

/* ──────────────────────────────────────────────────────────
   質問 → ツール呼び出しプラン策定
────────────────────────────────────────────────────────── */

function planFor(question: string): Plan {
  if (question.includes('デスクトップ')) {
    return {
      serverKey: 'filesystem',
      toolName: 'list_directory', // server-filesystem が提供する標準ツール
      toolArgs: { path: '/Users/honjo2/Desktop' },
    };
  }
  throw new Error(
    `質問に対応する MCP サーバ／ツールが見つかりません: ${question}`
  );
}

/* ──────────────────────────────────────────────────────────
   メイン処理
────────────────────────────────────────────────────────── */

async function main() {
  // ユーザの質問は CLI 引数からも受け取れるように
  const userQuestion =
    process.argv[2] ?? 'デスクトップにあるファイルのファイル名をリスト化して';

  const { serverKey, toolName, toolArgs } = planFor(userQuestion);
  const serverConf = config.mcpServers[serverKey];
  if (!serverConf) {
    throw new Error(`設定に ${serverKey} の MCP サーバが定義されていません`);
  }

  // Stdio 経由で MCP サーバを子プロセス起動
  const transport = new StdioClientTransport({
    command: serverConf.command,
    args: serverConf.args,
    env: serverConf.env,
  });

  const client = new Client({
    name: 'desktop-lister',
    version: '1.0.0',
  });

  await client.connect(transport);

  // ツール呼び出し
  const rawResult = await client.callTool({
    name: toolName,
    arguments: toolArgs,
  });

  // スキーマ検証で型付け
  const parsed = CallToolResultSchema.parse(rawResult);

  // text コンテンツのみ抽出
  const filenames = parsed.content
    .filter(
      (item): item is z.infer<typeof TextContentSchema> => item.type === 'text'
    )
    .map((item) => item.text.trim());

  console.log('=== デスクトップのファイル一覧 ===');
  console.log(filenames.join('\n'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
