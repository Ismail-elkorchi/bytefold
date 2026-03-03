import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'

const ROOT = process.cwd()
const USER_DOCS = [
  'README.md',
  'SECURITY.md',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'SUPPORT.md',
  'SPEC.md',
  'ARCHITECTURE.md'
]
const FORBIDDEN_METADATA_KEYS = ['role', 'audience', 'source_of_truth', 'update_triggers']
const PRIVATE_ARTIFACTS = [
  'docs/REPO_INDEX.md',
  'docs/REPO_INDEX.md.sha256',
  '.bytefold_meta'
]

const failures = []

for (const relativePath of USER_DOCS) {
  await assertPublicDocClean(relativePath)
}
for (const relativePath of PRIVATE_ARTIFACTS) {
  await assertMissing(relativePath)
}

if (failures.length > 0) {
  console.error('docs:check failed for:')
  for (const failure of failures) {
    console.error(`- ${failure}`)
  }
  process.exitCode = 1
}

async function assertPublicDocClean(relativePath) {
  const filePath = path.join(ROOT, relativePath)
  let text = ''
  try {
    text = await readFile(filePath, 'utf8')
  } catch {
    failures.push(`${relativePath} (missing required public doc)`)
    return
  }

  const normalized = text.replace(/\r\n/g, '\n')
  if (hasLeadingFrontmatter(normalized)) {
    failures.push(`${relativePath} (leading frontmatter is forbidden in public docs)`)
  }

  for (const key of FORBIDDEN_METADATA_KEYS) {
    const keyPattern = new RegExp(`^\\s*${key}\\s*:`, 'm')
    if (keyPattern.test(normalized)) {
      failures.push(`${relativePath} (contains forbidden metadata key: ${key})`)
    }
  }
}

async function assertMissing(relativePath) {
  const filePath = path.join(ROOT, relativePath)
  try {
    await stat(filePath)
    failures.push(`${relativePath} (must not exist in public repo)`)
  } catch {
    // expected
  }
}

function hasLeadingFrontmatter(text) {
  if (!text.startsWith('---\n')) return false
  const end = text.indexOf('\n---\n', 4)
  return end !== -1
}
