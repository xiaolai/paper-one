import { webkit } from '@playwright/test'
const [cookie] = process.argv.slice(2)
const browser = await webkit.launch()
const ctx = await browser.newContext({ ignoreHTTPSErrors: true })
await ctx.addCookies([{ name: 'paper_session', value: cookie, domain: 'localhost', path: '/', httpOnly: true, secure: true, sameSite: 'Strict' }])
const page = await ctx.newPage()
await page.goto('https://localhost:27183', { waitUntil: 'domcontentloaded' })
await new Promise((r) => setTimeout(r, 30000))
await browser.close()
