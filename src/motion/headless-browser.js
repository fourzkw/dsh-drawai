// 无头浏览器的启动参数。
//
// Remotion 用 chromeMode 决定无头模式（node_modules/@remotion/renderer/dist/open-browser.js:126-130）：
//   headless-shell（默认）→ --headless=old
//   chrome-for-testing    → --headless=new
// DrawAI 传的是本机 Edge / Chrome 的完整浏览器（不是 Remotion 自带的 headless-shell），
// 而 --headless=old 在部分 Windows 机器上会创建真实窗口对象：标题是 bundle 页面的
// 「Remotion Bundle」，渲染完/中止后还会残留在 Alt+Tab 切换器里，越攒越多。
// 所以只要用本机浏览器就显式走 --headless=new。
//
// 没有本机浏览器时不传 chromeMode：让 Remotion 下载 chrome-headless-shell——它本身就没有窗口，
// 而且比 Chrome for Testing 小得多（内网/无外网环境也更省）。
export const LOCAL_BROWSER_CHROME_MODE = 'chrome-for-testing'

/** openBrowser 的参数：有本机浏览器时补上 chromeMode，其余键原样透传。 */
export function headlessBrowserOptions(browserExecutable, extra = {}) {
  return {
    ...extra,
    browserExecutable,
    ...(browserExecutable ? { chromeMode: LOCAL_BROWSER_CHROME_MODE } : {}),
  }
}
