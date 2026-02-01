# Releasing bytefold (npm + JSR)

## One-time setup (npm trusted publishing)

1) Create the package on npmjs.com (if it does not exist) and set access to public.
2) In npmjs.com → **Package Settings** → **Publishing**, enable **Trusted publishing**.
3) Add a new GitHub Actions publisher with:
   - Owner: `ismail-elkorchi`
   - Repository: `bytefold`
   - Workflow: `release.yml`
   - Environment (optional): leave blank unless you use protected environments
4) Ensure the package name matches `@ismail-elkorchi/bytefold`.

## One-time setup (JSR trusted publishing)

1) Create the package on jsr.io if it does not exist.
2) Link the GitHub repository `ismail-elkorchi/bytefold` in JSR package settings.
3) Enable GitHub OIDC publishing for the repository and allow workflow `release.yml`.

## Release steps

1) Ensure `package.json` and `jsr.json` versions match.
2) Tag a release:

```sh
git tag vX.Y.Z
git push origin vX.Y.Z
```

3) GitHub Actions will run `.github/workflows/release.yml`:
   - `npm publish --provenance --access public`
   - `deno publish`

## Verification

- npm: verify package page shows provenance (SLSA) and OIDC publisher.
- JSR: verify new version is visible and docs render.
