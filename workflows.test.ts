// SPDX-License-Identifier: MPL-2.0
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// .github/workflows/release.yml, read as text (its `if` is all that matters).
//
// What it guards: release runs on `workflow_run` of `test`, whose `branches:
// [main]` filter matches the tested run's head BRANCH by name. A pull request
// from a fork whose branch is called `main` matches it, and the job would then
// build that fork's commit and push it as :latest with this repo's token: an
// image every stack runs with the host's Docker socket, and takes within
// minutes.

const RELEASE = readFileSync(
  join(import.meta.dirname, ".github", "workflows", "release.yml"),
  "utf8",
);

/** The build job's `if`, folded onto one line. */
function gate(): string {
  const m = RELEASE.match(/^ {4}if: >-\n((?: {6}.*\n)+)/m);
  expect(m, "release.yml's build job has an `if: >-` block").not.toBeNull();
  return m![1]!.replace(/\s+/g, " ").trim();
}

describe("release workflow", () => {
  it("publishes only a test run of a push to this repo itself", () => {
    const g = gate();
    expect(g).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(g).toContain("github.event.workflow_run.event == 'push'");
    expect(g).toContain("github.event.workflow_run.head_repository.full_name == github.repository");
    // The three are one condition, not alternatives to each other.
    expect(g).toMatch(
      /\(github\.event\.workflow_run\.conclusion == 'success' && github\.event\.workflow_run\.event == 'push' && github\.event\.workflow_run\.head_repository\.full_name == github\.repository\)/,
    );
  });
});

// .github/workflows/dependabot-auto-merge.yml runs on every pull request with
// a token that can merge: it must act on Dependabot's alone, never a fork's.
const AUTO_MERGE = readFileSync(
  join(import.meta.dirname, ".github", "workflows", "dependabot-auto-merge.yml"),
  "utf8",
);

describe("dependabot auto-merge workflow", () => {
  it("acts only on Dependabot's pull requests, in this repository", () => {
    const job = AUTO_MERGE.match(/^ {4}if: (.*)$/m)?.[1];
    expect(job).toContain("github.event.pull_request.user.login == 'dependabot[bot]'");
    expect(job).toContain("github.repository == 'miahyap/stack-updater'");
    expect(job).not.toContain("||");
  });

  it("runs on pull_request, never pull_request_target", () => {
    // pull_request_target would run with a write token on a fork's PR.
    expect(AUTO_MERGE).toMatch(/^on: pull_request$/m);
    expect(AUTO_MERGE).not.toContain("pull_request_target");
  });
});
