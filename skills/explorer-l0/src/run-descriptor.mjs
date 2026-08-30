/**
 * Facade: shared run-descriptor contract for prepare and finalize.
 * Implementation lives in shape / io / verify modules.
 */

export {
  RUN_DESCRIPTOR_VERSION,
  RUN_PATHS,
  RunDescriptorError,
  buildRunDescriptor,
  validateRunDescriptor,
  explorerPayloadPath,
} from "./run-descriptor-shape.mjs";

export { writeRunDescriptor, loadRunDescriptor } from "./run-descriptor-io.mjs";

export {
  verifyPreparedArtifacts,
  listExplorerPayloadFiles,
} from "./run-descriptor-verify.mjs";
