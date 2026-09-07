// @ts-nocheck — 第三方 lark 转换核心源码（cloud-document-converter fork），不参与本项目类型检查。
export const Second = 1000

export const Minute: number = 60 * Second

export const waitFor = (timeout: number = 0.4 * Second): Promise<void> =>
  new Promise(resolve => {
    setTimeout(() => {
      resolve()
    }, timeout)
  })

