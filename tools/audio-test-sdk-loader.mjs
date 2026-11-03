// Test adapter for hosts where the DSH SDK is unavailable. Preserve the JSON
// argument boundary so nested tool calls cannot silently pass undefined.
const adapter = `
function check(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) { for (const item of value) check(item); return; }
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    for (const item of Object.values(value)) check(item);
    return;
  }
  throw new Error('invalid arguments: "arguments" must be a lossless JSON object');
}
export function defineTool(tool) {
  const execute = tool.execute;
  return {...tool, execute(args, exec) { check(args); return execute.call(this, args, exec); }};
}
`

export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@deepseek-ai/dsh-tools') {
    return {url: 'data:text/javascript,' + encodeURIComponent(adapter), shortCircuit: true}
  }
  return nextResolve(specifier, context)
}
