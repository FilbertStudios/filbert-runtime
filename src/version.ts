/*
 * The SDK's own identity — and the one string the platform can still find
 * inside a finished game build.
 *
 * A bundle reaches the upload scan as minified output with no package.json, so
 * there is nothing to read unless the SDK leaves a mark behind. Comments are
 * stripped by every minifier and a composed string (`'x@' + VERSION`) gets
 * folded or renamed, so the marker is a single unbroken string literal: that is
 * the one form every minifier preserves verbatim. The platform looks for
 * /filbert-runtime@(\d+\.\d+\.\d+)/ and needs no cooperation from the game's
 * build step to find it.
 *
 * All three constants below are pinned to each other and to package.json by
 * `test/version.test.js`, because the failure mode of drift is silent: the
 * scan would report a version the build does not actually carry.
 */

/** Keep in step with package.json. */
export const SDK_VERSION = '0.2.0';

/** Wire-contract version for the dev-panel handshake. Bump on breaking changes. */
export const PROTOCOL = 1;

/** Written verbatim into every build. Never compose this at runtime. */
export const SDK_MARKER = 'filbert-runtime@0.2.0';
