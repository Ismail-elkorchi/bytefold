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
const DOCS_INDEX_PATH = 'docs/index.md'
const DOCS_INDEX_ALLOWED_SECTIONS = ['## Tutorial', '## How-to', '## Reference', '## Explanation']
const DOCS_INDEX_FORBIDDEN_SECTIONS = ['## Security', '## Policy', '## Maintainers', '## Release', '## Operations']
const REQUIRED_HOW_TO_DOCS = [
  'docs/how-to/audit-before-extract.md',
  'docs/how-to/inspect-upload-in-browser.md',
  'docs/how-to/normalize-for-diffs.md',
  'docs/how-to/limits.md',
  'docs/how-to/troubleshoot-unsupported-password-and-error-cases.md',
  'docs/how-to/validate-then-extract.md'
]
const REQUIRED_HOW_TO_HEADINGS = [
  '## Goal',
  '## Prerequisites',
  '## Copy/paste',
  '## Expected output or shape',
  '## Common failure modes',
  '## Related reference'
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
await assertDocsIndexUserMap(DOCS_INDEX_PATH)
for (const relativePath of REQUIRED_HOW_TO_DOCS) {
  await assertHowToStructure(relativePath)
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

async function assertDocsIndexUserMap(relativePath) {
  const filePath = path.join(ROOT, relativePath)
  const text = await readFile(filePath, 'utf8')
  const normalized = text.replace(/\r\n/g, '\n')
  const sections = normalized.match(/^##\s+.+$/gm) ?? []

  for (const heading of DOCS_INDEX_ALLOWED_SECTIONS) {
    if (!sections.includes(heading)) {
      failures.push(`${relativePath} (missing docs index section: ${heading})`)
    }
  }

  for (const heading of sections) {
    if (!DOCS_INDEX_ALLOWED_SECTIONS.includes(heading)) {
      failures.push(`${relativePath} (unexpected docs index section: ${heading})`)
    }
  }

  for (const forbidden of DOCS_INDEX_FORBIDDEN_SECTIONS) {
    if (normalized.includes(`${forbidden}\n`) || normalized.endsWith(forbidden)) {
      failures.push(`${relativePath} (forbidden docs index section: ${forbidden})`)
    }
  }
}

async function assertHowToStructure(relativePath) {
  const filePath = path.join(ROOT, relativePath)
  const text = await readFile(filePath, 'utf8')
  const normalized = text.replace(/\r\n/g, '\n')

  for (const heading of REQUIRED_HOW_TO_HEADINGS) {
    if (!normalized.includes(`${heading}\n`) && !normalized.endsWith(heading)) {
      failures.push(`${relativePath} (missing required section: ${heading})`)
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
