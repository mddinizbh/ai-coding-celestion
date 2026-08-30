/**
 * One-way accepted-baseline → Obsidian Markdown projection (Todo 11).
 *
 * Seams under test:
 *  - renderBaselineProjection({ pkg, accepted }): pure render to deterministic
 *    { files, summary }.
 *  - idToSlug(canonicalId): filename/wikilink slug for a canonical id.
 *  - writeProjectionAtomic(outDir, rendered): atomic replace.
 *  - projectAcceptedBaseline(store, { namespace, logical_repo, out_dir }):
 *    reads ONLY the accepted SQLite baseline; never reads Markdown back.
 *
 * Invariants:
 *  - Two projections of the same accepted baseline are byte-identical.
 *  - No accepted baseline → ProjectionError; existing projection unchanged.
 *  - Graph edges appear only via explicit [[wikilinks]] in relation files.
 *  - No absolute paths or raw source bytes leak into generated files.
 *  - Human overlay files outside the generated tree survive regeneration.
 */

import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, test } from "node:test";

import { canonicalizeCandidatePackage } from "../src/candidate-package.mjs";
import {
  ProjectionError,
  idToSlug,
  projectAcceptedBaseline,
  renderBaselineProjection,
  writeProjectionAtomic,
} from "../src/obsidian-projector.mjs";
import { openStore, persistCandidate, acceptBaseline } from "../src/store.mjs";
import {
  coverageDraftInputs,
  draftRecord,
  draftRelation,
  explorerDraft,
} from "./fixtures.mjs";

const temps = [];

function tempDir(prefix = "descobrir-obsidian-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  while (temps.length > 0) {
    rmSync(temps.pop(), { recursive: true, force: true });
  }
});

/**
 * Build an accepted baseline package + accepted pointer for tests.
 * @param {object} [overrides]
 */
function acceptedBaselineFixture(overrides = {}) {
  const draft = explorerDraft({
    records: [
      draftRecord({ natural_key: "billing", name: "Billing" }),
      draftRecord({
        type: "Endpoint",
        natural_key: "get:/billing",
        name: "GET /billing",
        evidence: [
          {
            kind: "artifact",
            manifest_id: "manifest:test-load-1",
            artifact_path: ".claude/explorer/endpoints.md",
            content_sha256: "a".repeat(64),
            range: { start_line: 1, end_line: 2 },
          },
        ],
      }),
    ],
    relations: [
      draftRelation({
        relation_type: "EXPOSES",
        from_type: "Service",
        from_natural_key: "billing",
        to_type: "Endpoint",
        to_natural_key: "get:/billing",
      }),
    ],
    coverage_report: coverageDraftInputs(),
    ...overrides,
  });
  const pkg = canonicalizeCandidatePackage(draft);
  const accepted = {
    namespace: pkg.namespace,
    logical_repo: pkg.logical_repo,
    candidate_id: `candidate:${pkg.namespace}:${pkg.logical_repo}:${pkg.source_revision}:${pkg.graph_index.canonical_graph_hash}`,
    approver: "Marley",
    accepted_at: "2026-08-02T12:34:56.000Z",
  };
  return { pkg, accepted };
}

function materializeStore(baseline) {
  const dbPath = join(tempDir("descobrir-obsidian-store-"), "store.sqlite");
  const store = openStore(dbPath);
  const persisted = persistCandidate(store, baseline.pkg);
  const accepted = acceptBaseline(store, {
    candidate_id: persisted.candidate_id,
    approver: baseline.accepted.approver,
  });
  return { store, dbPath, accepted };
}

describe("idToSlug — canonical id → filesystem/wikilink slug", () => {
  test("preserves alphanumerics, dash, and colon", () => {
    assert.equal(idToSlug("service:billing"), "service:billing");
    assert.equal(idToSlug("endpoint:get-billing"), "endpoint:get-billing");
  });

  test("replaces path separators so canonical ids with '/' stay single-file", () => {
    const slug = idToSlug("endpoint:get:/billing");
    assert.equal(slug.includes("/"), false);
    assert.equal(slug.startsWith("endpoint:get:"), true);
  });

  test("is stable and idempotent", () => {
    const id = "exposes:service:billing->endpoint:get:/billing";
    const once = idToSlug(id);
    const twice = idToSlug(once);
    assert.equal(once, twice);
  });
});

describe("renderBaselineProjection — pure deterministic render", () => {
  test("produces README + one file per record and relation, slugged by canonical id", () => {
    const { pkg, accepted } = acceptedBaselineFixture();
    const rendered = renderBaselineProjection({ pkg, accepted });

    assert.ok(Array.isArray(rendered.files));
    assert.ok(rendered.files.length >= 1 + pkg.records.length + pkg.relations.length);

    const paths = rendered.files.map((f) => f.path).sort();
    assert.ok(paths.includes("README.md"));
    for (const rec of pkg.records) {
      assert.ok(
        paths.includes(join("records", `${idToSlug(rec.id)}.md`)),
        `missing record file for ${rec.id}`,
      );
    }
    for (const rel of pkg.relations) {
      assert.ok(
        paths.includes(join("relations", `${idToSlug(rel.id)}.md`)),
        `missing relation file for ${rel.id}`,
      );
    }
  });

  test("two renders of the same baseline are byte-identical (deterministic)", () => {
    const baseline = acceptedBaselineFixture();
    const a = renderBaselineProjection(baseline);
    const b = renderBaselineProjection(baseline);
    assert.equal(a.files.length, b.files.length);
    for (let i = 0; i < a.files.length; i += 1) {
      assert.equal(a.files[i].path, b.files[i].path);
      assert.equal(a.files[i].content, b.files[i].content);
    }
    assert.deepEqual(a.summary, b.summary);
  });

  test("frontmatter carries exact canonical id, graph hash, namespace, logical_repo", () => {
    const { pkg, accepted } = acceptedBaselineFixture();
    const rendered = renderBaselineProjection({ pkg, accepted });
    const recordFile = rendered.files.find((f) =>
      f.path === join("records", `${idToSlug(pkg.records[0].id)}.md`),
    );
    assert.ok(recordFile);
    assert.match(recordFile.content, /^---\n/);
    assert.ok(recordFile.content.includes(`id: ${pkg.records[0].id}`));
    assert.ok(recordFile.content.includes(`namespace: ${pkg.namespace}`));
    assert.ok(recordFile.content.includes(`logical_repo: ${pkg.logical_repo}`));

    const readme = rendered.files.find((f) => f.path === "README.md");
    assert.ok(readme);
    assert.ok(readme.content.includes(pkg.graph_index.canonical_graph_hash));
  });

  test("read-only banner is present in every generated file", () => {
    const { pkg, accepted } = acceptedBaselineFixture();
    const rendered = renderBaselineProjection({ pkg, accepted });
    for (const file of rendered.files) {
      assert.match(
        file.content,
        /read_only: true/,
        `${file.path} missing read_only: true frontmatter`,
      );
      assert.ok(
        /READ-ONLY|read-only|Do not edit/i.test(file.content),
        `${file.path} missing read-only banner`,
      );
    }
  });

  test("relation files declare typed edges only via explicit [[wikilinks]]", () => {
    const { pkg, accepted } = acceptedBaselineFixture();
    const rendered = renderBaselineProjection({ pkg, accepted });
    const rel = pkg.relations[0];
    const relFile = rendered.files.find(
      (f) => f.path === join("relations", `${idToSlug(rel.id)}.md`),
    );
    assert.ok(relFile);

    // Explicit typed wikilinks for both endpoints — no implicit edges.
    const fromSlug = idToSlug(rel.from_record);
    const toSlug = idToSlug(rel.to_record);
    assert.ok(relFile.content.includes(`[[${fromSlug}]]`));
    assert.ok(relFile.content.includes(`[[${toSlug}]]`));
    assert.ok(relFile.content.includes(`relation_type: ${rel.relation_type}`));

    // No other wikilinks beyond declared endpoints (no invented edges).
    const wikilinks = [...relFile.content.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1]);
    assert.deepEqual(
      [...new Set(wikilinks)].sort(),
      [fromSlug, toSlug].sort(),
    );
  });

  test("record files backlink to outgoing relations via explicit wikilinks", () => {
    const { pkg, accepted } = acceptedBaselineFixture();
    const rendered = renderBaselineProjection({ pkg, accepted });
    const service = pkg.records.find((r) => r.type === "Service");
    const serviceFile = rendered.files.find(
      (f) => f.path === join("records", `${idToSlug(service.id)}.md`),
    );
    assert.ok(serviceFile);
    const rel = pkg.relations[0];
    const relSlug = idToSlug(rel.id);
    assert.ok(
      serviceFile.content.includes(`[[${relSlug}]]`),
      "record file must backlink to its outgoing relation",
    );
  });

  test("no absolute paths, raw source bytes, or machine dirs leak into content", () => {
    const { pkg, accepted } = acceptedBaselineFixture();
    const rendered = renderBaselineProjection({ pkg, accepted });
    const banned = ["/Users/", "/home/", "/private/", "/var/folders/", "/tmp/"];
    for (const file of rendered.files) {
      for (const needle of banned) {
        assert.equal(
          file.content.includes(needle),
          false,
          `${file.path} leaks '${needle}'`,
        );
      }
    }
  });

  test("summary is deterministic and reflects counts + graph hash", () => {
    const { pkg, accepted } = acceptedBaselineFixture();
    const rendered = renderBaselineProjection({ pkg, accepted });
    assert.deepEqual(rendered.summary, {
      namespace: pkg.namespace,
      logical_repo: pkg.logical_repo,
      source_revision: pkg.source_revision,
      canonical_graph_hash: pkg.graph_index.canonical_graph_hash,
      record_count: pkg.records.length,
      relation_count: pkg.relations.length,
      file_count: rendered.files.length,
    });
  });
});

describe("writeProjectionAtomic — atomic replace", () => {
  test("writes all files under out_dir with POSIX newlines", () => {
    const out = tempDir();
    const { pkg, accepted } = acceptedBaselineFixture();
    const rendered = renderBaselineProjection({ pkg, accepted });
    writeProjectionAtomic(out, rendered);

    for (const file of rendered.files) {
      const abs = join(out, file.path);
      assert.ok(existsSync(abs), `missing ${file.path}`);
      assert.equal(readFileSync(abs, "utf8"), file.content);
    }
  });

  test("second projection atomically replaces the first; no stale files remain", () => {
    const out = tempDir();
    const baselineA = acceptedBaselineFixture({
      records: [
        draftRecord({ natural_key: "billing", name: "Billing" }),
        draftRecord({ natural_key: "orders", name: "Orders" }),
      ],
      relations: [],
    });
    const baselineB = acceptedBaselineFixture({
      records: [draftRecord({ natural_key: "billing", name: "Billing" })],
      relations: [],
    });
    const renderedA = renderBaselineProjection(baselineA);
    const renderedB = renderBaselineProjection(baselineB);

    writeProjectionAtomic(out, renderedA);
    const filesA = new Set(collectFiles(out));
    assert.ok(filesA.has(join("records", `${idToSlug("l0:service:orders")}.md`)));

    writeProjectionAtomic(out, renderedB);
    const filesB = new Set(collectFiles(out));
    assert.equal(
      filesB.has(join("records", `${idToSlug("l0:service:orders")}.md`)),
      false,
      "stale file from previous projection must not survive atomic replace",
    );
    for (const file of renderedB.files) {
      assert.ok(filesB.has(file.path), `expected ${file.path} after re-projection`);
    }
  });

  test("human overlay file outside generated tree survives regeneration", () => {
    const sibling = tempDir();
    const out = join(sibling, "projection");
    const overlayPath = join(sibling, "overlay-notes.md");
    writeFileSync(overlayPath, "# My human notes\nnot managed by descobrir\n", "utf8");

    const baseline = acceptedBaselineFixture();
    const rendered = renderBaselineProjection(baseline);

    writeProjectionAtomic(out, rendered);
    writeProjectionAtomic(out, renderBaselineProjection(baseline));

    assert.ok(existsSync(overlayPath));
    assert.equal(
      readFileSync(overlayPath, "utf8"),
      "# My human notes\nnot managed by descobrir\n",
    );
  });
});

describe("projectAcceptedBaseline — store-driven end-to-end", () => {
  test("projects the accepted baseline from the SQLite store", () => {
    const baseline = acceptedBaselineFixture();
    const { store, dbPath } = materializeStore(baseline);
    const out = tempDir();
    try {
      const result = projectAcceptedBaseline(store, {
        namespace: baseline.pkg.namespace,
        logical_repo: baseline.pkg.logical_repo,
        out_dir: out,
      });
      assert.equal(result.summary.namespace, baseline.pkg.namespace);
      assert.equal(
        result.summary.canonical_graph_hash,
        baseline.pkg.graph_index.canonical_graph_hash,
      );
      const readme = readFileSync(join(out, "README.md"), "utf8");
      assert.ok(readme.includes(baseline.pkg.graph_index.canonical_graph_hash));
    } finally {
      store.close();
      rmSync(dbPath, { force: true });
    }
  });

  test("no accepted baseline → ProjectionError and existing projection unchanged", () => {
    const baseline = acceptedBaselineFixture();
    const { store, dbPath } = materializeStore(baseline);
    const out = tempDir();
    // Pre-populate out_dir with a sentinel so we can prove it is preserved.
    const sentinelRel = join(out, "records", "sentinel.md");
    mkdirSync(join(out, "records"), { recursive: true });
    writeFileSync(sentinelRel, "sentinel", "utf8");

    try {
      assert.throws(
        () =>
          projectAcceptedBaseline(store, {
            namespace: "missing-ns",
            logical_repo: "missing-repo",
            out_dir: out,
          }),
        ProjectionError,
      );
      // Existing projection must be untouched on rejection.
      assert.ok(existsSync(sentinelRel));
      assert.equal(readFileSync(sentinelRel, "utf8"), "sentinel");
    } finally {
      store.close();
      rmSync(dbPath, { force: true });
    }
  });

  test("rejects out_dir that is not a non-empty string", () => {
    const baseline = acceptedBaselineFixture();
    const { store, dbPath } = materializeStore(baseline);
    try {
      assert.throws(
        () =>
          projectAcceptedBaseline(store, {
            namespace: baseline.pkg.namespace,
            logical_repo: baseline.pkg.logical_repo,
            out_dir: "",
          }),
        ProjectionError,
      );
    } finally {
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
});

/**
 * Recursively collect repo-relative file paths under dir.
 * @param {string} dir
 * @returns {string[]}
 */
function collectFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      for (const inner of collectFiles(p)) {
        out.push(join(name, inner));
      }
    } else {
      out.push(name);
    }
  }
  return out;
}
