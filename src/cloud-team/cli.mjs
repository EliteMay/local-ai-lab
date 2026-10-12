import { pathToFileURL } from 'node:url';
import { runTeam, createMockAsk } from './team.mjs';
import { createCloudAsk } from './providers.mjs';

function parseArgs(args) {
  const options = { provider: 'mock', mode: 'chat', rounds: 1 };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--help') return { help: true };
    if (!['--topic', '--mode', '--rounds', '--provider', '--model'].includes(arg) || !args[i + 1]) {
      throw new Error('不明な引数または値がありません: ' + arg);
    }
    options[arg.slice(2)] = args[++i];
  }
  options.rounds = Number(options.rounds);
  return options;
}

export async function main(args = process.argv.slice(2), env = process.env) {
  const options = parseArgs(args);
  if (options.help) {
    console.log('node src/cloud-team/cli.mjs --topic "話題" --mode chat|dev --rounds 1..3 --provider mock|gemini|openrouter --model MODEL');
    return;
  }
  const ask = options.provider === 'mock' ? createMockAsk() : createCloudAsk({ ...options, env });
  const result = await runTeam({ ...options, ask, onTurn(turn) {
    console.log('\n【' + turn.round + '周目 / ' + turn.label + '】\n' + turn.message);
  }});
  console.log('\n完了: ' + result.calls + '回のAI発言。実行・GitHub書込みは行っていません。');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error('停止: ' + error.message); process.exitCode = 1; });
}
