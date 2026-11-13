/**
 * 入口（计划 §8 / §9 / §7.8）。
 *
 * 流程只有三步：**读配置 → buildApp → listen**。
 * 所有逻辑都在 `config.ts` / `app.ts` 里，集成测试可以直接复用 `buildApp(config)`。
 *
 * 启动横幅（计划 §7.8）必须明确打印：
 * `public origin · masking=<mode> · token gate=on/off`
 * —— 防止误以为自己是「本地私有实例」而把 origin IP 暴露在公网。
 */

import { buildApp } from './app.js';
import { type Config, loadConfig } from './config.js';

/** 启动横幅（计划 §7.8）。 */
export function banner(config: Config): string[] {
  const lines = [
    `reqpeek · public origin · masking=${config.maskMode} · token gate=${
      config.tokenGate ? 'on' : 'off'
    }`,
    `  host=${config.host} port=${config.port} trust-proxy=${config.trustProxyRaw} body-limit=${config.bodyLimit} display-limit=${config.displayLimit} rate-limit=${
      config.rateLimit ? 'on' : 'off'
    } log-level=${config.logLevel}`,
  ];

  if (config.tokenGate) {
    lines.push('  回源需带请求头 x-origin-token（CDN 回源规则里配上即可）');
  } else {
    // 计划 §12：忘了开 token 就在横幅里红字告警
    lines.push('  [!] token gate=off：origin IP 暴露在公网，请确认这是有意为之');
  }

  return lines;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const app = buildApp(config);

  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === 'EADDRINUSE') {
      console.error(`端口 ${config.port} 已被占用，换一个 PORT 再试。`);
    } else {
      console.error('启动失败：', error instanceof Error ? error.message : error);
    }
    process.exitCode = 1;
    await app.close();
    return;
  }

  console.log(banner(config).join('\n'));

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void app.close().finally(() => {
        process.exit(0);
      });
    });
  }
}

main().catch((error: unknown) => {
  console.error('启动失败：', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
