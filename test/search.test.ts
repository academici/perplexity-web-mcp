import { test } from "node:test";
import assert from "node:assert/strict";
import { selectAnswerRootKind } from "../src/search.ts";

test("answer extraction falls back to prose when Perplexity renders empty tabpanels", () => {
  assert.equal(selectAnswerRootKind({
    tabpanels: [0, 0, 0, 0],
    prose: [586],
  }), "prose");
});

test("answer extraction keeps a non-empty tabpanel for the legacy layout", () => {
  assert.equal(selectAnswerRootKind({
    tabpanels: [0, 412],
    prose: [386],
  }), "tabpanel");
});

test("answer extraction reports no root when the answer has not rendered", () => {
  assert.equal(selectAnswerRootKind({
    tabpanels: [0],
    prose: [],
  }), null);
});
