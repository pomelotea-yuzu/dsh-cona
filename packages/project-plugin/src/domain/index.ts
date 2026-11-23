// 领域层统一出口。领域不依赖 Node、React、Cordis（见包 BOUNDARIES.md 与 scripts/check-boundaries.mjs）。

export * from './types.js';
export { strictParse } from './strict-json.js';
export type { StrictJson, StrictParseError, StrictParseErrorCode, StrictParseResult } from './strict-json.js';
export {
  validateProjectDocument,
  validatePlanStructure,
  TOP_LEVEL_KEYS,
} from './validate.js';
export { addNodes, splitNode, setDependencies, moveNode, instantiateTemplate } from './transforms.js';
export {
  validatePreset,
  FEATURE_DEVELOPMENT_PRESET,
  PRESET_SOURCE,
  PRESET_CONTENT_LOCALES,
} from './presets.js';
export type {
  PresetDescriptor,
  PresetContentLocale,
  PresetSource,
  PresetNodeRef,
  PresetNodeText,
  PresetContent,
  PresetDependencyRef,
} from './presets.js';
export {
  referencedBodyPaths,
  findOrphanBodies,
  classifyVerificationSource,
} from './records.js';
export type { VerificationSourceClass } from './records.js';
export {
  encodeCanonical,
  quoteCanonical,
  planProjection,
  sortProjectionWhitelists,
  computePlanVersion,
  planVersionFromJsonText,
} from './canonical/plan-fingerprint.js';
export { encodeCanonicalAlt, computePlanVersionAlt, planVersionFromJsonTextAlt } from './canonical/plan-fingerprint-alt.js';
export { utf8Encode, Utf8EncodeError } from './canonical/utf8.js';
export { validateRelativePath } from './relative-path.js';
export type { RelativePathError, RelativePathErrorCode, RelativePathResult } from './relative-path.js';
export { updateNode, setNodeStatus, appendRecordIndex, applyPlanCommand } from './commands.js';
export type { NodePatch, PlanCommand } from './commands.js';
export {
  PLAN_INVERSE_VERSION,
  INVERSE_FIELDS,
  buildPlanInverse,
  validatePlanInverse,
  checkInverseState,
  applyPlanInverse,
} from './inverse.js';
export type {
  InverseField,
  InverseFieldValue,
  InverseFieldChange,
  InverseDependencyChange,
  InverseReplacement,
  InverseDirection,
  InverseConflict,
  PlanInverse,
} from './inverse.js';
export {
  USER_TEMPLATE_SUMMARY_PREFIX,
  USER_TEMPLATE_VERSION_MARKER,
  USER_TEMPLATE_VERSION,
  USER_TEMPLATE_LIMITS,
  extractSubtreeTemplate,
  internalDependencies,
  validateUserTemplateBody,
  buildUserTemplateText,
  parseUserTemplateText,
} from './user-template.js';
export type { UserTemplateNode, UserTemplateDependency, UserTemplateBody } from './user-template.js';
