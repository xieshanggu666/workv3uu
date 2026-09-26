// 测试 loader：将 node:sqlite 重定向到 sql.js 垫片
export async function resolve(specifier, context, next) {
  if (specifier === 'node:sqlite') {
    return { url: new URL('./sqlite-shim.mjs', import.meta.url).href, shortCircuit: true }
  }
  return next(specifier, context)
}
