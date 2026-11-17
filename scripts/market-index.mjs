#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const tag = process.argv[2]
if (tag === undefined || !/^v\d+\.\d+\.\d+/.test(tag)) {
  console.error('usage: node scripts/market-index.mjs v<version>')
  process.exit(1)
}
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
const commit = git('rev-parse', `${tag}^{commit}`)
const publishTimestamp = Number(git('log', '-1', '--format=%ct', tag))
const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))
const version = tag.slice(1)
const repoUrl = String(pkg.repository?.url ?? '').replace(/^git\+/, '').replace(/\.git$/, '')
if (repoUrl === '') throw new Error('package.json repository.url is required')

const index = {
  format: 1,
  title: { en: 'Coding Enhanced', zh: '编码增强' },
  description: {
    en: 'DSH bundle: AI change review and multi-turn withdraw.',
    zh: 'DSH 插件：AI 改动审查与多轮撤回。',
  },
  plugins: [
    {
      name: pkg.name,
      title: { en: 'Coding Enhanced', zh: '编码增强' },
      description: {
        en: pkg.description,
        zh: '在右侧审查 AI 的文件改动，并用影子 git 快照撤回轮次。',
      },
      author: 'xthw',
      homepage: pkg.homepage,
      repository: { url: repoUrl },
      metadata: { keywords: pkg.keywords ?? [] },
      versions: [
        {
          version,
          publishTimestamp,
          source: { type: 'git', url: repoUrl, commit },
          engines: { dsh: pkg.engines?.dsh ?? '>=0.2.0-0 <0.3.0' },
        },
      ],
    },
  ],
}
mkdirSync(join(repo, 'market'), { recursive: true })
writeFileSync(join(repo, 'market', 'index.json'), `${JSON.stringify(index, null, 2)}\n`)
console.log(`wrote market/index.json for ${tag} (${commit})`)
