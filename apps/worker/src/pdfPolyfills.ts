// pdfjs-dist's legacy Node build self-polyfills `DOMMatrix` and `Path2D` at
// module load by requiring the optional `canvas` package. That package is an
// optionalDependency of pdfjs-dist, so pnpm installs it but its node-gyp
// build fails on this machine (no cairo headers / incomplete MSBuild
// toolchain -- the same reason pdfImages.ts uses @napi-rs/canvas instead), and
// the install is not failed by the error. The result is a `canvas` directory
// with no build/Release/canvas.node, so pdf.js's require throws and it warns
// "Cannot polyfill `DOMMatrix`/`Path2D`, rendering may be broken".
//
// @napi-rs/canvas ships both classes as prebuilt binaries, so install them as
// globals ourselves. pdf.js only polyfills when the global is absent, so
// importing this BEFORE requiring pdf.js both silences the warning and gives
// rendering the real implementations rather than leaving them undefined.
import { DOMMatrix, Path2D } from "@napi-rs/canvas";

const g = globalThis as Record<string, unknown>;
if (!g.DOMMatrix) g.DOMMatrix = DOMMatrix;
if (!g.Path2D) g.Path2D = Path2D;
