import { getShopId } from '../_etsy.js';
import { writeSecurityAudit } from '../_security-audit.js';
import { requireGptScope } from './oauth-middleware.js';
import { prepareGptFiles } from './files.js';
import { claimIdempotency, completeIdempotency, failIdempotency } from './idempotency.js';
import * as Etsy from './etsy-service.js';
import * as Resources from './resource-operations.js';
import * as Workflows from './workflows.js';

const MAX_ACTION_RESPONSE_CHARS = 90_000;

function route(method, pattern, operationId, scope, consequential, run, options = {}) {
  return { method, pattern, operationId, scope, consequential, run, public: options.public === true };
}

function bodyWithoutMeta(body = {}) {
  const { confirmation, shop_id, idempotency_key, ...value } = body || {};
  return value;
}

function requestedShopId(req) {
  const requested = req.headers?.['x-shop-id'] || req.query?.shop_id || req.body?.shop_id || getShopId();
  const value = Etsy.strictPositiveId(requested, 'shop_id');
  const configured = String(process.env.ETSY_SHOP_IDS || process.env.ETSY_SHOP_ID || '')
    .split(',')
    .map(item => item.split(':')[0].trim())
    .filter(item => /^\d+$/.test(item))
    .map(Number);
  if (configured.length && !configured.includes(value)) {
    const error = new Error('shop_id is not configured for this service');
    error.status = 403;
    error.code = 'SHOP_NOT_ALLOWED';
    throw error;
  }
  return value;
}

function queryArgs(req) {
  return {
    shopId: requestedShopId(req),
    limit: req.query?.limit,
    offset: req.query?.offset,
    state: req.query?.state,
    sortOn: req.query?.sort_on,
    sortOrder: req.query?.sort_order,
    kind: req.query?.kind,
    days: req.query?.days,
    keywords: req.query?.keyword ?? req.query?.keywords,
    minCreated: req.query?.min_created,
    maxCreated: req.query?.max_created,
    wasPaid: req.query?.was_paid === undefined ? undefined : req.query.was_paid === 'true',
    wasShipped: req.query?.was_shipped === undefined ? undefined : req.query.was_shipped === 'true',
  };
}

async function requireDraft(listingId) {
  const listing = await Etsy.getListing({ listingId });
  if (listing?.state !== 'draft') {
    const error = new Error('This operation is limited to draft listings');
    error.status = 409;
    error.code = 'LISTING_NOT_DRAFT';
    throw error;
  }
  return listing;
}

function hasFileInput(body = {}) {
  return Boolean(
    (Array.isArray(body.openaiFileIdRefs) && body.openaiFileIdRefs.length)
    || body.source_url
    || (Array.isArray(body.source_urls) && body.source_urls.length)
  );
}

function fileInputCount(body = {}) {
  if (Array.isArray(body.openaiFileIdRefs)) return body.openaiFileIdRefs.length;
  if (Array.isArray(body.source_urls)) return body.source_urls.length;
  return body.source_url ? 1 : 0;
}

const FILE_INPUT_BODY_FIELD_ALLOWLIST = Object.freeze([
  'openaiFileIdRefs',
  'source_url',
  'source_urls',
  'file_metadata',
  'rank',
  'alt_text',
  'idempotency_key',
  'shop_id',
]);

function hasOwn(value, name) {
  return Boolean(value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, name));
}

function safeReferenceEntryShape(entry) {
  const entryType = entry === null
    ? 'null'
    : typeof entry === 'string'
      ? 'string'
      : entry && typeof entry === 'object' && !Array.isArray(entry)
        ? 'object'
        : 'other';
  const objectEntry = entryType === 'object' ? entry : null;
  return {
    entry_type: entryType,
    has_name: hasOwn(objectEntry, 'name'),
    has_id: hasOwn(objectEntry, 'id'),
    has_mime_type: hasOwn(objectEntry, 'mime_type'),
    has_download_link: hasOwn(objectEntry, 'download_link'),
  };
}

export function summarizeGptFileInput(body) {
  const objectBody = body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  const hasRefs = hasOwn(objectBody, 'openaiFileIdRefs');
  const refs = hasRefs && Array.isArray(objectBody.openaiFileIdRefs) ? objectBody.openaiFileIdRefs : [];
  return {
    request_body_present: body !== undefined && body !== null,
    recognized_body_fields: objectBody
      ? FILE_INPUT_BODY_FIELD_ALLOWLIST.filter(name => hasOwn(objectBody, name))
      : [],
    has_openaiFileIdRefs: hasRefs,
    openaiFileIdRefs_is_array: hasRefs && Array.isArray(objectBody.openaiFileIdRefs),
    reference_count: refs.length,
    reference_entries: refs.map(safeReferenceEntryShape),
    has_source_url: hasOwn(objectBody, 'source_url'),
    has_source_urls: hasOwn(objectBody, 'source_urls'),
    file_metadata_count: Array.isArray(objectBody?.file_metadata) ? objectBody.file_metadata.length : 0,
  };
}

function fileInputError(message, code, diagnostic) {
  const error = Object.assign(new Error(message), { status: 400, code });
  if (diagnostic) error.fileDiagnostic = diagnostic;
  return error;
}

function validateListingImageFileInput(body) {
  const summary = summarizeGptFileInput(body);
  if (summary.has_openaiFileIdRefs) {
    if (!summary.openaiFileIdRefs_is_array) {
      throw fileInputError('openaiFileIdRefs must be an array', 'GPT_FILE_REFS_MALFORMED', {
        source_field: 'openaiFileIdRefs', scheme: 'missing', hostname: '', file_index: null,
      });
    }
    if (summary.reference_count === 0) {
      throw fileInputError('openaiFileIdRefs must contain at least one file', 'GPT_FILE_REFS_EMPTY', {
        source_field: 'openaiFileIdRefs', scheme: 'missing', hostname: '', file_index: null,
      });
    }
    const malformedIndex = body.openaiFileIdRefs.findIndex(entry => (
      !entry || typeof entry !== 'object' || Array.isArray(entry)
      || typeof entry.download_link !== 'string' || !entry.download_link.trim()
    ));
    if (malformedIndex >= 0) {
      throw fileInputError('openaiFileIdRefs contains a malformed runtime file reference', 'GPT_FILE_REFS_MALFORMED', {
        source_field: 'openaiFileIdRefs', scheme: 'missing', hostname: '', file_index: malformedIndex,
      });
    }
    return summary;
  }
  const hasFallback = Boolean(body?.source_url)
    || (Array.isArray(body?.source_urls) && body.source_urls.length > 0);
  if (!hasFallback) throw fileInputError('No ChatGPT image file input was provided', 'GPT_FILE_INPUT_MISSING');
  return summary;
}

function auditListingImageInput(req, event, listingId, inputSummary, preparedFilesValue) {
  audit(req, event, { operationId: 'uploadListingImages' }, {
    listing_id: listingId,
    resource_id: listingId,
    ...inputSummary,
    prepared_file_count: Array.isArray(preparedFilesValue) ? preparedFilesValue.length : null,
    prepared_kinds: Array.isArray(preparedFilesValue) ? preparedFilesValue.map(file => String(file?.kind || 'unknown')) : [],
  });
}

function auditAcceptedImageMimeWarnings(req, listingId, files) {
  for (const file of files) {
    const warning = file?.mimeWarning;
    if (!warning) continue;
    audit(req, 'gpt.file.mime_mismatch_accepted', { operationId: 'uploadListingImages' }, {
      listing_id: listingId,
      resource_id: listingId,
      outcome: 'warning',
      status: 200,
      warning_code: warning.warning_code,
      file_source_field: warning.source_field,
      file_index: warning.file_index,
      declared_mime: warning.declared_mime,
      response_mime: warning.response_mime,
      detected_mime: warning.detected_mime,
    });
  }
}

export async function prepareListingImageFiles(req, listingId, {
  requireDraftImpl = requireDraft,
  prepareImpl = preparedFiles,
} = {}) {
  const summary = summarizeGptFileInput(req?.body);
  auditListingImageInput(req, 'gpt.file_input.received', listingId, summary, null);
  validateListingImageFileInput(req?.body);
  await requireDraftImpl(listingId);
  const files = await prepareImpl(req?.body, 'listing_image');
  auditAcceptedImageMimeWarnings(req, listingId, files);
  auditListingImageInput(req, 'gpt.file_input.prepared', listingId, summary, files);
  if (!files.length) throw Object.assign(new Error('At least one prepared image is required'), { status: 415, code: 'IMAGE_REQUIRED' });
  if (files.some(file => file.kind !== 'image')) {
    throw Object.assign(new Error('A prepared file is not an image'), { status: 415, code: 'GPT_FILE_NOT_IMAGE' });
  }
  return files;
}

export async function preparedFiles(body = {}, target = '', {
  allowMetadataTargets = false,
  prepareImpl = prepareGptFiles,
} = {}) {
  if (!hasFileInput(body)) return [];
  const metadata = Array.isArray(body.file_metadata) ? body.file_metadata : [];
  if (!allowMetadataTargets && target) {
    const mismatchIndex = metadata.findIndex(item => item?.target && item.target !== target);
    if (mismatchIndex >= 0) {
      throw Object.assign(new Error(`file_metadata[${mismatchIndex}].target must be ${target} for this endpoint`), {
        status: 400,
        code: 'INVALID_FILE_METADATA',
      });
    }
  }
  const files = await prepareImpl(body, {
    purpose: target,
    purposes: allowMetadataTargets ? metadata.map(item => item?.target || target) : [],
  });
  if (metadata.length > files.length) {
    throw Object.assign(new Error('file_metadata cannot contain more entries than the supplied files'), {
      status: 400,
      code: 'FILE_METADATA_MISMATCH',
    });
  }
  const prepared = files.map((file, index) => {
    const meta = metadata[index] || {};
    if (meta.rank !== undefined && (!Number.isInteger(Number(meta.rank)) || Number(meta.rank) < 1 || Number(meta.rank) > 20)) {
      throw Object.assign(new Error(`file_metadata[${index}].rank must be an integer from 1 to 20`), { status: 400, code: 'INVALID_FILE_METADATA' });
    }
    if (meta.alt_text !== undefined && String(meta.alt_text).length > 250) {
      throw Object.assign(new Error(`file_metadata[${index}].alt_text must be at most 250 characters`), { status: 400, code: 'INVALID_FILE_METADATA' });
    }
    return {
      ...file,
      ...(meta.name ? { name: String(meta.name) } : {}),
      ...(meta.rank !== undefined ? { rank: meta.rank } : {}),
      ...(meta.alt_text !== undefined ? { altText: meta.alt_text } : {}),
      ...((allowMetadataTargets ? meta.target || target : target) ? {
        target: allowMetadataTargets ? meta.target || target : target,
      } : {}),
      ...(body.rank !== undefined && meta.rank === undefined ? { rank: body.rank } : {}),
      ...(body.alt_text !== undefined && meta.alt_text === undefined ? { altText: body.alt_text } : {}),
    };
  });
  const ranksByTarget = new Map();
  for (const file of prepared.filter(candidate => candidate.rank !== undefined && candidate.target !== 'listing_video')) {
    const ranks = ranksByTarget.get(file.target || '') || [];
    ranks.push(Number(file.rank));
    ranksByTarget.set(file.target || '', ranks);
  }
  if ([...ranksByTarget.values()].some(ranks => new Set(ranks).size !== ranks.length)) {
    throw Object.assign(new Error('File ranks must be unique within each upload target'), { status: 400, code: 'INVALID_FILE_METADATA' });
  }
  return prepared;
}

function completeDraftFileError(message, code = 'INVALID_COMPLETE_DRAFT_FILES') {
  return Object.assign(new Error(message), { status: 400, code });
}

export async function prepareCompleteDraftAttachments(body = {}, prepareImpl = preparedFiles) {
  const legacyInputs = ['images', 'video', 'digital_files'];
  const hasLegacyInput = legacyInputs.some(name => hasFileInput(body?.[name] || {}));
  const hasTopLevelInput = hasFileInput(body);
  const metadata = Array.isArray(body.file_metadata) ? body.file_metadata : [];

  if (hasTopLevelInput && hasLegacyInput) {
    throw completeDraftFileError('Use top-level file inputs or legacy nested file inputs, not both');
  }
  if (!hasTopLevelInput && metadata.length) {
    throw completeDraftFileError('file_metadata requires a top-level file input');
  }
  if (hasTopLevelInput) {
    const count = fileInputCount(body);
    if (metadata.length !== count) {
      throw completeDraftFileError('Complete draft file_metadata must contain exactly one entry per top-level file');
    }
    const targets = metadata.map((item, index) => {
      const target = String(item?.target || '');
      if (!['listing_image', 'listing_video', 'digital_file'].includes(target)) {
        throw completeDraftFileError(`file_metadata[${index}].target is required for complete draft files`);
      }
      return target;
    });
    if (targets.filter(target => target === 'listing_video').length > 1) {
      throw completeDraftFileError('Complete drafts support at most one video', 'WORKFLOW_LIMIT_EXCEEDED');
    }
    if (targets.filter(target => target === 'digital_file').length > 5) {
      throw completeDraftFileError('Complete drafts support at most five digital files', 'WORKFLOW_LIMIT_EXCEEDED');
    }
    const files = await prepareImpl(body, '', { allowMetadataTargets: true });
    files.forEach((file, index) => {
      if (targets[index] === 'listing_image' && file.kind !== 'image') {
        throw completeDraftFileError(`File ${index + 1} targeted as listing_image is not an image`);
      }
      if (targets[index] === 'listing_video' && file.kind !== 'video') {
        throw completeDraftFileError(`File ${index + 1} targeted as listing_video is not a video`);
      }
    });
    return files;
  }

  if (fileInputCount(body?.video) > 1) {
    throw completeDraftFileError('Complete drafts support at most one video', 'WORKFLOW_LIMIT_EXCEEDED');
  }
  if (fileInputCount(body?.digital_files) > 5) {
    throw completeDraftFileError('Complete drafts support at most five digital files', 'WORKFLOW_LIMIT_EXCEEDED');
  }
  return [
    ...await prepareImpl(body?.images || {}, 'listing_image'),
    ...await prepareImpl(body?.video || {}, 'listing_video'),
    ...await prepareImpl(body?.digital_files || {}, 'digital_file'),
  ];
}

const ROUTES = [
  route('GET', /^\/status$/, 'getGptIntegrationStatus', '', false, async () => ({
    ok: true,
    service: 'etsy-manager-pro',
    integration: 'gpt-actions',
    configured: Boolean(process.env.GPT_OAUTH_CLIENT_ID && process.env.GPT_OAUTH_CLIENT_SECRET && process.env.GPT_OAUTH_REDIRECT_URIS),
    etsy_configured: Boolean(process.env.ETSY_API_KEY && (process.env.ETSY_SHOP_ID || process.env.ETSY_SHOP_IDS)),
    oauth: 'authorization_code',
  }), { public: true }),
  route('POST', /^\/resources\/read$/, 'readEtsyResource', 'gpt:read', false, req => Resources.readEtsyResource({ body: req.body, shopId: requestedShopId(req) })),
  route('POST', /^\/resources\/shop\/manage$/, 'manageShopResource', 'shop:write', true, req => Resources.manageShopResource({ body: req.body, shopId: requestedShopId(req) })),
  route('POST', /^\/resources\/listing\/manage$/, 'manageAdvancedListingResource', 'listings:write', false, req => Resources.manageAdvancedListingResource({ body: req.body, shopId: requestedShopId(req), ensureDraft: requireDraft })),
  route('POST', /^\/resources\/listing\/delete$/, 'deleteAdvancedListingResource', 'listings:delete', true, req => Resources.deleteAdvancedListingResource({ body: req.body, shopId: requestedShopId(req), ensureDraft: requireDraft })),
  route('POST', /^\/resources\/media\/manage$/, 'manageListingMedia', 'files:write', true, req => Resources.manageListingMedia({ body: req.body, shopId: requestedShopId(req), ensureDraft: requireDraft })),
  route('POST', /^\/resources\/media\/delete$/, 'deleteListingMediaResource', 'listings:delete', true, req => Resources.deleteListingMediaResource({ body: req.body, shopId: requestedShopId(req), ensureDraft: requireDraft })),
  route('POST', /^\/resources\/financial\/read$/, 'readFinancialResource', 'financial:read', false, req => Resources.readFinancialResource({ body: req.body, shopId: requestedShopId(req) })),
  route('POST', /^\/resources\/discounts\/manage$/, 'manageDiscountResource', 'discounts:write', true, req => Resources.manageDiscountResource({ body: req.body, shopId: requestedShopId(req) })),
  route('GET', /^\/profile$/, 'getEtsyUserProfile', 'gpt:read', false, () => Etsy.getUserProfile()),
  route('GET', /^\/shop$/, 'getShopProfile', 'gpt:read', false, req => Etsy.getShop(queryArgs(req))),
  route('GET', /^\/shop\/sections$/, 'listShopSections', 'gpt:read', false, req => Etsy.getShopSections(queryArgs(req))),
  route('POST', /^\/shop\/sections$/, 'createShopSection', 'shop:write', false, req => Etsy.createShopSection({ shopId: requestedShopId(req), title: req.body?.title })),
  route('GET', /^\/shipping-profiles$/, 'listShippingProfiles', 'gpt:read', false, req => Etsy.getShippingProfiles(queryArgs(req))),
  route('GET', /^\/return-policies$/, 'listReturnPolicies', 'gpt:read', false, req => Etsy.getReturnPolicies(queryArgs(req))),
  route('GET', /^\/readiness-states$/, 'listReadinessStates', 'gpt:read', false, req => Etsy.getReadinessStateDefinitions(queryArgs(req))),
  route('GET', /^\/stats$/, 'getShopStats', 'financial:read', false, req => Etsy.getShopStats(queryArgs(req))),
  route('GET', /^\/listings\/search$/, 'searchListings', 'gpt:read', false, req => Etsy.searchShopListings(queryArgs(req))),
  route('GET', /^\/listings$/, 'listShopListings', 'gpt:read', false, req => Etsy.listListings(queryArgs(req))),
  route('POST', /^\/listings$/, 'createDraftListing', 'listings:write', false, req => Etsy.createDraftListing({ shopId: requestedShopId(req), listing: req.body?.listing || bodyWithoutMeta(req.body) })),
  route('GET', /^\/listings\/(\d+)$/, 'getListing', 'gpt:read', false, (_req, [listingId]) => Etsy.getListing({ listingId })),
  route('PATCH', /^\/listings\/(\d+)$/, 'updateDraftListing', 'listings:write', false, async (req, [listingId]) => {
    await requireDraft(listingId);
    return Etsy.updateListing({ shopId: requestedShopId(req), listingId, changes: req.body?.changes || bodyWithoutMeta(req.body) });
  }),
  route('POST', /^\/listings\/(\d+)\/preview$/, 'previewListingChange', 'gpt:read', false, (req, [listingId]) => Workflows.previewChange({
    listingId,
    changes: req.body?.changes || bodyWithoutMeta(req.body),
  })),
  route('POST', /^\/listings\/(\d+)\/publish$/, 'publishListing', 'listings:publish', true, (req, [listingId]) => Etsy.setListingState({ shopId: requestedShopId(req), listingId, state: 'active' })),
  route('POST', /^\/listings\/(\d+)\/deactivate$/, 'deactivateListing', 'listings:publish', true, (req, [listingId]) => Etsy.setListingState({ shopId: requestedShopId(req), listingId, state: 'inactive' })),
  route('POST', /^\/listings\/(\d+)\/delete$/, 'deleteListing', 'listings:delete', true, (_req, [listingId]) => Etsy.deleteListing({ listingId })),
  route('GET', /^\/listings\/(\d+)\/inventory$/, 'getListingInventory', 'gpt:read', false, (_req, [listingId]) => Etsy.getListingInventory({ listingId })),
  route('PUT', /^\/listings\/(\d+)\/inventory$/, 'updateDraftListingInventory', 'listings:write', false, async (req, [listingId]) => {
    await requireDraft(listingId);
    return Etsy.updateListingInventory({ listingId, inventory: req.body?.inventory || bodyWithoutMeta(req.body) });
  }),
  route('GET', /^\/listings\/(\d+)\/personalization$/, 'getListingPersonalization', 'gpt:read', false, (_req, [listingId]) => Etsy.getListingPersonalization({ listingId })),
  route('PUT', /^\/listings\/(\d+)\/personalization$/, 'updateDraftPersonalization', 'listings:write', false, async (req, [listingId]) => {
    await requireDraft(listingId);
    return Etsy.updateListingPersonalization({ shopId: requestedShopId(req), listingId, questions: req.body?.personalization_questions || req.body?.questions });
  }),
  route('POST', /^\/listings\/(\d+)\/personalization\/delete$/, 'deleteListingPersonalization', 'listings:delete', true, (req, [listingId]) => Etsy.deleteListingPersonalization({ shopId: requestedShopId(req), listingId })),
  route('GET', /^\/listings\/(\d+)\/images$/, 'listListingImages', 'gpt:read', false, (_req, [listingId]) => Etsy.getListingImages({ listingId })),
  route('POST', /^\/listings\/(\d+)\/images$/, 'uploadListingImages', 'files:write', false, async (req, [listingId]) => {
    const files = await prepareListingImageFiles(req, listingId);
    const results = [];
    for (const [index, file] of files.entries()) results.push(await Etsy.uploadPreparedListingImage({
      shopId: requestedShopId(req), listingId, buffer: file.buffer, mimeType: file.mimeType,
      rank: file.rank ?? index + 1, altText: file.altText,
    }));
    return { count: results.length, results };
  }),
  route('PATCH', /^\/listings\/(\d+)\/images\/(\d+)\/alt-text$/, 'updateListingImageAltText', 'files:write', false, async (req, [listingId, imageId]) => {
    await requireDraft(listingId);
    return Etsy.updateListingImageAltText({ shopId: requestedShopId(req), listingId, listingImageId: imageId, altText: req.body?.alt_text });
  }),
  route('POST', /^\/listings\/(\d+)\/images\/(\d+)\/delete$/, 'deleteListingImage', 'listings:delete', true, (req, [listingId, imageId]) => Etsy.deleteListingImage({ shopId: requestedShopId(req), listingId, listingImageId: imageId })),
  route('GET', /^\/listings\/(\d+)\/videos$/, 'listListingVideos', 'gpt:read', false, (_req, [listingId]) => Etsy.getListingVideos({ listingId })),
  route('POST', /^\/listings\/(\d+)\/videos$/, 'uploadListingVideo', 'files:write', false, async (req, [listingId]) => {
    await requireDraft(listingId);
    const files = await preparedFiles(req.body, 'listing_video');
    if (files.length !== 1 || files[0].kind !== 'video') throw Object.assign(new Error('Exactly one video file is required'), { status: 415, code: 'VIDEO_REQUIRED' });
    const file = files[0];
    return Etsy.uploadPreparedListingVideo({ shopId: requestedShopId(req), listingId, buffer: file.buffer, name: file.name, mimeType: file.mimeType });
  }),
  route('POST', /^\/listings\/(\d+)\/videos\/(\d+)\/delete$/, 'deleteListingVideo', 'listings:delete', true, (req, [listingId, videoId]) => Etsy.deleteListingVideo({ shopId: requestedShopId(req), listingId, videoId })),
  route('GET', /^\/listings\/(\d+)\/files$/, 'listDigitalListingFiles', 'gpt:read', false, (req, [listingId]) => Etsy.listDigitalListingFiles({ shopId: requestedShopId(req), listingId })),
  route('POST', /^\/listings\/(\d+)\/files$/, 'uploadDigitalListingFiles', 'files:write', false, async (req, [listingId]) => {
    await requireDraft(listingId);
    if (fileInputCount(req.body) > 5) throw Object.assign(new Error('Etsy digital listings support at most five files'), { status: 400, code: 'FILE_COUNT_EXCEEDED' });
    const files = await preparedFiles(req.body, 'digital_file');
    const results = [];
    for (const [index, file] of files.entries()) results.push(await Etsy.uploadPreparedDigitalListingFile({
      shopId: requestedShopId(req), listingId, buffer: file.buffer, name: file.name, mimeType: file.mimeType, rank: file.rank ?? index + 1,
    }));
    return { count: results.length, results };
  }),
  route('POST', /^\/listings\/(\d+)\/files\/(\d+)\/delete$/, 'deleteDigitalListingFile', 'listings:delete', true, (req, [listingId, fileId]) => Etsy.deleteDigitalListingFile({ shopId: requestedShopId(req), listingId, listingFileId: fileId })),
  route('POST', /^\/workflows\/complete-draft$/, 'createCompleteDraft', 'listings:write', false, async req => {
    const attachments = await prepareCompleteDraftAttachments(req.body);
    return Workflows.createCompleteDraft({
      shopId: requestedShopId(req),
      listing: req.body?.listing,
      inventory: req.body?.inventory,
      personalizationQuestions: req.body?.personalization?.personalization_questions || req.body?.personalization_questions,
      preparedFiles: attachments,
      atomic: req.body?.atomic !== false,
      verify: req.body?.verify !== false,
    });
  }),
  route('POST', /^\/workflows\/duplicate-listing$/, 'duplicateAndCustomizeListing', 'listings:write', false, req => Workflows.duplicateAndCustomizeListing({
    shopId: requestedShopId(req), sourceListingId: req.body?.source_listing_id || req.body?.listing_id, changes: req.body?.changes || {},
    inventory: req.body?.inventory, personalizationQuestions: req.body?.personalization_questions,
    copyImages: req.body?.copy_images !== false, copyVideo: req.body?.copy_video !== false,
    copyDigitalFiles: req.body?.copy_digital_files !== false, atomic: req.body?.atomic !== false, verify: req.body?.verify !== false,
  })),
  route('POST', /^\/workflows\/bulk-create-drafts$/, 'bulkCreateDrafts', 'listings:write', false, async req => {
    const rawItems = req.body?.items || req.body?.drafts?.map(listing => ({ listing })) || [];
    const items = [];
    for (const item of rawItems) {
      if (fileInputCount(item?.video) > 1 || fileInputCount(item?.digital_files) > 5) {
        throw Object.assign(new Error('Each bulk draft supports at most one video and five digital files'), { status: 400, code: 'WORKFLOW_LIMIT_EXCEEDED' });
      }
      items.push({
        listing: item?.listing,
        inventory: item?.inventory,
        personalizationQuestions: item?.personalization?.personalization_questions || item?.personalization_questions,
        preparedFiles: [
          ...await preparedFiles(item?.images || {}, 'listing_image'),
          ...await preparedFiles(item?.video || {}, 'listing_video'),
          ...await preparedFiles(item?.digital_files || {}, 'digital_file'),
        ],
      });
    }
    return Workflows.bulkCreateDrafts({
      shopId: requestedShopId(req),
      items,
      atomicPerItem: req.body?.atomic_per_item !== false,
      verify: req.body?.verify === true,
    });
  }),
  route('POST', /^\/workflows\/bulk-update-listings$/, 'bulkUpdateListings', 'listings:write', true, req => Workflows.bulkUpdateListings({
    shopId: requestedShopId(req),
    items: (req.body?.items || req.body?.updates || []).map(item => ({
      ...item,
      personalizationQuestions: item?.personalizationQuestions || item?.personalization_questions,
    })),
    dryRun: req.body?.dry_run === true,
  })),
  route('GET', /^\/receipts$/, 'listReceipts', 'financial:read', false, req => Etsy.listReceipts(queryArgs(req))),
  route('GET', /^\/receipts\/(\d+)$/, 'getReceipt', 'financial:read', false, (req, [receiptId]) => Etsy.getReceipt({ shopId: requestedShopId(req), receiptId })),
  route('GET', /^\/transactions$/, 'listTransactions', 'financial:read', false, req => Etsy.listTransactions(queryArgs(req))),
  route('POST', /^\/receipts\/(\d+)\/shipment$/, 'updateReceiptShipment', 'orders:write', true, (req, [receiptId]) => Etsy.createReceiptShipment({
    shopId: requestedShopId(req), receiptId, trackingCode: req.body?.tracking_code,
    carrierName: req.body?.carrier_name, sendBcc: req.body?.send_bcc, noteToBuyer: req.body?.note_to_buyer,
  })),
  route('GET', /^\/taxonomy$/, 'listSellerTaxonomy', 'gpt:read', false, () => Etsy.getSellerTaxonomy()),
  route('GET', /^\/taxonomy\/(\d+)\/properties$/, 'listTaxonomyProperties', 'gpt:read', false, (_req, [taxonomyId]) => Etsy.getTaxonomyProperties({ taxonomyId })),
  route('GET', /^\/reviews$/, 'listShopReviews', 'gpt:read', false, req => Etsy.listReviews(queryArgs(req))),
  route('GET', /^\/discounts$/, 'listDiscounts', 'gpt:read', false, req => Etsy.listDiscounts(queryArgs(req))),
  route('POST', /^\/discounts$/, 'createDiscount', 'discounts:write', true, req => Etsy.createDiscount({ shopId: requestedShopId(req), discount: req.body?.discount || bodyWithoutMeta(req.body) })),
  route('GET', /^\/discounts\/(\d+)$/, 'getDiscount', 'gpt:read', false, (req, [discountId]) => Etsy.getDiscount({ shopId: requestedShopId(req), discountId })),
  route('PATCH', /^\/discounts\/(\d+)$/, 'updateDiscount', 'discounts:write', true, (req, [discountId]) => Etsy.updateDiscount({ shopId: requestedShopId(req), discountId, changes: req.body?.changes || bodyWithoutMeta(req.body) })),
  route('POST', /^\/discounts\/(\d+)\/delete$/, 'deleteDiscount', 'discounts:write', true, (req, [discountId]) => Etsy.deleteDiscount({ shopId: requestedShopId(req), discountId })),
];

export const GPT_OPERATION_IDS = Object.freeze(ROUTES.map(item => item.operationId));

function operationPath(req) {
  const full = String(req.path || req.url || '').split('?')[0];
  return full.startsWith('/api/gpt') ? full.slice('/api/gpt'.length) || '/' : full;
}

function sendResult(res, operationId, data) {
  const payload = { success: true, operation_id: operationId, data };
  const json = JSON.stringify(payload);
  if (json.length > MAX_ACTION_RESPONSE_CHARS) {
    return res.status(502).json({
      error: 'response_too_large',
      error_description: 'The Etsy response is too large for GPT Actions. Request a smaller page or narrower resource.',
    });
  }
  res.type('application/json').send(json);
}

function auditIdentifier(value) {
  const text = String(value ?? '').trim();
  return /^\d+$/.test(text) ? text : undefined;
}

function operationAuditContext(req, captures, path) {
  const listingId = auditIdentifier(
    path.startsWith('/listings/') ? captures[0] : req.body?.listing_id,
  );
  const resourceId = auditIdentifier(captures[0])
    || listingId
    || auditIdentifier(req.body?.receipt_id)
    || auditIdentifier(req.body?.discount_id)
    || auditIdentifier(req.body?.section_id)
    || auditIdentifier(req.body?.shipping_profile_id)
    || auditIdentifier(req.body?.return_policy_id);
  const action = String(req.body?.action || '').trim();
  return {
    resource_id: resourceId,
    listing_id: listingId,
    resource_action: /^[a-z0-9_:-]{1,80}$/.test(action) ? action : undefined,
  };
}

function audit(req, event, routeInfo, details = {}) {
  writeSecurityAudit(req, event, {
    operation: routeInfo?.operationId,
    resource_id: details.resource_id,
    resource_action: details.resource_action,
    outcome: details.outcome,
    status: details.status,
    error_code: details.error_code,
    listing_id: details.listing_id,
    file_source_field: details.file_source_field,
    file_scheme: details.file_scheme,
    file_hostname: details.file_hostname,
    file_index: details.file_index,
    request_body_present: details.request_body_present,
    recognized_body_fields: details.recognized_body_fields,
    has_openaiFileIdRefs: details.has_openaiFileIdRefs,
    openaiFileIdRefs_is_array: details.openaiFileIdRefs_is_array,
    reference_count: details.reference_count,
    reference_entries: details.reference_entries,
    has_source_url: details.has_source_url,
    has_source_urls: details.has_source_urls,
    file_metadata_count: details.file_metadata_count,
    prepared_file_count: details.prepared_file_count,
    prepared_kinds: details.prepared_kinds,
    warning_code: details.warning_code,
    declared_mime: details.declared_mime,
    response_mime: details.response_mime,
    detected_mime: details.detected_mime,
  });
}

export default async function gptRouter(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  const path = operationPath(req);
  const routeInfo = ROUTES.find(candidate => candidate.method === req.method && candidate.pattern.test(path));
  if (!routeInfo) return res.status(404).json({ error: 'not_found', error_description: 'Unknown GPT operation' });
  const match = routeInfo.pattern.exec(path);
  const captures = match?.slice(1) || [];
  const auditContext = operationAuditContext(req, captures, path);

  let idempotencyClaim = null;
  try {
    const requiredScopes = typeof routeInfo.scope === 'function' ? routeInfo.scope(req) : routeInfo.scope;
    if (!routeInfo.public && !requireGptScope(req, res, requiredScopes)) return;
    if (routeInfo.consequential && req.body?.confirmation !== true) {
      const error = new Error('This consequential operation requires confirmation=true');
      error.status = 400;
      error.code = 'CONFIRMATION_REQUIRED';
      throw error;
    }
    idempotencyClaim = routeInfo.method === 'GET' ? null : claimIdempotency(req, routeInfo.operationId, routeInfo.consequential);
    if (idempotencyClaim?.cached) {
      audit(req, 'gpt.operation.idempotent_replay', routeInfo, { outcome: 'cached', status: 200, ...auditContext });
      return sendResult(res, routeInfo.operationId, idempotencyClaim.data);
    }
    const data = await routeInfo.run(req, captures);
    completeIdempotency(idempotencyClaim, data);
    if (!routeInfo.public) audit(req, 'gpt.operation.succeeded', routeInfo, { outcome: 'succeeded', status: 200, ...auditContext });
    return sendResult(res, routeInfo.operationId, data);
  } catch (error) {
    const status = Number(error?.status || error?.statusCode) || 500;
    failIdempotency(idempotencyClaim, error, routeInfo.consequential);
    const fileDiagnostic = error?.fileDiagnostic;
    if (!routeInfo.public) audit(req, 'gpt.operation.failed', routeInfo, {
      outcome: 'failed',
      status,
      error_code: error?.code,
      ...auditContext,
      ...(fileDiagnostic ? {
        file_source_field: fileDiagnostic.source_field,
        file_scheme: fileDiagnostic.scheme,
        file_hostname: fileDiagnostic.hostname,
        file_index: fileDiagnostic.file_index,
      } : {}),
    });
    console.error(`[gpt] ${routeInfo.operationId} failed:`, error?.message || error);
    return res.status(status).json({
      error: error?.code || (status < 500 ? 'invalid_request' : 'operation_failed'),
      error_description: status < 500 || process.env.NODE_ENV !== 'production' ? (error?.message || 'Operation failed') : 'The Etsy operation failed',
      ...(error?.workflow_result ? { workflow_result: error.workflow_result } : {}),
    });
  }
}
