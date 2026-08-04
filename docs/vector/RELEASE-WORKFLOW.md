# Vector release workflow

Vector's canonical source repository is `scr1pter/Vectordev.ai`. The `main`
branch is connected to the production `vectordev-ai` project on Vercel.

## Publish source and website changes

1. Review the working tree and make sure local secrets, generated installers,
   and build output are not staged.
2. Run the relevant tests and the production web build.
3. Commit the reviewed source changes locally.
4. Push `main` to GitHub.
5. GitHub Actions verifies the web build, while Vercel automatically builds
   and deploys the same commit.
6. Confirm both checks succeeded before treating the release as complete.

Desktop installers use the separate release workflow in
`.github/workflows/vector-desktop-release.yml`; ordinary website pushes do not
rebuild every desktop installer.
