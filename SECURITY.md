# Security

stack-updater runs with the host's Docker socket, which is root on the host,
and updates itself from its published image. A flaw in it, or in how its
image is built and published, can matter as much as a flaw in Docker itself.

## Reporting a vulnerability

Please don't open a public issue. Report it privately through GitHub:
**Security → Report a vulnerability** on this repository
(<https://github.com/miahyap/stack-updater/security/advisories/new>).

This is a personal project, maintained on a best-effort basis. You'll get an
acknowledgement, and a fix or a decision, as soon as is practical.

## Supported versions

Only the current `main`, published as `ghcr.io/miahyap/stack-updater:latest`.

## Verifying the image

Each published image carries a build provenance attestation, signed by this
repository's release workflow. To check that an image was built here:

    gh attestation verify oci://ghcr.io/miahyap/stack-updater:latest -R miahyap/stack-updater
