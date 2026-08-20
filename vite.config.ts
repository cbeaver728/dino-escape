import { writeFileSync, mkdirSync } from 'node:fs'
import { defineConfig, type Plugin } from 'vite'

/**
 * Dev-only: lets the running game POST a screenshot to disk so frames can be
 * inspected while tuning the night lighting. Never part of a production build.
 */
function screenshotSink(): Plugin {
  return {
    name: 'screenshot-sink',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__shot', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          return res.end()
        }
        const chunks: Buffer[] = []
        req.on('data', (c) => chunks.push(c as Buffer))
        req.on('end', () => {
          const body = Buffer.concat(chunks).toString()
          const [name, b64] = body.split('|')
          mkdirSync('.shots', { recursive: true })
          const safe = name.replace(/[^a-z0-9_-]/gi, '') || 'shot'
          writeFileSync(`.shots/${safe}.png`, Buffer.from(b64, 'base64'))
          res.end('ok')
        })
      })
    },
  }
}

export default defineConfig({
  base: './',
  plugins: [screenshotSink()],
})
