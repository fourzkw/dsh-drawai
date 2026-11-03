/* 由 tools/build.mjs 生成 —— 请勿直接编辑；改 src/ 下的源文件。 */
/** Shared command dispatch; adapters supply operations, the core owns isolation. */
import { documentTransaction } from './document-core.js'

export function createDocumentCommands(handlers) {
  return {
    execute(current, command, options) {
      if (!command || typeof command.type !== 'string' || !Object.hasOwn(handlers, command.type)) throw new Error('未知画布命令')
      return documentTransaction(current, (draft) => handlers[command.type](draft, command), options)
    },
  }
}
