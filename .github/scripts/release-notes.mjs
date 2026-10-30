/**
 * 生成 Release 版本说明：取上一个版本 tag 到本次之间的提交，按提交前缀（feat: / fix: …）分组成 Markdown。
 * CI 把结果写进草稿 Release，发版人在 GitHub 上看过、按需改写后再点「发布」。
 *
 * 只收面向用户的类型；docs / style / build / chore / ci / test 跳过（草稿里需要的话手动补）。
 * 正式版从上一个正式版算起（跳过中间的 beta 等预发布 tag），预发布版从上一个任意版本 tag 算起。
 *
 * 用法：node .github/scripts/release-notes.mjs <tag> [ref]
 *   ref 默认等于 tag；tag 还没打时可传 HEAD 本地预览，如 node .github/scripts/release-notes.mjs v0.1.7 HEAD
 * 需要完整的提交历史与 tag（CI 里 checkout 要 fetch-depth: 0）。
 */
import { execFileSync } from 'node:child_process'

const REPO_URL = 'https://github.com/kyaring/deva'

const GROUPS = [
  { title: '新功能 / New Features', types: ['feat'] },
  { title: '问题修复 / Bug Fixes', types: ['fix'] },
  { title: '其他改进 / Other Improvements', types: ['perf', 'refactor', null] } // null = 没按约定写前缀的提交
]
const SKIP = new Set(['docs', 'style', 'build', 'chore', 'ci', 'test'])

const [, , tag, ref = tag] = process.argv
if (!tag) {
  console.error('用法：node .github/scripts/release-notes.mjs <tag> [ref]')
  process.exit(1)
}

// stderr 收进异常而不是直接打到终端：「找不到上一个 tag」属正常情况，不该在日志里冒 fatal
const git = (...args) =>
  execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

function previousTag() {
  const args = ['describe', '--tags', '--abbrev=0', '--match', 'v*']
  if (!tag.includes('-')) args.push('--exclude', 'v*-*')
  try {
    return git(...args, `${ref}^`)
  } catch {
    return null // 第一个版本：之前没有 tag
  }
}

const prev = previousTag()
const subjects = git('log', '--no-merges', '--pretty=format:%s', prev ? `${prev}..${ref}` : ref)
  .split('\n')
  .filter(Boolean)

const buckets = new Map(GROUPS.map((g) => [g, []]))
for (const subject of subjects) {
  // type(scope)!: 说明 —— scope 是给开发者看的，版本说明里去掉
  const m = /^([a-z]+)(?:\([^)]*\))?!?:\s*(.+)$/i.exec(subject)
  const type = m ? m[1].toLowerCase() : null
  if (type && SKIP.has(type)) continue
  const group = GROUPS.find((g) => g.types.includes(type)) ?? GROUPS[2]
  buckets.get(group).push(m ? m[2] : subject)
}

const sections = []
for (const [group, items] of buckets) {
  if (items.length) sections.push(`## ${group.title}\n\n${items.map((s) => `- ${s}`).join('\n')}`)
}
if (!sections.length) sections.push('本版本没有面向用户的改动。 / No user-facing changes in this release.')
sections.push(
  prev
    ? `**完整变更 / Full Changelog**: ${REPO_URL}/compare/${prev}...${tag}`
    : `**完整变更 / Full Changelog**: ${REPO_URL}/commits/${tag}`
)
console.log(sections.join('\n\n'))
