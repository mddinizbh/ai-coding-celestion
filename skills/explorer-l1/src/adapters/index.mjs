/**
 * Frontier adapter registry.
 *
 * The JVM rules (Spring/Micronaut/@Value/YAML/cron) remain inline in
 * `frontier-extract.mjs` as the default path — they are the majority of the
 * estate and are deliberately not disturbed. An adapter claims a file by
 * extension and owns every assumption about that language.
 *
 * Adding a language = one file here + one line in ADAPTERS.
 */

import * as goHuma from "./go-huma.mjs";
import * as jsHttpClient from "./js-http-client.mjs";
import * as routeManifestYaml from "./route-manifest-yaml.mjs";

/** @type {{ id: string, matches: (file: string) => boolean, extract: Function, describes: () => object }[]} */
export const ADAPTERS = [goHuma, routeManifestYaml, jsHttpClient];

/** @param {string} file */
export function adapterFor(file) {
  for (const a of ADAPTERS) {
    if (a.matches(file)) return a;
  }
  return null;
}

/** @param {string} file */
export function isAdapterFile(file) {
  return adapterFor(file) !== null;
}

/** Coverage contract of every registered adapter (for `frontier report`). */
export function describeAdapters() {
  return ADAPTERS.map((a) => a.describes());
}
