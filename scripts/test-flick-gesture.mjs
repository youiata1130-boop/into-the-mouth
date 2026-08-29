import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const source = await readFile(new URL("../src/ui/flick-gesture.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
});
const encodedModule = Buffer.from(outputText).toString("base64");
const { evaluateFlickGesture } = await import(`data:text/javascript;base64,${encodedModule}`);

const mouth = { left: 50, right: 150, top: 300, bottom: 450 };
const point = (x, y, time) => ({ x, y, time });
const fastVertical = (x) => [point(x, 700, 0), point(x, 600, 100)];

assert.equal(
  evaluateFlickGesture([point(100, 700, 0), point(100, 650, 60), point(100, 600, 100)], mouth).accepted,
  true,
  "a fast upward throw aimed at the mouth should be accepted"
);

assert.equal(
  evaluateFlickGesture([point(100, 700, 0), point(100, 670, 45)], mouth).reason,
  "too-short",
  "a small movement should remain a tap instead of becoming a throw"
);

assert.equal(
  evaluateFlickGesture([point(100, 700, 0), point(100, 600, 1000)], mouth).reason,
  "too-slow",
  "a slow drag should not be mistaken for a flick"
);

assert.equal(
  evaluateFlickGesture([point(100, 700, 0), point(300, 600, 100)], mouth).reason,
  "wrong-direction",
  "a mostly horizontal gesture should not be thrown"
);

assert.equal(
  evaluateFlickGesture([point(400, 700, 0), point(400, 600, 100)], mouth).reason,
  "missed-target",
  "a fast throw whose projected path misses the mouth should be rejected"
);

assert.equal(
  evaluateFlickGesture([point(100, 700, 0), point(100, 240, 180)], mouth).accepted,
  true,
  "a fast gesture that crosses the mouth between samples should still be accepted"
);

assert.equal(evaluateFlickGesture(fastVertical(70), mouth).accepted, true, "the left edge of the center zone should count");
assert.equal(evaluateFlickGesture(fastVertical(69.99), mouth).accepted, false, "a throw just left of center should miss");
assert.equal(evaluateFlickGesture(fastVertical(130), mouth).accepted, true, "the right edge of the center zone should count");
assert.equal(evaluateFlickGesture(fastVertical(130.01), mouth).accepted, false, "a throw just right of center should miss");

assert.equal(
  evaluateFlickGesture([point(55, 700, 0), point(55, 360, 100)], mouth).accepted,
  false,
  "releasing inside the mouth edge without crossing its center should miss"
);

assert.equal(
  evaluateFlickGesture([point(40, 700, 0), point(140, 240, 180)], mouth).accepted,
  true,
  "a diagonal trajectory that crosses the mouth center should be accepted"
);

assert.equal(
  evaluateFlickGesture([point(40, 700, 0), point(40, 400, 60), point(140, 240, 100)], mouth).accepted,
  false,
  "a curved trajectory whose observed center-line crossing is off-center should miss"
);

assert.equal(
  evaluateFlickGesture([point(40, 700, 0), point(100, 375, 60), point(40, 240, 100)], mouth).accepted,
  true,
  "an observed trajectory that passes through the center should be accepted"
);

console.log("flick gesture tests passed");
