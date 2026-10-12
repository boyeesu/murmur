# First public GitHub publication

These instructions are for a maintainer publishing a fresh source folder that is
**not already a Git repository**. They create a public repository and upload its
committed files. Run them only in an environment authorized to write Git metadata
and access GitHub. Stop if any command fails; do not reuse an unrelated repository
or overwrite an existing remote to get past an error.

The prepared source is an experimental alpha. Public source availability does not
mean the four-tool integration, static type checking, or production hardening is
complete. Publishing to npm is a separate action; the package stays `private: true`.

## 1. Verify the account and source folder

Start in the Murmur source folder. Confirm the GitHub account that should own it:

```bash
gh api user --jq .login
```

Check the Git author name/email you intend to publish. Use your GitHub no-reply
address if you do not want your personal email in public commit metadata. Do not
paste account tokens into commands, files, or issues.

The publication audit found no likely live credentials in the reviewed source,
but review the actual staged files before pushing. `.claude/`, internal planning
notes, runtime databases, environment files, generated packages, and dependency
folders are excluded by `.gitignore`.

## 2. Initialize and review the snapshot

Only if this folder has no existing Git metadata:

```bash
git init --initial-branch=chore/open-source
```

Stage the intended source/community files explicitly:

```bash
git add -- .github .gitignore .node-version .npmrc CHANGELOG.md CONTRIBUTING.md LICENSE README.md SECURITY.md apps docs package.json package-lock.json packages scripts tests tsconfig.json
```

```bash
git status --short
```

```bash
git diff --cached --check
```

```bash
git diff --cached
```

Look for credentials, local configuration, internal notes, machine-specific paths,
and files that do not belong in a public source tree. Do not rely on an ignore rule
alone as proof that a snapshot is safe.

Run the tests before committing:

```bash
npm test
```

Create the initial commit using your configured Git identity/signing policy:

```bash
git commit -m "Initial open-source Murmur alpha"
```

## 3. Create the public repository and push

This creates `murmur` under the authenticated GitHub account. If the name is taken,
stop and choose another name deliberately; do not repurpose the existing repository.

```bash
gh repo create murmur --public --source=. --remote=origin --description "Local-first coordination for parallel coding agents"
```

Verify the owner, URL, and public visibility before uploading code:

```bash
gh repo view --json nameWithOwner,isPrivate,url
```

Push the reviewed initial snapshot to `main`:

```bash
git push --set-upstream origin HEAD:main
```

```bash
gh repo edit --default-branch main
```

## 4. Finish GitHub-side settings

- Enable and verify private vulnerability reporting under the repository's
  Security settings; then make SECURITY.md's reporting instructions definitive.
- Check that Issues and GitHub Actions are enabled. The prepared issue forms and
  pull-request template should appear automatically after the push.
- Inspect the first runtime CI results. They are not a static type-check pass.
- Add the real repository/bugs/homepage URLs to package metadata only after the
  repository URL has been confirmed.
- Add a code of conduct after choosing a genuine private enforcement contact.
- Keep npm publication, release assets, auto-merge, and additional automation off
  unless they are explicitly approved separately.

Do not state that GitHub setup or publication succeeded until the repository and
remote `main` branch have actually been verified.
