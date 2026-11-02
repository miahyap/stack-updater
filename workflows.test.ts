// SPDX-License-Identifier: MPL-2.0
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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

describe("release versions", () => {
  // A tag v1.2.3 publishes :1.2.3, :1.2 and :1; main publishes :latest. A
  // workflow_run's github.ref is always the default branch, so the version
  // comes from the tested run's head_branch, which is the tag for a tag's run.

  /** Run the "Release version" step's script with that head; its outputs. */
  function version(head: string): string {
    const script = RELEASE.match(/- name: Release version[\s\S]*?run: \|\n((?: {10}.*\n)+)/)?.[1];
    expect(script, "release.yml has the Release version step").toBeDefined();
    const dir = mkdtempSync(join(tmpdir(), "release-version-"));
    try {
      const out = join(dir, "out");
      spawnSync("sh", ["-c", `: >"$GITHUB_OUTPUT"\n${script!.replace(/^ {10}/gm, "")}`], {
        env: { ...process.env, HEAD: head, GITHUB_OUTPUT: out },
      });
      return readFileSync(out, "utf8").trim();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("takes a version from a release tag, and nothing else", () => {
    expect(version("v1.2.3")).toBe("version=v1.2.3");
    expect(version("v10.20.30")).toBe("version=v10.20.30");
    for (const head of ["main", "v1.2", "v1.2.3-rc1", "1.2.3", "v1.2.3.4", "release/v1.2.3"]) {
      expect(version(head), head).toBe("");
    }
  });

  it("is started by a tag's test run, as well as main's", () => {
    const test = readFileSync(
      join(import.meta.dirname, ".github", "workflows", "test.yml"),
      "utf8",
    );
    expect(test).toMatch(/^ {4}tags: \["v\*\.\*\.\*"\]$/m);
    expect(RELEASE).toMatch(/^ {4}branches: \[main, "v\*\.\*\.\*"\]$/m);
  });

  it("never moves :latest from a tag, and gives 0.x no major tag", () => {
    expect(RELEASE).toContain(
      "type=raw,value=latest,enable=${{ steps.version.outputs.version == '' }}",
    );
    // metadata-action's default flavor, latest=auto, adds :latest to any
    // semver build regardless of the line above: v1.0.0's build pushed it.
    expect(RELEASE).toMatch(/^ {10}flavor: \|\n {12}latest=false$/m);
    expect(RELEASE).toMatch(
      /type=semver,pattern=\{\{major\}\},.*!startsWith\(steps\.version\.outputs\.version, 'v0\.'\)/,
    );
  });

  it("keeps a tag's release from cancelling main's", () => {
    // Every workflow_run has github.ref = the default branch: grouped by it,
    // a tag pushed just after a merge would cancel that merge's release.
    expect(RELEASE).toMatch(/^ {2}group: release-\$\{\{ github\.event\.workflow_run\.head_branch/m);
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
