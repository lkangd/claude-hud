---
name: release-claude-hud
description: Bump claude-hud patch version, update changelog, create release commit, and create matching git tag.
---

# /release-claude-hud

Automate Claude HUD patch release in this repository by following the established release pattern (`release: prepare vX.Y.Z`).

## What this skill does

1. Detect current version from `package.json`.
2. Bump **patch** version by +1 in:
   - `package.json`
   - `.claude-plugin/plugin.json`
   - `.claude-plugin/marketplace.json` (`metadata.version`)
3. Update `CHANGELOG.md` by inserting a new release section under `## [Unreleased]`:
   - `## [X.Y.Z] - YYYY-MM-DD`
   - include a concise `### Fixed` bullet summarizing staged code changes.
4. Stage those four files only.
5. Create commit message:
   - subject: `release: prepare vX.Y.Z`
   - include co-author trailer:
     - `Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>`
6. Create lightweight tag `vX.Y.Z` on that commit.
7. Print commit SHA and created tag.

## Required behavior

- Work from repository root.
- Follow existing release style in commit history and changelog.
- Abort if target tag already exists.
- Abort if working tree has unrelated unstaged/uncommitted changes outside the 4 release files.
- Do not push automatically.

## Bash workflow (exact order)

```bash
# 1) Read current version
CURRENT=$(node -p "require('./package.json').version")
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"
NEXT="$MAJOR.$MINOR.$((PATCH+1))"
TAG="v$NEXT"
DATE=$(date +%F)

# 2) Safety checks
git rev-parse --is-inside-work-tree >/dev/null
if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "Tag $TAG already exists" >&2
  exit 1
fi

# 3) Update versions
node -e "const fs=require('fs');const p='package.json';const j=JSON.parse(fs.readFileSync(p,'utf8'));j.version='$NEXT';fs.writeFileSync(p,JSON.stringify(j,null,2)+'\n');"
node -e "const fs=require('fs');const p='.claude-plugin/plugin.json';const j=JSON.parse(fs.readFileSync(p,'utf8'));j.version='$NEXT';fs.writeFileSync(p,JSON.stringify(j,null,2)+'\n');"
node -e "const fs=require('fs');const p='.claude-plugin/marketplace.json';const j=JSON.parse(fs.readFileSync(p,'utf8'));j.metadata.version='$NEXT';fs.writeFileSync(p,JSON.stringify(j,null,2)+'\n');"

# 4) Update changelog (insert new section under [Unreleased])
node -e "const fs=require('fs');const p='CHANGELOG.md';const s=fs.readFileSync(p,'utf8');const marker='## [Unreleased]\n';if(!s.includes(marker)){throw new Error('Unreleased section not found');}const entry='## [${NEXT}] - ${DATE}\n\n### Fixed\n- Describe the primary fix included in the staged changes.\n\n';fs.writeFileSync(p,s.replace(marker, marker+'\n'+entry));"

# 5) Ensure only intended release files are staged/committed
git add package.json .claude-plugin/plugin.json .claude-plugin/marketplace.json CHANGELOG.md

# 6) Commit
 git commit -m "$(cat <<'EOF'
release: prepare v${NEXT}

Bump claude-hud version to v${NEXT} and update changelog for this release.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"

# 7) Tag
git tag "$TAG"

# 8) Output result
git rev-parse --short HEAD
echo "$TAG"
```

## Notes for assistant execution

- Replace the changelog bullet with a concrete one-line summary derived from current staged code changes (do not leave placeholder text).
- If the user provides a reference release commit, mirror its touched files and style.
- If release commit should include additional files, ask user first instead of guessing.
