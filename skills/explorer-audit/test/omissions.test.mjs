import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import { classifyHit, coveredByFact, scanOmissions } from "../src/omissions.mjs";
import { showPinned } from "../src/show.mjs";

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", shell: false }).trim();
}

function makeRepo() {
  const cwd = mkdtempSync(join(tmpdir(), "audit-omit-"));
  git(cwd, ["init", "-q", "-b", "main"]);
  mkdirSync(join(cwd, "src"), { recursive: true });
  writeFileSync(
    join(cwd, "src", "Client.kt"),
    "class Client {\n  fun call() = rest.get()\n  private val http = RestTemplate()\n}\n",
  );
  writeFileSync(
    join(cwd, "src", "Bus.kt"),
    "class Bus {\n  fun send() = KafkaTemplate<String, String>()\n}\n",
  );
  writeFileSync(join(cwd, "src", "worker.py"), "import requests\nrequests.get('http://x')\n");
  git(cwd, ["add", "."]);
  git(cwd, ["-c", "user.email=t@t", "-c", "user.name=T", "commit", "-q", "-m", "init"]);
  return { cwd, head: git(cwd, ["rev-parse", "HEAD"]) };
}

describe("classifyHit", () => {
  test("python file is python even if HTTP", () => {
    assert.equal(classifyHit("src/worker.py", "requests.get('http://x')"), "python");
  });
  test("kotlin RestTemplate is http, KafkaTemplate is kafka", () => {
    assert.equal(classifyHit("A.kt", "private val http = RestTemplate()"), "http");
    assert.equal(classifyHit("B.kt", "val k = KafkaTemplate<String, String>()"), "kafka");
  });
});

describe("scanOmissions", () => {
  const repo = makeRepo();
  after(() => rmSync(repo.cwd, { recursive: true, force: true }));

  test("reports hits not covered by L1 facts", () => {
    const out = scanOmissions({
      namespace: "ns",
      repos: [{ logical_repo: "svc", repo_path: repo.cwd, revision: repo.head }],
      factsForRepo: () => [{ file: "src/Client.kt", line: 3 }],
    });
    assert.ok(out.counts.http >= 0);
    assert.equal(out.counts.python, 1);
    assert.equal(out.omissions.python[0].file, "src/worker.py");
    assert.ok(out.omissions.kafka.some((h) => h.file === "src/Bus.kt"));
    assert.ok(!out.omissions.http.some((h) => h.file === "src/Client.kt" && h.line === 3));
  });

  test("coveredByFact uses a 5-line window", () => {
    assert.equal(coveredByFact([{ file: "A.kt", line: 10 }], "A.kt", 12), true);
    assert.equal(coveredByFact([{ file: "A.kt", line: 10 }], "A.kt", 20), false);
  });

  test("showPinned reads committed bytes", () => {
    const shown = showPinned({
      repo_path: repo.cwd,
      revision: repo.head,
      file: "src/worker.py",
      line: 2,
      context: 1,
    });
    assert.equal(shown.window.find((w) => w.mark).text.includes("requests.get"), true);
  });
});
