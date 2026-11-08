// UTF-8 editors on Windows may prepend a BOM; it is not part of JSON content.
export function parseProjectJson(text) {
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
}
