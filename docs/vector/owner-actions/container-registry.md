# Vector container registry

Status: build and publication workflow prepared. No registry organisation, package permissions, image publication, or credentials were created. Local Docker is unavailable in the current Mac environment, and the repository's Actions account is blocked by its billing/spending limit, so actual native Linux container builds are still a release check.

## Owner setup

1. Choose the Vector-owned GitHub organisation/account for `ghcr.io/<owner>/vector`. Create or configure it yourself. Set repository variable `VECTOR_CONTAINER_OWNER` to its lowercase login.
2. Grant this repository Actions access to the package namespace with package write permission. The workflow uses the job's short-lived `GITHUB_TOKEN`; it does not require a personal token in source. Link package access to the repository and choose public visibility so customers can pull it without registry credentials. GitHub initially creates packages private; visibility is an owner step.
3. Resolve the GitHub billing/spending block so native `ubuntu-24.04` and `ubuntu-24.04-arm` runners can start. Apply the repository's release branch/environment controls and limit external writers to the immutable version tags.
4. After reviewing both native image candidates, set repository variable `VECTOR_CONTAINER_PUBLISH_ENABLED=true`. The workflow's explicit `containers: publish` input is still required. Keep the variable absent until the namespace and permission review is complete.

## Build and release

The standalone CLI workflow prepares all twelve binaries and their reviewed manifest. Its container mode defaults to `prepare`; `skip` is available while infrastructure is unavailable. It supplies the exact Linux ARM64 musl and baseline x64 musl archives to the reusable container workflow. Every input is checked against the selected version, source commit, catalog hash and archive SHA-256. Extraction rejects links, duplicate/unexpected entries and wrong architectures. It carries the CLI's notices unchanged.

Each architecture builds and executes on a native runner. The image uses a digest-pinned official Alpine 3.23 base, installs Git, Bash, OpenSSH, ripgrep and required runtime libraries, and runs as UID/GID 10001. Checks verify CLI version, help, Git and packaged notices. The workflow retains Docker archives for review. These checks do not invoke a model or use provider credentials. Alpine packages resolve against the current stable repository during the build; the reviewed final image digest, not a promise of bit-identical future rebuilds, identifies the artifact.

`containers: publish` publishes architecture images, then a two-platform version index after both pass. Existing tags are reusable only when their digest/config matches; different bytes are rejected. Registry errors are not treated as missing versions. All runs are serialized by the calling CLI release workflow. No moving `latest` tag is updated. A partial publish can be retried with identical bytes; if a rebuild differs, review a new release version instead of overwriting the existing tag. A CLI channel pointer is advanced separately after the entire release's checks pass.

## Customer example after publication

Replace OWNER and VERSION with the published values:

```sh
docker run --rm -it \
  --mount type=bind,source="$PWD",target=/workspace \
  --mount type=volume,source=vector-data,target=/home/vector \
  ghcr.io/OWNER/vector:VERSION login
```

Use the same mounts for `auth login`, `run`, or the TUI. The mounted project must be writable by the chosen container user; match `--user` and a writable home mount when your host ownership differs. Project language runtimes are not bundled. Keep credentials in the persistent home volume or an explicit runtime secret, never in a Docker build argument/image layer.

For a server, publish only to host loopback (`-p 127.0.0.1:4096:4096`), set `VECTOR_SERVER_PASSWORD` at runtime, and run `serve --hostname 0.0.0.0 --port 4096`. The service can modify the mounted project and run tools. Use a reviewed authenticated proxy for intentional remote access.

Reviewed primary documentation: [GitHub Container Registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry) and [Docker multi-platform builds](https://docs.docker.com/build/ci/github-actions/multi-platform/). The workflow uses pinned `actions/*` and the existing Bun setup action; it adds no registry login/build marketplace action.
