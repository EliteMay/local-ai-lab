import test from "node:test";
import assert from "node:assert/strict";
import { buildReviewerSourceExcerpts } from "../src/core/reviewer-source-excerpts.mjs";

const plan = {
  chunks: [
    {
      id: "src/permissions.mjs#L1-L6-P1", path: "src/permissions.mjs",
      startLine: 1, endLine: 6,
      content: "     1: // owner or admin\n     2: export function canDelete(user, doc) {\n     3:   if (user.isAdmin) return true;\n     4:   return doc.ownerId !== user.id;\n     5: }\n     6: "
    }
  ]
};
const finding = {
  evidence: [{ file: "src/permissions.mjs", lineStart: 3, lineEnd: 5, claim: "non-admin owner is allowed" }]
};

test("reviewer receives verbatim boolean operator, not auditor paraphrase", () => {
  const got = buildReviewerSourceExcerpts([finding], plan);
  assert.match(got.text, /4:   return doc\.ownerId !== user\.id;/);
  assert.doesNotMatch(got.text, /non-admin owner is allowed/);
  assert.equal(got.excerptCount, 1);
  assert.equal(got.evidenceCount, 1);
  assert.equal(got.unavailable, 0);
  assert.equal(got.truncated, false);
});

test("invalid line ranges and unknown files are explicitly unavailable", () => {
  const got = buildReviewerSourceExcerpts([{
    evidence: [{file:"src/unknown.mjs",lineStart:1,lineEnd:3},
      {file:"src/permissions.mjs",lineStart:1,lineEnd:500}]
  }], plan);
  assert.equal(got.unavailable, 2);
  assert.match(got.text, /unavailable or invalid source location/);
});

test("review evidence is bounded, not silently presented as complete", () => {
  const got = buildReviewerSourceExcerpts([finding], plan, {maxChars:25});
  assert.equal(got.excerptCount, 0);
  assert.equal(got.truncated, true);
});

test("partial long-line split chunks are reassembled for review", () => {
  const chunks = { chunks: [
    {path:"src/a.js",startLine:1,endLine:1,content:"     1: return doc.owner"},
    {path:"src/a.js",startLine:1,endLine:1,content:"     1: Id !== user.id;"}
  ]};
  const got = buildReviewerSourceExcerpts([{evidence:[{file:"src/a.js",lineStart:1,lineEnd:1}]}], chunks);
  assert.match(got.text, /return doc\.ownerId !== user\.id;/);
});

test("no finding evidence is not treated as verified semantic correctness", () => {
  const got = buildReviewerSourceExcerpts([{evidence:[]}], plan);
  assert.equal(got.evidenceCount,0);
  assert.equal(got.text,"");
});
