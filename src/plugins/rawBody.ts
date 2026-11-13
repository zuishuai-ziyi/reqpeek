/**
 * 原始 body 接管（计划 §5.1）。
 *
 * Fastify 自带的 `application/json` / `text/plain` 解析器会把**原始字节吃掉**，
 * 本项目要展示「收到的到底是什么字节」，所以先把它们摘掉，再用一个通配解析器
 * 把字节原样挂到 `request.rawBody`。
 *
 * 关键点：
 * - `addContentTypeParser('*')` 在 Fastify 内部注册为「兜底解析器」，
 *   只有在**没有任何更精确的解析器命中**时才会被调用 —— 所以必须先
 *   `removeContentTypeParser` 掉 json / text / form 三种，否则它们会先命中。
 * - 解析器的 bodyLimit 就是「接收上限」（计划 §6.6 的 1 MiB），
 *   超限由 Fastify 抛 `FST_ERR_CTP_BODY_TOO_LARGE`，交给 app.ts 的 errorHandler 转 413。
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** 原始请求字节（未接管前是 undefined） */
    rawBody?: Buffer;
  }
}

/** 要摘掉的默认解析器（x-www-form-urlencoded 本来就没有，摘了也无副作用） */
const REPLACED_PARSERS = ['application/json', 'text/plain', 'application/x-www-form-urlencoded'];

export function registerRawBody(app: FastifyInstance, config: Config): void {
  for (const type of REPLACED_PARSERS) {
    try {
      app.removeContentTypeParser(type);
    } catch {
      // 未注册则忽略（计划 §5.1 的注释就是这一句）
    }
  }

  app.addContentTypeParser<Buffer>(
    '*',
    { parseAs: 'buffer', bodyLimit: config.bodyLimit },
    (request: FastifyRequest, payload: Buffer, done) => {
      request.rawBody = payload;
      // body 本身不参与业务：解析交给 core/body.ts 的嗅探器
      done(null, undefined);
    },
  );
}
