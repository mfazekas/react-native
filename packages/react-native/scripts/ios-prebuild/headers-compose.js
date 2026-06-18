/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 * @format
 */

/**
 * Headers compose — emits the headers-spec layout (rules R1–R8 in
 * headers-spec.js) into a React.xcframework and builds the headers-only
 * ReactNativeHeaders.xcframework beside it.
 *
 * The prebuild compose step (xcframework.js) emits the layout into the freshly
 * composed React.xcframework's slices and builds ReactNativeHeaders.xcframework
 * beside it — BEFORE signing (R7). `ensureHeadersLayout()` applies the same
 * emission to an already-cached artifact (binaries are header-independent) for
 * tooling that composes on demand.
 *
 * One projector, spec-driven, byte-identical output either way.
 */

const {computeInventory} = require('./headers-inventory');
const {
  DEPS_NAMESPACES,
  planFromInventory,
  renderNamespaceModuleMap,
  renderReactModuleMap,
  renderUmbrellaHeader,
} = require('./headers-spec');
const {execSync} = require('child_process');
const fs = require('fs');
const path = require('path');

/*:: import type {HeadersSpecPlan, SpecEntry} from './headers-spec'; */

/**
 * Computes the spec plan from the live source tree. Throws on collisions
 * (R8) — a collision means the spec and the source tree disagree and the
 * artifact must not be produced.
 */
function computeSpecPlan(rnRoot /*: string */) /*: HeadersSpecPlan */ {
  const plan = planFromInventory(computeInventory(rnRoot));
  if (plan.collisions.length > 0) {
    throw new Error(
      `headers-spec collisions (R8):\n  ${plan.collisions.join('\n  ')}`,
    );
  }
  return plan;
}

/**
 * Copies spec entries (each `{relPath, source}`) into a staging dir, creating
 * parent dirs. Shared by the React.framework and ReactNativeHeaders emission.
 */
function stageEntries(
  stage /*: string */,
  entries /*: Array<SpecEntry> */,
  rnRoot /*: string */,
) /*: void */ {
  for (const e of entries) {
    const dest = path.join(stage, e.relPath);
    fs.mkdirSync(path.dirname(dest), {recursive: true});
    fs.copyFileSync(path.join(rnRoot, e.source), dest);
  }
}

/**
 * Emits the React.framework side of the spec (R1, R4, R6) into every slice
 * of an xcframework: Headers root = React/ ∪ react/ hoisted + bare aliases,
 * generated umbrella + framework module map. Replaces each slice's Headers
 * and Modules. The xcframework's ROOT Headers/ (the CocoaPods header surface)
 * is left untouched.
 */
function emitReactFrameworkHeaders(
  xcfwPath /*: string */,
  plan /*: HeadersSpecPlan */,
  rnRoot /*: string */,
) /*: void */ {
  const stage = fs.mkdtempSync(
    path.join(path.dirname(xcfwPath), '.react-stage-'),
  );
  stageEntries(stage, plan.react, rnRoot);
  fs.writeFileSync(
    path.join(stage, 'React-umbrella.h'),
    renderUmbrellaHeader(plan.umbrella),
  );

  // A slice is any entry carrying a React.framework. The framework as built by
  // xcodebuild -create-xcframework ships no Headers/ dir of its own — this
  // emission creates it (and replaces Modules), so detect by the framework, not
  // by a pre-existing Headers/.
  const slices = fs
    .readdirSync(xcfwPath)
    .filter(d =>
      fs.existsSync(path.join(xcfwPath, d, 'React.framework')),
    );
  for (const slice of slices) {
    const fwk = path.join(xcfwPath, slice, 'React.framework');
    fs.rmSync(path.join(fwk, 'Headers'), {recursive: true, force: true});
    execSync(`/bin/cp -Rc "${stage}" "${path.join(fwk, 'Headers')}"`);
    fs.rmSync(path.join(fwk, 'Modules'), {recursive: true, force: true});
    fs.mkdirSync(path.join(fwk, 'Modules'), {recursive: true});
    fs.writeFileSync(
      path.join(fwk, 'Modules', 'module.modulemap'),
      renderReactModuleMap(),
    );
  }
  fs.rmSync(stage, {recursive: true, force: true});
  console.log(
    `headers-compose: React.framework spec layout -> ${slices.join(', ')} ` +
      `(${plan.react.length} headers, umbrella ${plan.umbrella.length})`,
  );
}

/*::
type StubSlice = {
  name: string, // human label
  sdk: string, // xcrun --sdk name
  targets: Array<string>, // clang -target triples (lipo'd when > 1)
};
*/

const DEFAULT_STUB_SLICES /*: Array<StubSlice> */ = [
  {name: 'ios', sdk: 'iphoneos', targets: ['arm64-apple-ios15.0']},
  {
    name: 'ios-simulator',
    sdk: 'iphonesimulator',
    targets: [
      'arm64-apple-ios15.0-simulator',
      'x86_64-apple-ios15.0-simulator',
    ],
  },
];

// Mac Catalyst slice — used by the real compose (the cached-artifact
// repackage path skips it to stay fast; React.xcframework carries it).
const CATALYST_STUB_SLICE /*: StubSlice */ = {
  name: 'mac-catalyst',
  sdk: 'macosx',
  targets: ['arm64-apple-ios15.0-macabi', 'x86_64-apple-ios15.0-macabi'],
};

/**
 * Builds ReactNativeHeaders.xcframework (R2, R5): a headers-only LIBRARY
 * xcframework (stub static archives — nothing embeds in apps) whose Headers
 * root carries every non-React namespace incl. the third-party deps
 * namespaces, plus module.modulemap with the plain per-namespace modules.
 * SPM serves its Headers automatically to dependents — no flags.
 */
function buildReactNativeHeadersXcframework(
  outDir /*: string */,
  plan /*: HeadersSpecPlan */,
  depsHeaders /*: string */,
  rnRoot /*: string */,
  includeCatalyst /*: boolean */ = false,
  // Optional dir containing a `hermes/` namespace (the Hermes public C++ API
  // headers, `destroot/include` from the hermes-ios tarball). Folded in as a
  // textual namespace — like folly/glog, no clang module — so `<hermes/...>`
  // resolves for any RN-linking target without per-library wiring. null when
  // the Hermes headers aren't staged (then `<hermes/...>` stays unavailable,
  // i.e. the pre-fold behavior).
  hermesHeaders /*: ?string */ = null,
) /*: string */ {
  // ---- stage headers ----
  const stage = fs.mkdtempSync(path.join(outDir, '.rnh-stage-'));
  stageEntries(stage, plan.reactNativeHeaders, rnRoot);
  for (const ns of plan.depsNamespaces) {
    const src = path.join(depsHeaders, ns);
    if (fs.existsSync(src)) {
      execSync(`/bin/cp -Rc "${src}" "${path.join(stage, ns)}"`);
    } else {
      console.warn(`headers-compose: deps namespace missing: ${ns}`);
    }
  }
  // Hermes public headers (separate source from the deps namespaces — they
  // come from the hermes-ios tarball, not ReactNativeDependencies). Vend only
  // the `hermes/` namespace; `jsi/` is already provided elsewhere, so copying
  // it here would double-vend.
  let hermesFolded = false;
  if (hermesHeaders != null) {
    const src = path.join(hermesHeaders, 'hermes');
    if (fs.existsSync(src)) {
      execSync(`/bin/cp -Rc "${src}" "${path.join(stage, 'hermes')}"`);
      hermesFolded = true;
    } else {
      console.warn(`headers-compose: hermes headers missing at ${src}`);
    }
  }
  fs.writeFileSync(
    path.join(stage, 'module.modulemap'),
    renderNamespaceModuleMap(plan.namespaceModules),
  );

  // ---- stub static archives per slice ----
  const work = fs.mkdtempSync(path.join(outDir, '.stub-work-'));
  fs.writeFileSync(
    path.join(work, 'stub.c'),
    '// ReactNativeHeaders is headers-only; this stub satisfies xcframework tooling.\nstatic int RNHeadersStub __attribute__((unused)) = 0;\n',
  );
  const slices = includeCatalyst
    ? [...DEFAULT_STUB_SLICES, CATALYST_STUB_SLICE]
    : DEFAULT_STUB_SLICES;
  const libs = slices.map(slice => {
    const sdkPath = execSync(`xcrun --sdk ${slice.sdk} --show-sdk-path`)
      .toString()
      .trim();
    const thins = slice.targets.map((t, i) => {
      const obj = path.join(work, `stub-${slice.name}-${i}.o`);
      execSync(
        `xcrun clang -c -target ${t} -isysroot "${sdkPath}" "${path.join(work, 'stub.c')}" -o "${obj}"`,
      );
      const lib = path.join(work, `stub-${slice.name}-${i}.a`);
      execSync(`xcrun libtool -static -o "${lib}" "${obj}" 2>/dev/null`);
      return lib;
    });
    const outLib = path.join(work, `libReactNativeHeaders-${slice.name}.a`);
    if (thins.length === 1) {
      fs.copyFileSync(thins[0], outLib);
    } else {
      execSync(
        `xcrun lipo -create ${thins.map(l => `"${l}"`).join(' ')} -output "${outLib}"`,
      );
    }
    return outLib;
  });

  // ---- compose ----
  const outXcfw = path.join(outDir, 'ReactNativeHeaders.xcframework');
  fs.rmSync(outXcfw, {recursive: true, force: true});
  execSync(
    `xcodebuild -create-xcframework ` +
      libs.map(l => `-library "${l}" -headers "${stage}"`).join(' ') +
      ` -output "${outXcfw}"`,
    {stdio: 'pipe'},
  );
  fs.rmSync(stage, {recursive: true, force: true});
  fs.rmSync(work, {recursive: true, force: true});
  console.log(
    `headers-compose: ReactNativeHeaders.xcframework (${slices.map(s => s.name).join(', ')}) -> ${outXcfw} ` +
      `(${plan.reactNativeHeaders.length} RN headers + deps ${plan.depsNamespaces.join(', ')}` +
      `${hermesFolded ? ', hermes' : ''}; ` +
      `${Object.keys(plan.namespaceModules).length} namespace modules)`,
  );
  return outXcfw;
}

/**
 * Ensures the headers-spec layout exists at `outDir`, composed from the cache
 * slot's artifacts: clones React.xcframework (APFS clonefile), strips the
 * stale signature (R7 — production signs after compose), emits the spec
 * layout into every slice, and builds ReactNativeHeaders.xcframework from
 * the plan + the slot's deps headers.
 *
 * Skips when the freshness marker matches the source artifact (same
 * realpath + Info.plist mtime) unless `force`. Any consumer with a cache slot
 * gets composed artifacts automatically — no published ReactNativeHeaders
 * required.
 */
function ensureHeadersLayout(
  artifactsDir /*: string */,
  rnRoot /*: string */,
  outDir /*: string */,
  force /*: boolean */ = false,
) /*: {reactXcfw: string, headersXcfw: string} */ {
  const sourceXcfw = fs.realpathSync(
    path.join(artifactsDir, 'React.xcframework'),
  );
  const depsHeaders = path.join(
    artifactsDir,
    'ReactNativeDependencies.xcframework',
    'Headers',
  );
  // Hermes public headers staged into the slot by download-spm-artifacts
  // (the hermes-ios tarball ships them in destroot/include, which the
  // xcframework extraction otherwise discards). null when absent — then
  // ReactNativeHeaders composes without the hermes namespace.
  const hermesHeadersDir = path.join(artifactsDir, 'hermes-headers');
  const hermesHeaders = fs.existsSync(path.join(hermesHeadersDir, 'hermes'))
    ? hermesHeadersDir
    : null;
  const reactXcfw = path.join(outDir, 'React.xcframework');
  const headersXcfw = path.join(outDir, 'ReactNativeHeaders.xcframework');
  const markerPath = path.join(outDir, '.composed-from');

  const sourceStat = fs.statSync(path.join(sourceXcfw, 'Info.plist'));
  // Fold the hermes-headers presence into the marker so a slot that gains
  // staged hermes headers (e.g. after a tooling upgrade re-downloads them)
  // recomposes instead of reusing a hermes-less ReactNativeHeaders.
  const marker = `${sourceXcfw}\n${sourceStat.mtimeMs}\n${hermesHeaders ?? 'no-hermes'}\n`;
  if (
    !force &&
    fs.existsSync(reactXcfw) &&
    fs.existsSync(headersXcfw) &&
    fs.existsSync(markerPath) &&
    fs.readFileSync(markerPath, 'utf8') === marker
  ) {
    return {reactXcfw, headersXcfw};
  }

  console.log(
    `headers-compose: composing layout from ${path.basename(artifactsDir)} slot...`,
  );
  fs.rmSync(reactXcfw, {recursive: true, force: true});
  fs.rmSync(markerPath, {force: true});
  fs.mkdirSync(outDir, {recursive: true});
  execSync(`/bin/cp -Rc "${sourceXcfw}" "${reactXcfw}"`);
  fs.rmSync(path.join(reactXcfw, '_CodeSignature'), {
    recursive: true,
    force: true,
  });

  const plan = computeSpecPlan(rnRoot);
  emitReactFrameworkHeaders(reactXcfw, plan, rnRoot);
  buildReactNativeHeadersXcframework(
    outDir,
    plan,
    depsHeaders,
    rnRoot,
    false,
    hermesHeaders,
  );
  fs.writeFileSync(markerPath, marker);
  return {reactXcfw, headersXcfw};
}

module.exports = {
  computeSpecPlan,
  emitReactFrameworkHeaders,
  buildReactNativeHeadersXcframework,
  ensureHeadersLayout,
  DEPS_NAMESPACES,
};
