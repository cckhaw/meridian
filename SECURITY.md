# Security policy

## Reporting a vulnerability

Please report suspected vulnerabilities **privately**, not in a public issue or pull request.

Use GitHub's private reporting: on this repository open **Security → Report a vulnerability**. Include what you found, where (the route, screen or file), the steps to reproduce it and what an attacker gains. Please do not access or change other people's data while testing, and do not run denial-of-service or high-volume tests against a live deployment.

We acknowledge a report, keep you informed while it is fixed and credit you in the release notes if you wish.

## What is supported

Only the latest commit on `main` is supported; fixes are made there and deployed. Dependencies are watched by Dependabot and the CI fails on a new high or critical advisory in production dependencies; CodeQL scans the code and the workflows.

## How the system is protected

See [docs/SECURITY.md](docs/SECURITY.md) for authentication, authorisation, request hardening, data protection, outbound-request protection and what is not covered yet, and [docs/OPERATIONS.md](docs/OPERATIONS.md) for the secrets a deployment needs and how to rotate them.
